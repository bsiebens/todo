import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AuthStatus, PushRequest } from '../src/sync/protocol';
import { Auth, AuthError, type Session } from './auth';
import type { Db } from './db';
import type { Notifier } from './notifier';
import type { SyncService } from './sync';
import { isValidTz } from './tz';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface AppDeps {
  db: Db;
  auth: Auth;
  sync: SyncService;
  notifier: Notifier;
  vapidPublicKey: string;
  appUrl: string;
  ownerEmail?: string;
  mailer?: Mailer;
  staticDir?: string;
  /** Extra origins (besides the desktop app's) that may call the API from another site. */
  corsOrigins?: string[];
}

/**
 * Where the desktop app's pages come from: tauri://localhost on macOS and Linux,
 * https://tauri.localhost on Windows. The API is authorised by a bearer token
 * (never a cookie), so letting these origins read responses exposes nothing a
 * signed-out page could use.
 */
export const DESKTOP_ORIGINS = ['tauri://localhost', 'https://tauri.localhost', 'http://tauri.localhost'];

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY = 8 * 1024 * 1024;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
};

export function createApp(deps: AppDeps): { server: Server; notifyChanged: (accountId: string, exceptDevice?: string) => void } {
  const { auth, sync, notifier, db } = deps;
  const allowed = new Set([...DESKTOP_ORIGINS, ...(deps.corsOrigins ?? [])]);
  const sockets = new Map<string, Set<{ ws: WebSocket; deviceId: string }>>();

  const notifyChanged = (accountId: string, exceptDevice?: string) => {
    for (const s of sockets.get(accountId) ?? []) if (s.deviceId !== exceptDevice && s.ws.readyState === s.ws.OPEN) s.ws.send('changed');
  };

  async function api(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname.replace(/^\/api/, '');
    const method = req.method ?? 'GET';
    const session = (): Promise<Session> => auth.authenticate(req.headers.authorization);
    const body = () => readJson(req);

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true });

    if (method === 'GET' && path === '/auth/status') {
      const status: AuthStatus = { setupDone: !!(await auth.accountId()), emailEnabled: !!(deps.mailer && deps.ownerEmail) };
      return send(res, 200, status);
    }
    if (method === 'POST' && path === '/auth/setup') {
      const b = await body();
      return send(res, 200, await auth.setup(str(b.code), str(b.deviceName)));
    }
    if (method === 'POST' && path === '/auth/code/redeem') {
      const b = await body();
      return send(res, 200, await auth.redeemCode(str(b.code), str(b.deviceName)));
    }
    if (method === 'POST' && path === '/auth/code/create') {
      const s = await session();
      return send(res, 200, await auth.createCode(s.accountId, 'pair'));
    }
    if (method === 'POST' && path === '/auth/email') {
      const b = await body();
      const email = str(b.email).trim().toLowerCase();
      const accountId = await auth.accountId();
      // Same answer whether or not the address matches, so it can't be probed.
      if (deps.mailer && deps.ownerEmail && accountId && email === deps.ownerEmail.toLowerCase()) {
        const { code } = await auth.createCode(accountId, 'email');
        const link = `${deps.appUrl.replace(/\/$/, '')}/#signin=${code}`;
        await deps.mailer.send(
          deps.ownerEmail,
          `ToDo sign-in code: ${code}`,
          `Your sign-in code is ${code}\n\nType it in the app under Settings > Sync, or open this link on the device you want to sign in:\n${link}\n\nThe code works once and expires in 15 minutes. If you did not ask for it, ignore this email.`,
        );
      }
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/auth/passkey/login/options') {
      return send(res, 200, await auth.authenticationOptions());
    }
    if (method === 'POST' && path === '/auth/passkey/login/verify') {
      const b = await body();
      return send(res, 200, await auth.authenticationVerify(str(b.flowId), b.response as never, str(b.deviceName)));
    }
    if (method === 'POST' && path === '/auth/passkey/register/options') {
      const s = await session();
      const b = await body();
      return send(res, 200, await auth.registrationOptions(s, str(b.name)));
    }
    if (method === 'POST' && path === '/auth/passkey/register/verify') {
      await session();
      const b = await body();
      await auth.registrationVerify(str(b.flowId), b.response as never, str(b.name));
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/auth/passkeys') return send(res, 200, await auth.passkeys(await session()));
    if (method === 'DELETE' && path.startsWith('/auth/passkeys/')) {
      await auth.removePasskey(await session(), decodeURIComponent(path.slice('/auth/passkeys/'.length)));
      return send(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/devices') return send(res, 200, await auth.devices(await session()));
    if (method === 'DELETE' && path.startsWith('/devices/')) {
      const s = await session();
      const id = path.slice('/devices/'.length);
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new HttpError(400, 'Bad device id');
      await auth.revokeDevice(s, id);
      for (const sock of sockets.get(s.accountId) ?? []) if (sock.deviceId === id) sock.ws.close(4001, 'signed out');
      return send(res, 200, { ok: true });
    }

    if (method === 'POST' && path === '/sync/push') {
      const s = await session();
      const b = (await body()) as unknown as PushRequest;
      if (!Array.isArray(b.ops) || b.ops.length > 5000) throw new HttpError(400, 'ops must be a list of at most 5000 changes');
      const result = await sync.push(s.accountId, s.deviceId, b.ops);
      if (result.changed) notifyChanged(s.accountId, result.rejected.some((r) => r.reason !== 'invalid') ? undefined : s.deviceId);
      const { changed: _, ...out } = result;
      return send(res, 200, out);
    }
    if (method === 'GET' && path === '/sync/pull') {
      const s = await session();
      const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
      return send(res, 200, await sync.pull(s.accountId, s.deviceId, since));
    }

    if (method === 'GET' && path === '/push/key') return send(res, 200, { publicKey: deps.vapidPublicKey });
    if (method === 'POST' && path === '/push/subscribe') {
      const s = await session();
      const b = await body();
      const sub = b.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
      const tz = str(b.tz, 64);
      if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string') {
        throw new HttpError(400, 'Bad subscription');
      }
      if (!isValidTz(tz)) throw new HttpError(400, 'Unknown time zone');
      await db.query(
        `INSERT INTO push_sub (endpoint, account_id, device_id, keys, tz) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (endpoint) DO UPDATE SET account_id = excluded.account_id, device_id = excluded.device_id, keys = excluded.keys, tz = excluded.tz, updated_at = now()`,
        [sub.endpoint, s.accountId, s.deviceId, JSON.stringify({ p256dh: sub.keys.p256dh, auth: sub.keys.auth }), tz],
      );
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/push/unsubscribe') {
      const s = await session();
      const b = await body();
      await db.query('DELETE FROM push_sub WHERE endpoint = $1 AND account_id = $2', [str(b.endpoint, 2000), s.accountId]);
      return send(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/push/test') {
      const s = await session();
      const n = await notifier.sendToAccount(s.accountId, { title: 'ToDo reminders work', body: 'You will get reminders like this one.', tag: 'test', url: '/' });
      return send(res, 200, { sent: n });
    }
    throw new HttpError(404, 'Not found');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL) {
    const root = deps.staticDir;
    if (!root || (req.method !== 'GET' && req.method !== 'HEAD')) {
      res.writeHead(404).end('Not found');
      return;
    }
    let rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = resolve(join(root, rel));
    if (!file.startsWith(resolve(root))) {
      res.writeHead(400).end();
      return;
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      rel = '/index.html';
      file = join(root, 'index.html');
    }
    const headers: Record<string, string> = { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' };
    if (rel.startsWith('/assets/')) headers['cache-control'] = 'public, max-age=31536000, immutable';
    else headers['cache-control'] = 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') res.end();
    else createReadStream(file).pipe(res);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://local');
    try {
      if (url.pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && allowed.has(origin)) {
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('vary', 'Origin');
          if (req.method === 'OPTIONS') {
            res.writeHead(204, {
              'access-control-allow-methods': 'GET, POST, DELETE',
              'access-control-allow-headers': 'authorization, content-type',
              'access-control-max-age': '86400',
            });
            return res.end();
          }
        }
        await api(req, res, url);
      }
      else serveStatic(req, res, url);
    } catch (e) {
      if (e instanceof HttpError || e instanceof AuthError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Server error' });
    }
  });

  // Live nudges: when one device pushes, the others pull within a second.
  // The token travels as a WebSocket subprotocol ("todo", <token>) so it stays out of URLs and proxy logs.
  const wss = new WebSocketServer({ noServer: true, handleProtocols: (protocols) => (protocols.has('todo') ? 'todo' : false) });
  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname !== '/api/ws') return socket.destroy();
    let s: Session;
    try {
      const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim());
      s = await auth.authenticate(`Bearer ${protocols.find((p) => p !== 'todo') ?? ''}`);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!sockets.has(s.accountId)) sockets.set(s.accountId, new Set());
      const entry = { ws, deviceId: s.deviceId };
      sockets.get(s.accountId)!.add(entry);
      const ping = setInterval(() => ws.readyState === ws.OPEN && ws.ping(), 30_000);
      ws.on('close', () => {
        clearInterval(ping);
        sockets.get(s.accountId)?.delete(entry);
      });
      ws.on('error', () => ws.close());
    });
  });

  return { server, notifyChanged };
}
