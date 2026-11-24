import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Id, Status, Task } from '../domain/types';
import { quickAddTask } from '../db/quick-add';
import { StoreError } from '../db/store';
import { useStore } from './state';

interface Actions {
  changeStatus: (id: Id, to: Status) => Promise<void>;
  quickAdd: (text: string, defaults?: { projectId?: Id | null }) => Promise<Id | null>;
  notify: (msg: string) => void;
}

const ActionsContext = createContext<Actions | null>(null);
export const useActions = () => useContext(ActionsContext)!;

export function ActionsProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const [override, setOverride] = useState<{ task: Task; to: Status; blockers: Task[] } | null>(null);
  const [reason, setReason] = useState('');
  const [toast, setToast] = useState<string | null>(null);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast((t) => (t === msg ? null : t)), 4000);
  }, []);

  const changeStatus = useCallback(
    async (id: Id, to: Status) => {
      try {
        const { nextId } = await store.setStatus(id, to);
        if (nextId) notify(`Next one due ${store.task(nextId).dueDate}`);
      } catch (e) {
        if (e instanceof StoreError && e.code === 'blocked') {
          setReason('');
          setOverride({ task: store.task(id), to, blockers: e.detail as Task[] });
        } else notify(e instanceof Error ? e.message : String(e));
      }
    },
    [store, notify],
  );

  const quickAdd = useCallback((text: string, defaults?: { projectId?: Id | null }) => quickAddTask(store, text, defaults), [store]);

  const confirmOverride = async () => {
    if (!override || !reason.trim()) return;
    try {
      await store.setStatus(override.task.id, override.to, reason);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
    }
    setOverride(null);
  };

  return (
    <ActionsContext.Provider value={{ changeStatus, quickAdd, notify }}>
      {children}
      {override && (
        <div className="modal-bg" onClick={() => setOverride(null)}>
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="ov-title" onClick={(e) => e.stopPropagation()}>
            <h2 id="ov-title">"{override.task.title}" is blocked</h2>
            <p className="muted small">Still waiting on: {override.blockers.map((b) => b.title).join(', ')}.</p>
            <p className="small">To {override.to === 'done' ? 'complete' : 'start'} it anyway, give a reason. It is saved as a note on the task.</p>
            <textarea autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for the override" onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) confirmOverride(); }} />
            <div className="actions end">
              <button className="btn" onClick={() => setOverride(null)}>Cancel</button>
              <button className="btn primary" disabled={!reason.trim()} onClick={confirmOverride}>
                {override.to === 'done' ? 'Complete anyway' : 'Start anyway'}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div role="status" className="toast">
          {toast}
        </div>
      )}
    </ActionsContext.Provider>
  );
}
