import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  FlaskConical, Play, Save, Camera, RefreshCw, CheckCircle2, AlertTriangle,
  Trash2, ScrollText, ArrowRight, GitMerge, Ban, Eye,
} from 'lucide-react';
import {api, type PendingView, type ReviewState} from './api';
import {FIXTURES, fixtureFlatPair, type Fixture} from '../shared/fixtures';
import type {SnapshotInput} from '../shared/types';
import {DiffView} from './DiffView';
import {AuditTrail} from './AuditTrail';

type Tab = 'identity' | 'legacy';

export default function App() {
  const [tab, setTab] = useState<Tab>('identity');
  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20}/>
        <strong>Accessibility Review</strong>
        <nav className="tabs">
          <button className={tab === 'identity' ? 'active' : ''} onClick={() => setTab('identity')}>
            <GitMerge size={14}/>Node identity
          </button>
          <button className={tab === 'legacy' ? 'active' : ''} onClick={() => setTab('legacy')}>
            <ScrollText size={14}/>Text audits
          </button>
        </nav>
        <small>Local workspace</small>
      </header>
      {tab === 'identity' ? <IdentityWorkbench/> : <LegacyAudits/>}
    </main>
  );
}

const AUDIT = 'alpha';

function IdentityWorkbench() {
  const [fixtureKey, setFixtureKey] = useState(FIXTURES[0].key);
  const [state, setState] = useState<ReviewState | null>(null);
  const [status, setStatus] = useState('Ready');
  const [busy, setBusy] = useState(false);
  const [selectedPending, setSelectedPending] = useState<string | null>(null);
  const [auditOpen, setAuditOpen] = useState(false);

  const fixture = useMemo(() => FIXTURES.find(f => f.key === fixtureKey)!, [fixtureKey]);
  const oldSnap = state?.snapshots[state.snapshots.length - 2];
  const newSnap = state?.snapshots[state.snapshots.length - 1];

  const refresh = useCallback(async () => {
    setState(await api.state(AUDIT));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function runSide(side: 'before' | 'after') {
    setBusy(true); setStatus(`Uploading ${side} snapshot…`);
    try {
      const input: SnapshotInput = side === 'before' ? fixture.before : fixture.after;
      const record = await api.uploadSnapshot(AUDIT, input);
      setStatus(`Captured ${side} snapshot: ${record.nodeCount} nodes / ${record.frameCount} frames`);
      if (side === 'before') await seedFinding(fixture, record.id);
      await refresh();
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  }

  async function seedFinding(f: Fixture, snapshotId: string) {
    const {targetBefore} = fixtureFlatPair(f);
    await api.addFindings(AUDIT, snapshotId, [{
      target: targetBefore,
      rule: f.finding.rule,
      message: f.finding.message,
      severity: f.finding.severity,
      status: 'ignored',
    }]);
    setStatus('Marked finding as ignored on the old node');
  }

  async function rematch() {
    if (!oldSnap || !newSnap) return;
    setBusy(true); setStatus('Matching identities…');
    try {
      const {state: next} = await api.match(AUDIT, oldSnap.id, newSnap.id);
      setState(next);
      setStatus(`Auto-migrated ${next.autoMigrated.length} · ${next.pending.length} need confirmation`);
      setSelectedPending(next.pending[0]?.oldNid ?? null);
    } catch (error) { setStatus((error as Error).message); }
    finally { setBusy(false); }
  }

  async function resetScenario() {
    setBusy(true);
    await api.reset(AUDIT);
    await api.uploadSnapshot(AUDIT, fixture.before);
    const before = (await api.state(AUDIT)).snapshots[0];
    await seedFinding(fixture, before.id);
    await api.uploadSnapshot(AUDIT, fixture.after);
    await refresh();
    setStatus('Scenario reset');
    setBusy(false);
  }

  async function confirm(p: PendingView, newNid: string | null) {
    if (!oldSnap || !newSnap) return;
    const candidate = p.candidates.find(c => c.newNid === newNid) ?? null;
    await api.confirmMapping(AUDIT, {
      fromSnapshotId: oldSnap.id, toSnapshotId: newSnap.id,
      oldNid: p.oldNid, newNid,
      resolution: newNid ? 'confirmed' : 'deleted_accepted',
      chosenCandidate: candidate ? {confidence: candidate.confidence, crossFrame: candidate.crossFrame} : null,
    });
    await refresh();
    setStatus('Explicit mapping saved to the audit trail');
  }

  async function prune() {
    const result = await api.cleanup(AUDIT, 1);
    await refresh();
    setStatus(`Pruned ${result.deleted.length} snapshot(s); ${result.retainedMappings} mapping record(s) retained`);
  }

  return (
    <section className="workspace identity">
      <aside className="pane scenarios">
        <h2>Remap scenarios</h2>
        <p className="hint">The finding is marked <b>ignored</b> on a node, then the DOM is re-captured.</p>
        <div className="list">
          {FIXTURES.map(f => (
            <button key={f.key} className={f.key === fixtureKey ? 'active' : ''} onClick={() => setFixtureKey(f.key)}>
              <span className="scenario-title">{f.title}</span>
              <small>{f.description}</small>
              <span className={`badge ${f.expect}`}>{f.expect === 'auto' ? 'should auto-migrate' : 'needs confirm'}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="pane flow">
        <div className="toolbar wrap">
          <button onClick={() => runSide('before')} disabled={busy}><Camera size={15}/>1. Capture old</button>
          <button onClick={() => runSide('after')} disabled={busy}><Camera size={15}/>2. Re-capture new</button>
          <button className="primary" onClick={rematch} disabled={busy || !oldSnap || !newSnap}>
            <RefreshCw size={15}/>3. Match identities
          </button>
          <button onClick={resetScenario} disabled={busy}><Play size={15}/>Load scenario</button>
          <button onClick={prune} title="Delete all but the latest snapshot"><Trash2 size={15}/>Prune old</button>
          <button onClick={() => setAuditOpen(true)}><ScrollText size={15}/>Audit trail</button>
        </div>

        <div className="status-line"><span className={`dot ${busy ? 'busy' : ''}`}/>{status}</div>

        <div className="snapshots">
          <SnapshotCard label="Old snapshot" snap={oldSnap}/>
          <ArrowRight size={18} className="arrow"/>
          <SnapshotCard label="New snapshot" snap={newSnap}/>
        </div>

        <AutoMigrated state={state}/>

        <div className="pending">
          <h3><AlertTriangle size={16}/>Pending confirmation ({state?.pending.length ?? 0})</h3>
          {state && state.pending.length === 0 && (
            <p className="empty">No stalled findings. Low-confidence or one-to-many matches appear here.</p>
          )}
          {state?.pending.map(p => (
            <PendingCard
              key={p.oldNid}
              pending={p}
              open={selectedPending === p.oldNid}
              onToggle={() => setSelectedPending(selectedPending === p.oldNid ? null : p.oldNid)}
              onConfirm={confirm}
            />
          ))}
        </div>
      </section>

      <FindingsPane state={state}/>

      {auditOpen && <AuditTrail auditId={AUDIT} onClose={() => setAuditOpen(false)}/>}
    </section>
  );
}

function SnapshotCard({label, snap}: {label: string; snap: ReviewState['snapshots'][number] | undefined}) {
  return (
    <div className={`snap-card ${snap ? '' : 'missing'}`}>
      <span className="snap-label">{label}</span>
      {snap ? (
        <>
          <strong>{snap.url.replace('https://', '')}</strong>
          <small>{new Date(snap.capturedAt).toLocaleString()}</small>
          <span className="pill">{snap.nodeCount} nodes · {snap.frameCount} frame(s)</span>
          <code>{snap.id}</code>
        </>
      ) : <small>not captured yet</small>}
    </div>
  );
}

function AutoMigrated({state}: {state: ReviewState | null}) {
  if (!state || state.autoMigrated.length === 0) return null;
  return (
    <div className="auto-box">
      <h3><CheckCircle2 size={16}/>Automatically migrated ({state.autoMigrated.length})</h3>
      <ul>
        {state.autoMigrated.map(m => (
          <li key={m.findingId}>
            <code>{m.findingId}</code>
            <span>{m.oldNid} <ArrowRight size={12}/> {m.newNid}</span>
            <span className="conf">confidence {(m.confidence * 100).toFixed(0)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PendingCard({pending: p, open, onToggle, onConfirm}: {
  pending: PendingView; open: boolean;
  onToggle: () => void;
  onConfirm: (p: PendingView, newNid: string | null) => void;
}) {
  const reasonText: Record<string, string> = {
    ambiguous: 'Multiple candidates are statistically tied',
    contested: 'Candidate already claimed by another finding',
    low_confidence: 'Similarity below auto-migration threshold',
    no_match: 'No plausible surviving element',
    deleted: 'Element appears deleted',
    cross_frame: 'Match crosses an iframe boundary without a stable key',
    candidate_cap: 'Candidate search hit its bounded cap',
  };
  return (
    <div className={`pending-card ${open ? 'open' : ''}`}>
      <button className="pending-head" onClick={onToggle}>
        <Eye size={15}/>
        <span className="old-node">{p.oldLabel}</span>
        <span className={`reason ${p.reason}`}>{reasonText[p.reason] ?? p.reason}</span>
      </button>
      {open && (
        <div className="pending-body">
          <p className="detail">{p.detail}</p>
          {p.findings.map(f => (
            <div key={f.id} className="finding-chip">
              <Ban size={13}/>{f.rule}: {f.message} <code>{f.id}</code>
            </div>
          ))}
          {p.candidates.length === 0 ? (
            <div className="confirm-row">
              <span>No candidates — the node and its finding likely no longer exist.</span>
              <button className="danger" onClick={() => onConfirm(p, null)}>
                <Trash2 size={14}/>Accept deletion (close finding)
              </button>
            </div>
          ) : (
            p.candidates.map(c => (
              <div key={c.newNid} className="candidate">
                <div className="candidate-head">
                  <span className="new-node">{c.newLabel}</span>
                  <span className={`conf ${c.confidence >= 0.9 ? 'high' : 'low'}`}>
                    {(c.confidence * 100).toFixed(0)}%
                  </span>
                  {c.crossFrame && <span className="frame-tag">cross-iframe</span>}
                </div>
                <DiffView diff={c.diff}/>
                <div className="confirm-row">
                  <button className="primary" onClick={() => onConfirm(p, c.newNid)}>
                    <CheckCircle2 size={14}/>This is the same node
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function FindingsPane({state}: {state: ReviewState | null}) {
  return (
    <aside className="pane findings">
      <h2>Findings</h2>
      {!state || state.findings.length === 0 ? (
        <p className="empty">Load a scenario to seed an ignored finding.</p>
      ) : (
        <div className="list">
          {state.findings.map(f => (
            <div key={f.id} className="finding">
              <div className="finding-top">
                <span className={`sev ${f.severity}`}>{f.severity}</span>
                <span className={`status-tag ${f.status}`}>{f.status}</span>
              </div>
              <strong>{f.rule}</strong>
              <p>{f.message}</p>
              <small>
                target <code>{f.currentTarget}</code>
                {f.currentTarget !== f.target && <span className="migrated"> (migrated)</span>}
              </small>
              <div className="finding-actions">
                <button onClick={() => api.setFindingStatus(AUDIT, f.id, 'ignored').then(() => location.reload())}>Ignore</button>
                <button onClick={() => api.setFindingStatus(AUDIT, f.id, 'open').then(() => location.reload())}>Reopen</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

function LegacyAudits() {
  const [items, setItems] = useState<{id: string; name: string; revision: number}[]>([]);
  const [selected, setSelected] = useState('alpha');
  const [row, setRow] = useState<{id: string; content: string; revision: number} | null>(null);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState('Ready');
  useEffect(() => { api.audits().then(setItems); }, []);
  useEffect(() => {
    setStatus('Loading');
    fetch('/api/audits/' + selected).then(r => r.json()).then((v) => { setRow(v); setDraft(v.content); setStatus('Loaded'); });
  }, [selected]);
  async function save() {
    if (!row) return;
    setStatus('Saving');
    const response = await fetch('/api/audits/' + row.id, {
      method: 'PUT', headers: {'content-type': 'application/json'},
      body: JSON.stringify({content: draft, revision: row.revision}),
    });
    const value = await response.json();
    if (!response.ok) { setStatus('Revision conflict'); return; }
    setRow(value); setStatus('Saved');
  }
  return (
    <section className="workspace">
      <aside className="pane"><h2>Items</h2>
        <div className="list">{items.map(item =>
          <button className={item.id === selected ? 'active' : ''} onClick={() => setSelected(item.id)} key={item.id}>
            {item.name}<br/><small>Revision {item.revision}</small>
          </button>)}
        </div>
      </aside>
      <section className="pane">
        <div className="toolbar">
          <button className="primary" onClick={save}><Save size={15}/>Save</button><span>{status}</span>
        </div>
        <textarea aria-label="Content" value={draft} onChange={e => setDraft(e.target.value)}/>
      </section>
      <aside className="pane"><h2>Inspection</h2><span className="pill">{selected}</span><pre>{JSON.stringify(row, null, 2)}</pre></aside>
    </section>
  );
}
