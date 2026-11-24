import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createWorkerDriver } from './db/worker-driver';
import { Store } from './db/store';
import { ActionsProvider } from './ui/actions';
import { App } from './ui/App';
import { StoreContext } from './ui/state';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);

async function start() {
  try {
    const store = await Store.open(await createWorkerDriver());
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
    root.render(
      <StrictMode>
        <StoreContext.Provider value={store}>
          <ActionsProvider>
            <App />
          </ActionsProvider>
        </StoreContext.Provider>
      </StrictMode>,
    );
  } catch (e) {
    root.render(
      <div style={{ padding: 24 }}>
        <h1>Could not start</h1>
        <p>The local database failed to open: {String(e)}</p>
      </div>,
    );
  }
}

start();
