import { useMemo, useState } from 'react';
import { formatDue, toDateStr } from '../domain/dates';
import { detectAndParse, findDuplicates, FORMAT_LABELS, type ImportFile, type ImportResult } from '../domain/importers';
import { isOpen, PRIORITY_LABELS } from '../domain/types';
import { useActions } from './actions';
import { Icon } from './Icon';
import { useSnapshot, useStore } from './state';

/**
 * Import tasks from another app: pick export files or paste a list, check the preview, import.
 * Everything is added in one go and syncs like any other change.
 */
export function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const store = useStore();
  const s = useSnapshot();
  const { notify } = useActions();
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [pasted, setPasted] = useState('');
  const [skipDup, setSkipDup] = useState(true);
  const [withDone, setWithDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = toDateStr(new Date());

  const result: ImportResult | null = useMemo(() => {
    const input = files.length ? files : pasted.trim() ? [{ name: 'pasted text', text: pasted }] : [];
    return input.length ? detectAndParse(input, today) : null;
  }, [files, pasted, today]);

  const dups = useMemo(() => (result ? findDuplicates(result.items, s.tasks.filter(isOpen)) : new Set<number>()), [result, s.tasks]);
  const chosen = useMemo(
    () => (result ? result.items.filter((it, i) => (withDone || isOpen(it)) && !(skipDup && dups.has(i))) : []),
    [result, withDone, skipDup, dups],
  );
  const doneCount = result?.items.filter((it) => !isOpen(it)).length ?? 0;
  const projects = useMemo(() => {
    const have = new Set(store.tree().flatten().map(({ project }) => store.tree().path(project.id, '/').toLowerCase()));
    return [...new Set(chosen.map((it) => it.projectPath).filter((p): p is string => !!p))].filter((p) => !have.has(p.toLowerCase()));
  }, [chosen, store, s]);

  const readFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const read = await Promise.all([...list].map(async (f) => ({ name: f.name, text: await f.text() })));
    setFiles(read);
  };

  const run = async () => {
    if (!result || !chosen.length) return;
    setBusy(true);
    try {
      const n = await store.importTasks(chosen, FORMAT_LABELS[result.format]);
      notify(`Imported ${n} task${n === 1 ? '' : 's'}`);
      onDone();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide import" role="dialog" aria-modal="true" aria-labelledby="imp-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="imp-title">Import tasks</h2>
        <p className="small muted">
          Works with a Todoist or TickTick CSV export, any CSV with a Title (or Task, Subject) column such as an Outlook task export, a ToDo JSON export, or a
          plain list with one task per line using the quick-add words. Sub-tasks become a checklist in the task's description.
        </p>

        <label className="filepick">
          <Icon name="upload" />
          <span>{files.length ? files.map((f) => f.name).join(', ') : 'Choose export files'}</span>
          <input type="file" multiple accept=".csv,.tsv,.txt,.md,.json,text/*,application/json" onChange={(e) => readFiles(e.target.files)} />
        </label>
        {files.length > 0 ? (
          <button className="linkbtn small" onClick={() => setFiles([])}>Clear files and paste a list instead</button>
        ) : (
          <textarea
            aria-label="Or paste a list"
            placeholder={'Or paste a list, for example:\n# Home\n- [ ] Fix bike fri !high\n- [ ] Call plumber tomorrow 9:00 #house'}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
          />
        )}

        {result && (
          <>
            <div className="import-summary">
              <strong>
                {result.items.length} task{result.items.length === 1 ? '' : 's'} found
              </strong>{' '}
              <span className="muted">({FORMAT_LABELS[result.format]})</span>
              {projects.length > 0 && <span className="muted"> · new projects: {projects.join(', ')}</span>}
            </div>
            <div className="import-opts">
              {doneCount > 0 && (
                <label className="toggle small">
                  <input type="checkbox" checked={withDone} onChange={(e) => setWithDone(e.target.checked)} /> Include {doneCount} completed
                </label>
              )}
              {dups.size > 0 && (
                <label className="toggle small">
                  <input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} /> Skip {dups.size} you already have
                </label>
              )}
            </div>
            {result.warnings.length > 0 && (
              <details className="small warn">
                <summary>{result.warnings.length} note{result.warnings.length === 1 ? '' : 's'} about this file</summary>
                <ul>{result.warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}
            <div className="import-preview">
              <table>
                <thead>
                  <tr><th>Task</th><th>Project</th><th>Due</th><th>Priority</th></tr>
                </thead>
                <tbody>
                  {chosen.slice(0, 100).map((it, i) => (
                    <tr key={i} className={isOpen(it) ? '' : 'done'}>
                      <td>
                        {it.title}
                        {it.tags.length > 0 && <span className="muted"> {it.tags.map((t) => `#${t}`).join(' ')}</span>}
                        {it.recurrence && <Icon name="repeat" size={13} className="muted" />}
                      </td>
                      <td className="muted">{it.projectPath ?? 'Inbox'}</td>
                      <td className="muted">{formatDue(it.dueDate, it.dueTime, today)}</td>
                      <td className="muted">{it.priority ? PRIORITY_LABELS[it.priority] : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {chosen.length > 100 && <p className="small muted">…and {chosen.length - 100} more.</p>}
              {chosen.length === 0 && <p className="small muted">Nothing to import with these options.</p>}
            </div>
          </>
        )}

        <div className="actions end">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!chosen.length || busy} onClick={run}>
            {busy ? 'Importing…' : `Import ${chosen.length || ''} task${chosen.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}
