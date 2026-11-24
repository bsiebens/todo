import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { createApp, type Mailer } from './app';
import { Auth, newCode } from './auth';
import { getKv, migrate, pgDb, setKv, type Db } from './db';
import { Notifier, webPushSender } from './notifier';
import { SyncService } from './sync';

const env = (k: string) => process.env[k]?.trim() || undefined;

/** Starts the server on a database. Used by the production entry below and by `npm run dev:server`. */
export async function run(db: Db, appUrl: string): Promise<void> {
  await migrate(db);

  let setupCode = env('SETUP_CODE') ?? (await getKv<string>(db, 'setup_code'));
  if (!setupCode) {
    setupCode = newCode();
    await setKv(db, 'setup_code', setupCode);
  }
  const auth = new Auth(db, { appUrl, setupCode });

  // `node server.js signin-code` prints a one-time code to sign in a device, for when no
  // signed-in device or passkey is at hand. Only someone with shell access can run it.
  if (process.argv[2] === 'signin-code') {
    const accountId = await auth.ensureAccount();
    const { code, expiresAt } = await auth.createCode(accountId, 'admin');
    console.log(`One-time sign-in code: ${code} (valid until ${expiresAt})`);
    await db.close();
    return;
  }

  const ownerEmail = env('OWNER_EMAIL');
  const smtpUrl = env('SMTP_URL');
  let mailer: Mailer | undefined;
  if (smtpUrl && ownerEmail) {
    const transport = nodemailer.createTransport(smtpUrl);
    const from = env('MAIL_FROM') ?? ownerEmail;
    mailer = { send: async (to, subject, text) => void (await transport.sendMail({ from, to, subject, text })) };
  }

  const { sender, publicKey } = await webPushSender(db, ownerEmail ? `mailto:${ownerEmail}` : appUrl);
  const sync = new SyncService(db);
  const notifier = new Notifier(db, sender);
  const { server } = createApp({
    db,
    auth,
    sync,
    notifier,
    vapidPublicKey: publicKey,
    appUrl,
    ownerEmail,
    mailer,
    staticDir: resolve(env('STATIC_DIR') ?? 'dist'),
    corsOrigins: env('CORS_ORIGINS')?.split(',').map((o) => o.trim()).filter(Boolean),
  });

  const port = Number(env('PORT') ?? 8080);
  server.listen(port, () => {
    console.log(`ToDo server listening on :${port} for ${appUrl}`);
  });
  if (!(await auth.accountId())) {
    console.log(`Not set up yet. Open ${appUrl}, go to Settings > Sync and enter the setup code: ${setupCode}`);
  }

  const every = (ms: number, fn: () => Promise<unknown>) => setInterval(() => fn().catch((e) => console.error(e)), ms);
  every(60_000, () => notifier.tick());
  every(24 * 3600_000, async () => {
    const n = await sync.compact();
    await db.query("DELETE FROM reminder_sent WHERE sent_at < now() - interval '30 days'");
    if (n) console.log(`Compacted ${n} replaced changes`);
  });

  const stop = () => {
    server.close();
    db.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (!process.env.TODO_DEV) {
  const databaseUrl = env('DATABASE_URL');
  const appUrl = env('APP_URL');
  if (!databaseUrl || !appUrl) {
    console.error('DATABASE_URL and APP_URL must be set. See deploy/README.md.');
    process.exit(1);
  }
  run(pgDb(databaseUrl), appUrl).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
