import {useEffect, useState} from 'react';
import {X, ScrollText, ShieldAlert} from 'lucide-react';
import {api} from './api';

type MappingRecord = {
  id: string;
  fromSnapshotId: string;
  toSnapshotId: string;
  oldNid: string;
  newNid: string;
  resolution: 'confirmed' | 'deleted_accepted' | 'ignored_unmapped';
  confirmedBy: string;
  confirmedAt: string;
  sourceSnapshotPruned: boolean;
  oldDescriptor: {tag: string; name: string; keys: Array<{kind: string; value: string}>; framePath: string[]};
  newDescriptor: {tag: string; name: string; keys: Array<{kind: string; value: string}>; framePath: string[]};
};

// Append-only explicit mapping history. These records survive snapshot
// cleanup: sourceSnapshotPruned=true marks entries whose source DOM is gone.
export function AuditTrail({auditId, onClose}: {auditId: string; onClose: () => void}) {
  const [records, setRecords] = useState<MappingRecord[]>([]);
  const [liveSnapshots, setLiveSnapshots] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.mappings(auditId).then(data => {
      setRecords(data.mappings as MappingRecord[]);
      setLiveSnapshots(data.snapshotIds instanceof Set ? data.snapshotIds : new Set(data.snapshotIds as unknown as string[]));
    });
  }, [auditId]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <header>
          <ScrollText size={18}/>
          <h2>Confirmed mapping audit trail</h2>
          <button className="icon" onClick={onClose} aria-label="Close"><X size={18}/></button>
        </header>
        <p className="hint">
          Explicit reviewer decisions are stored independently of snapshots and retained after cleanup.
        </p>
        {records.length === 0 ? (
          <p className="empty">No confirmed mappings yet.</p>
        ) : (
          <table className="audit-table">
            <thead>
              <tr><th>Record</th><th>Old node</th><th>New node</th><th>Snapshots</th><th>Decision</th><th>Reviewer</th></tr>
            </thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id} className={r.sourceSnapshotPruned ? 'pruned' : ''}>
                  <td><code>{r.id}</code><br/><small>{new Date(r.confirmedAt).toLocaleString()}</small></td>
                  <td>{describe(r.oldDescriptor)}<br/><code>{r.oldNid}</code></td>
                  <td>{r.newNid ? describe(r.newDescriptor) : <em>deleted</em>}{r.newNid && <><br/><code>{r.newNid}</code></>}</td>
                  <td>
                    <SnapshotRef id={r.fromSnapshotId} live={liveSnapshots.has(r.fromSnapshotId)}/>
                    {' → '}
                    <SnapshotRef id={r.toSnapshotId} live={liveSnapshots.has(r.toSnapshotId)}/>
                  </td>
                  <td><span className={`resolution ${r.resolution}`}>{r.resolution.replace('_', ' ')}</span></td>
                  <td>{r.confirmedBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function describe(d: MappingRecord['oldDescriptor']): string {
  if (d.keys.length) {
    const k = d.keys[0];
    return `${d.tag}[${k.kind}="${k.value}"]${d.framePath.length ? `  (frame ${d.framePath.join('›')})` : ''}`;
  }
  return `${d.tag}${d.name ? ` "${d.name.slice(0, 30)}"` : ''}${d.framePath.length ? `  (frame ${d.framePath.join('›')})` : ''}`;
}

function SnapshotRef({id, live}: {id: string; live: boolean}) {
  return (
    <span className={`snap-ref ${live ? '' : 'gone'}`} title={live ? 'snapshot retained' : 'snapshot pruned — record kept'}>
      {!live && <ShieldAlert size={11}/>}<code>{id}</code>
    </span>
  );
}
