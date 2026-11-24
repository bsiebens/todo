import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkerDriver } from './db/worker-driver';
import { Store } from './db/store';
import { ActionsProvider } from './ui/actions';
import { App } from './ui/App';
import { SignInGate } from './ui/Gate';
import { QuickEntry } from './ui/QuickEntry';
import { StoreContext, SyncContext } from './ui/state';
import { SyncClient } from './sync/client';
import { refreshPush } from './sync/push';
import { isDesktop, startDesktop } from './platform/desktop';
import { createDesktopDriver } from './platform/desktop-driver';
import './ui/styles.css';
import { initTheme } from './ui/theme';

initTheme();

const root = createRoot(document.getElementById('root')!);

async function start() {
  // The desktop app's quick-entry window (Ctrl+Alt+N) is the same page with #quick.
  // It does not open the database: the main window saves for it.
  if (isDesktop && location.hash === '#quick') {
    const os = /Mac/.test(navigator.userAgent) ? 'mac' : /Windows/.test(navigator.userAgent) ? 'win' : 'linux';
    document.documentElement.classList.add('quick-window', `qw-${os}`);
    root.render(
      <StrictMode>
        <QuickEntry />
      </StrictMode>,
    );
    return;
  }
  try {
    const store = await Store.open(await (isDesktop ? createDesktopDriver() : createWorkerDriver()));
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    // The desktop app is not served by the sync server, so it keeps the server's address.
    const sync = await SyncClient.create(store, { baseUrl: isDesktop ? ((await store.getSyncState('server_url')) ?? '') : '' });
    // Only one tab may own the database; a second tab (memory storage) does not sync.
    if (store.persistent) {
      sync.start();
      if (isDesktop) startDesktop(store, () => sync.signedIn).catch((e) => console.warn('desktop features failed to start', e));
      else refreshPush(sync);
    }
    root.render(
      <StrictMode>
        <StoreContext.Provider value={store}>
          <SyncContext.Provider value={sync}>
            <SignInGate>
              <ActionsProvider>
                <App />
              </ActionsProvider>
            </SignInGate>
          </SyncContext.Provider>
        </StoreContext.Provider>
      </StrictMode>,
    );
  } catch (e) {
    root.render(
      <div className="fatal">
        <h1>Could not start</h1>
        <p>The local database failed to open: {String(e)}</p>
      </div>,
    );
  }
}

start();
