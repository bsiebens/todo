import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkerDriver } from './db/worker-driver';
import { Store } from './db/store';
import { ActionsProvider } from './ui/actions';
import { App } from './ui/App';
import { StoreContext, SyncContext } from './ui/state';
import { SyncClient } from './sync/client';
import { refreshPush } from './sync/push';
import './ui/styles.css';
import { initTheme } from './ui/theme';

initTheme();

const root = createRoot(document.getElementById('root')!);

async function start() {
  try {
    const store = await Store.open(await createWorkerDriver());
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    const sync = await SyncClient.create(store);
    // Only one tab may own the database; a second tab (memory storage) does not sync.
    if (store.storage === 'OPFS') {
      sync.start();
      refreshPush(sync);
    }
    root.render(
      <StrictMode>
        <StoreContext.Provider value={store}>
          <SyncContext.Provider value={sync}>
            <ActionsProvider>
              <App />
            </ActionsProvider>
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
