import { useState, type ReactNode } from 'react';
import { isDesktop } from '../platform/desktop';
import { useSyncStatus } from './state';
import { SignIn } from './SyncSettings';

/** Reads a sign-in link from the email (#signin=CODE) once, and removes it from the address bar. */
export function readLinkCode(): string | null {
  const m = /^#signin=([A-Za-z0-9-]+)$/.exec(location.hash);
  if (m) history.replaceState(null, '', location.pathname + location.search);
  return m?.[1] ?? null;
}

/**
 * Nothing of the app shows until this device is signed in to the sync server:
 * a passkey, a one-time code or the setup code in the browser, a code in the desktop
 * app. A device that is signed in keeps working offline. Signing out, or the server
 * revoking the device, brings this screen back.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const status = useSyncStatus();
  const [linkCode] = useState(readLinkCode);
  if (status.state !== 'signed_out') return <>{children}</>;
  return (
    <main className="gate">
      <div className="gate-box">
        <div className="gate-brand">
          <img src="/icon.svg" alt="" width={36} height={36} />
          <h1>ToDo</h1>
        </div>
        <p className="gate-lead">{isDesktop ? 'Connect this computer to your ToDo server to start.' : 'Sign in to open your tasks.'}</p>
        <SignIn initialCode={linkCode} />
      </div>
    </main>
  );
}
