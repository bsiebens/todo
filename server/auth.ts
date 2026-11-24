import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Db } from './db';

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface Session {
  accountId: string;
  deviceId: string;
}

export interface AuthConfig {
  appUrl: string; // https://todo.example.com
  setupCode: string;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 8 characters shown as XXXX-XXXX, about 40 bits. */
export function newCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}
const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

interface Flow {
  challenge: string;
  accountId?: string;
  expires: number;
}

/**
 * Sign-in for a single-person server. The first device signs in with the setup code
 * (from the server log or SETUP_CODE). After that: a passkey, a one-time code shown on
 * a signed-in device, or a one-time code by email. Each device gets its own long-lived
 * token, which can be revoked.
 */
export class Auth {
  private flows = new Map<string, Flow>();
  private failures: number[] = [];
  private seen = new Map<string, number>();

  constructor(
    private db: Db,
    private cfg: AuthConfig,
  ) {}

  get rpID() {
    return new URL(this.cfg.appUrl).hostname;
  }
  get origin() {
    return new URL(this.cfg.appUrl).origin;
  }

  async accountId(): Promise<string | null> {
    const rows = await this.db.query<{ id: string }>('SELECT id FROM account ORDER BY created_at LIMIT 1');
    return rows[0]?.id ?? null;
  }

  async ensureAccount(): Promise<string> {
    return (await this.accountId()) ?? (await this.db.query<{ id: string }>('INSERT INTO account (id) VALUES ($1) RETURNING id', [randomUUID()]))[0]!.id;
  }

  async authenticate(header: string | undefined): Promise<Session> {
    const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new AuthError(401, 'Not signed in');
    const rows = await this.db.query<{ id: string; account_id: string; last_seen_at: Date | null }>(
      'SELECT id, account_id, last_seen_at FROM device WHERE token_hash = $1 AND revoked_at IS NULL',
      [sha256(token)],
    );
    const d = rows[0];
    if (!d) throw new AuthError(401, 'This device was signed out');
    const last = this.seen.get(d.id) ?? d.last_seen_at?.getTime() ?? 0;
    if (Date.now() - last > 5 * 60_000) {
      this.seen.set(d.id, Date.now());
      await this.db.query('UPDATE device SET last_seen_at = now() WHERE id = $1', [d.id]);
    }
    return { accountId: d.account_id, deviceId: d.id };
  }

  private async issueToken(accountId: string, deviceName: string): Promise<{ token: string; deviceId: string }> {
    const token = randomBytes(32).toString('base64url');
    const deviceId = randomUUID();
    await this.db.query('INSERT INTO device (id, account_id, name, token_hash) VALUES ($1,$2,$3,$4)', [deviceId, accountId, cleanName(deviceName), sha256(token)]);
    return { token, deviceId };
  }

