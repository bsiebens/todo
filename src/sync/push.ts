import type { SyncClient } from './client';

/** Web Push on this device. On iPhone and iPad it only works once the app is on the Home Screen. */
export function pushSupport(): 'ok' | 'needs_home_screen' | 'unsupported' {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  if (ios && !standalone) return 'needs_home_screen';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return 'ok';
}

const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  return (await navigator.serviceWorker.getRegistration()) ?? null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

export async function enablePush(sync: SyncClient): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked for this app. Allow them in the browser or system settings, then try again.');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await sync.api<{ publicKey: string }>('/push/key', { auth: false });
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await sync.api('/push/subscribe', { body: { subscription: sub.toJSON(), tz: timeZone() } });
}

export async function disablePush(sync: SyncClient): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await sync.api('/push/unsubscribe', { body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** Re-sends an existing subscription, so the server knows this device's current time zone. */
export async function refreshPush(sync: SyncClient): Promise<void> {
  if (!sync.signedIn || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub) await sync.api('/push/subscribe', { body: { subscription: sub.toJSON(), tz: timeZone() } }).catch(() => {});
}