  private throttle() {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 15 * 60_000);
    if (this.failures.length >= 10) throw new AuthError(429, 'Too many wrong codes. Try again in 15 minutes.');
  }

  private fail(message: string): never {
    this.failures.push(Date.now());
    throw new AuthError(400, message);
  }

  // ---------- Setup and one-time codes ----------

  async setup(code: string, deviceName: string) {
    this.throttle();
    if (await this.accountId()) throw new AuthError(409, 'This server is already set up. Sign in instead.');
    if (normCode(code) !== normCode(this.cfg.setupCode)) this.fail('That setup code is not right. It is in the server log.');
    const accountId = await this.ensureAccount();
    return this.issueToken(accountId, deviceName);
  }

  /** A one-time code for signing in another device. Valid for 10 minutes (email: 15). */
  async createCode(accountId: string, kind: 'pair' | 'email' | 'admin'): Promise<{ code: string; expiresAt: string }> {
    const code = newCode();
    const minutes = kind === 'email' ? 15 : kind === 'admin' ? 60 : 10;
    const expiresAt = new Date(Date.now() + minutes * 60_000);
    await this.db.query('DELETE FROM one_time_code WHERE expires_at < now()');
    await this.db.query('INSERT INTO one_time_code (code_hash, account_id, kind, expires_at) VALUES ($1,$2,$3,$4)', [sha256(normCode(code)), accountId, kind, expiresAt]);
    return { code, expiresAt: expiresAt.toISOString() };
  }

  async redeemCode(code: string, deviceName: string) {
    this.throttle();
    const rows = await this.db.query<{ account_id: string }>(
      'UPDATE one_time_code SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING account_id',
      [sha256(normCode(code))],
    );
    if (!rows[0]) this.fail('That code is wrong or has expired.');
    return this.issueToken(rows[0].account_id, deviceName);
  }

  // ---------- Passkeys ----------

  private newFlow(challenge: string, accountId?: string): string {
    const now = Date.now();
    for (const [k, f] of this.flows) if (f.expires < now) this.flows.delete(k);
    const id = randomUUID();
    this.flows.set(id, { challenge, accountId, expires: now + 5 * 60_000 });
    return id;
  }

  private takeFlow(id: string): Flow {
    const f = this.flows.get(id);
    this.flows.delete(id);
    if (!f || f.expires < Date.now()) throw new AuthError(400, 'The sign-in took too long. Please try again.');
    return f;
  }

  /** Adds a passkey for a signed-in device. */
  async registrationOptions(session: Session, passkeyName: string) {
    const existing = await this.db.query<{ id: string; transports: string[] }>('SELECT id, transports FROM passkey WHERE account_id = $1', [session.accountId]);
    const options = await generateRegistrationOptions({
      rpName: 'ToDo',
      rpID: this.rpID,
      userName: 'ToDo',
      userDisplayName: passkeyName || 'ToDo',
      userID: new TextEncoder().encode(session.accountId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    return { flowId: this.newFlow(options.challenge, session.accountId), options };
  }

  async registrationVerify(flowId: string, response: RegistrationResponseJSON, passkeyName: string) {
    const flow = this.takeFlow(flowId);
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      requireUserVerification: false,
    });
    if (!result.verified) throw new AuthError(400, 'The passkey could not be verified.');
    const c = result.registrationInfo.credential;
    await this.db.query('INSERT INTO passkey (id, account_id, public_key, counter, transports, name) VALUES ($1,$2,$3,$4,$5,$6)', [
      c.id,
      flow.accountId,
      Buffer.from(c.publicKey),
      c.counter,
      c.transports ?? [],
      cleanName(passkeyName),
    ]);
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'preferred' });
    return { flowId: this.newFlow(options.challenge), options };
  }

  async authenticationVerify(flowId: string, response: AuthenticationResponseJSON, deviceName: string) {
    const flow = this.takeFlow(flowId);
    const rows = await this.db.query<{ id: string; account_id: string; public_key: Buffer; counter: string; transports: string[] }>(
      'SELECT id, account_id, public_key, counter, transports FROM passkey WHERE id = $1',
      [response.id],
    );
    const pk = rows[0];
    if (!pk) throw new AuthError(400, 'This passkey is not known to this server. It may have been removed.');
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: flow.challenge,
      expectedOrigin: this.origin,
      expectedRPID: this.rpID,
      credential: { id: pk.id, publicKey: new Uint8Array(pk.public_key), counter: Number(pk.counter), transports: pk.transports as never },
      requireUserVerification: false,
    });
    if (!result.verified) throw new AuthError(400, 'The passkey could not be verified.');
    await this.db.query('UPDATE passkey SET counter = $2, last_used_at = now() WHERE id = $1', [pk.id, result.authenticationInfo.newCounter]);
    return this.issueToken(pk.account_id, deviceName);
  }

  // ---------- Devices and passkeys list ----------

  async devices(session: Session) {
    const rows = await this.db.query<{ id: string; name: string; created_at: Date; last_seen_at: Date | null }>(
      'SELECT id, name, created_at, last_seen_at FROM device WHERE account_id = $1 AND revoked_at IS NULL ORDER BY created_at',
      [session.accountId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString(), lastSeenAt: r.last_seen_at?.toISOString() ?? null, current: r.id === session.deviceId }));
  }

  async revokeDevice(session: Session, deviceId: string) {
    await this.db.query('UPDATE device SET revoked_at = now() WHERE id = $1 AND account_id = $2', [deviceId, session.accountId]);
    await this.db.query('DELETE FROM push_sub WHERE device_id = $1', [deviceId]);
  }

  async passkeys(session: Session) {
    const rows = await this.db.query<{ id: string; name: string; created_at: Date; last_used_at: Date | null }>(
      'SELECT id, name, created_at, last_used_at FROM passkey WHERE account_id = $1 ORDER BY created_at',
      [session.accountId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.created_at.toISOString(), lastUsedAt: r.last_used_at?.toISOString() ?? null }));
  }

  async removePasskey(session: Session, id: string) {
    await this.db.query('DELETE FROM passkey WHERE id = $1 AND account_id = $2', [id, session.accountId]);
  }
}

function cleanName(s: string): string {
  return (s || 'Device').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 80) || 'Device';
}
