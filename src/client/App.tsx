import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  ArrowRightLeft,
  Check,
  Camera,
  Eraser,
  FlaskConical,
  RefreshCw,
  ShieldQuestion,
  Trash2,
  X,
} from 'lucide-react';
import {api} from './api';
import {SCENARIOS, basePage, mountDocument, type Transform} from './demo';
import {captureElement} from './scanner';
import {diffNodes, type NodeDiff} from '../shared/diff';
import type {
  AuditState,
  Finding,
  MappingRow,
  NodeRef,
  NodeView,
  RawNode,
  ReconcileStats,
} from '../shared/types';

const AUDIT = 'alpha';

interface IssueTarget {
  ref: NodeRef;
  label: string;
  issue: string;
}

const STATUS_LABEL: Record<Finding['status'], string> = {
  open: '待处理',
  ignored: '已忽略',
  carried: '已自动迁移',
  pending: '待确认',
  dropped: '已丢弃',
};

const PENDING_REASON: Record<string, string> = {
  pending_ambiguous: '一对多 / 候选难以区分',
  pending_low_confidence: '置信度不足',
  pending_candidate_truncated: '候选空间被上限截断',
  pending_frame_unresolved: '跨 iframe 帧未对齐',
};

export default function App() {
  const previewRef = useRef<HTMLIFrameElement>(null);
  const [page, setPage] = useState<RawNode>(() => basePage());
  const [state, setState] = useState<AuditState | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [targets, setTargets] = useState<IssueTarget[]>([]);
  const [mappings, setMappings] = useState<MappingRow[]>([]);
  const [lastStats, setLastStats] = useState<ReconcileStats | null>(null);
  const [status, setStatus] = useState('就绪');
  const [selectedScenario, setSelectedScenario] = useState<string>('sibling-insert');
  const [selectedCandidate, setSelectedCandidate] = useState<Record<string, number>>({});

  const renderPreview = useCallback((tree: RawNode) => {
    const doc = previewRef.current?.contentDocument;
    if (!doc) return;
    doc.open();
    doc.write('<!doctype html><meta charset="utf-8"><title>preview</title>');
    doc.close();
    mountDocument(doc, tree);
  }, []);

  useEffect(() => {
    renderPreview(page);
  }, [page, renderPreview]);

  const refresh = useCallback(async () => {
    const next = await api.state(AUDIT);
    setState(next);
    setMappings(await api.mappings(AUDIT).then((r) => r.mappings));
    if (next.stats) setLastStats(next.stats);
  }, []);

  useEffect(() => {
    refresh().catch((e) => setStatus(String(e)));
  }, [refresh]);

  const captureCurrent = useCallback((): RawNode => {
    const doc = previewRef.current?.contentDocument;
    if (!doc?.documentElement) return page;
    return captureElement(doc.documentElement);
  }, [page]);

  async function takeSnapshot() {
    setStatus('建立快照…');
    const root = captureCurrent();
    const result = await api.snapshot(AUDIT, root);
    const latest = result.state.snapshots.at(-1)!;
    setSnapshotId(latest.id);
    setState(result.state);
    setStatus(`快照 #${latest.seq}（${latest.nodeCount} 个节点）`);
    await refreshTargets(latest.id);
  }

  async function refreshTargets(id: string) {
    const response = await fetch(`/api/audits/${AUDIT}/snapshots/${id}/nodes`);
    if (!response.ok) {
      setTargets([]);
      return;
    }
    const data = (await response.json()) as {
      nodes: Array<{ref: NodeRef; tag: string; attrs: Record<string, string>; text: string}>;
    };
    setTargets(
      data.nodes
        .filter((n) => n.attrs['data-issue'])
        .map((n) => ({
          ref: n.ref,
          issue: n.attrs['data-issue'],
          label: n.text ? `<${n.tag}> ${n.text.slice(0, 40)}` : `<${n.tag}> [${n.attrs['data-issue']}]`,
        })),
    );
  }

  async function ignore(target: IssueTarget) {
    if (!snapshotId) return;
    setStatus('记录忽略…');
    const result = await api.finding(
      AUDIT,
      snapshotId,
      target.ref,
      target.issue,
      'serious',
      `忽略标记：${target.label}`,
    );
    setState(result.state);
    setStatus('已记录显式映射（自确认）');
  }

  async function applyScenarioAndReconcile() {
    const scenario = SCENARIOS.find((s) => s.id === selectedScenario)!;
    const transform: Transform = scenario.transform;
    setStatus(`应用「${scenario.label}」并重扫…`);
    // Mutate the live preview, then capture the resulting DOM (never trust the
    // transform output as identity input — the scanner is the real boundary).
    setPage((current) => transform(current));
    // Wait for the preview repaint + nested iframe content mounting.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const root = captureCurrent();
    const result = await api.reconcile(AUDIT, root);
    setSnapshotId(result.snapshot.id);
    setState(result.state);
    setLastStats(result.stats);
    setStatus(
      `快照 #${result.snapshot.seq}：${result.matches.filter((m) => m.status === 'auto').length} 自动 / ${result.state.pendingMappings.length} 待确认 / ${result.matches.filter((m) => m.status === 'deleted').length} 删除`,
    );
    await refreshTargets(result.snapshot.id);
  }

  async function confirmPending(findingId: string) {
    if (!snapshotId) return;
    const pending = state?.pendingMappings.find((p) => p.findingId === findingId);
    if (!pending) return;
    const index = selectedCandidate[findingId] ?? 0;
    const candidate = pending.candidates[index];
    if (!candidate) return;
    const next = await api.decide(AUDIT, findingId, candidate.ref, snapshotId);
    setState(next.state);
    setStatus('已保存用户确认的显式映射');
    await refresh();
  }

  async function rejectPending(findingId: string) {
    if (!snapshotId) return;
    const next = await api.decide(AUDIT, findingId, null, snapshotId);
    setState(next.state);
    setStatus('已确认节点删除，审阅结果丢弃');
    await refresh();
  }

  async function prune() {
    setStatus('清理旧快照（保留映射审计）…');
    const result = await api.prune(AUDIT, 1);
    setState(result.state);
    setStatus(`已清理 ${result.pruned} 个快照；映射审计保留 ${result.retainedMappings} 条`);
    await refresh();
  }

  const pendingList = state?.pendingMappings ?? [];

  return (
    <main className="shell">
      <header className="topbar">
        <FlaskConical size={20} />
        <strong>无障碍审阅 · 节点身份工作台</strong>
        <small>稳定属性 + 结构指纹 + 邻域匹配，索引化、有上界</small>
      </header>
      <section className="workspace wide">
        <section className="pane">
          <div className="toolbar wrap">
            <button className="primary" onClick={takeSnapshot}>
              <Camera size={15} />
              扫描并建立快照
            </button>
          </div>
          <div className="toolbar wrap">
            <select
              value={selectedScenario}
              onChange={(event) => setSelectedScenario(event.target.value)}
              aria-label="选择重排场景"
            >
              {SCENARIOS.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>
                  {scenario.label}
                </option>
              ))}
            </select>
            <button onClick={applyScenarioAndReconcile} disabled={!snapshotId}>
              <RefreshCw size={15} />
              重排并对账
            </button>
            <button onClick={prune} disabled={!state || state.snapshots.length < 2}>
              <Eraser size={15} />
              清理旧快照
            </button>
          </div>
          <p className="status" role="status">
            {status}
          </p>
          <h2>实时页面（含 iframe）</h2>
          <iframe title="被审页面预览" ref={previewRef} className="preview" sandbox="allow-same-origin" />
          {lastStats && <StatsBar stats={lastStats} />}
        </section>

        <section className="pane">
          <h2>可忽略的问题</h2>
          {!snapshotId && <p className="hint">先建立快照，再对问题做忽略标记。</p>}
          <div className="list">
            {targets.map((target) => {
              const finding = state?.findings.find(
                (f) => f.anchor.uid === target.ref.uid && f.status !== 'dropped',
              );
              return (
                <div className="finding" key={`${target.ref.frameId}/${target.ref.uid}`}>
                  <div>
                    <code>{target.issue}</code>
                    <p>{target.label}</p>
                    <small>
                      帧 {target.ref.frameId === 'top' ? 'top' : target.ref.frameId.split('/').slice(1).join('/')}
                    </small>
                  </div>
                  {finding ? (
                    <span className={`badge badge-${finding.status}`}>{STATUS_LABEL[finding.status]}</span>
                  ) : (
                    <button disabled={!snapshotId} onClick={() => ignore(target)}>
                      忽略
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <h2 className="push-down">待确认的映射 ({pendingList.length})</h2>
          {pendingList.length === 0 && <p className="hint">没有待确认项。低置信或一对多匹配才会出现在这里。</p>}
          {pendingList.map((pending) => (
            <PendingCard
              key={pending.findingId}
              pending={pending}
              candidateIndex={selectedCandidate[pending.findingId] ?? 0}
              onSelect={(index) =>
                setSelectedCandidate((current) => ({...current, [pending.findingId]: index}))
              }
              onConfirm={() => confirmPending(pending.findingId)}
              onReject={() => rejectPending(pending.findingId)}
            />
          ))}
        </section>

        <aside className="pane">
          <h2>
            <ArrowRightLeft size={15} /> 映射审计
          </h2>
          <p className="hint">快照清理后仍然保留（已确认 / 自动 / 拒绝）。</p>
          <div className="audit-list">
            {mappings.length === 0 && <p className="hint">尚无映射记录。</p>}
            {mappings
              .slice()
              .reverse()
              .map((row) => (
                <div key={row.id} className={`audit-row audit-${row.decision}`}>
                  <div className="audit-head">
                    <span className={`badge badge-map-${row.decision}`}>
                      {row.decision === 'auto' ? '自动' : row.decision === 'confirmed' ? '已确认' : '已拒绝'}
                    </span>
                    <small title={row.id}>
                      {row.oldSnapshotId === row.newSnapshotId
                        ? `快照内锚点 #${row.oldSnapshotId.split('_').pop()}`
                        : `#${row.oldSnapshotId.split('_').pop()} → #${row.newSnapshotId.split('_').pop()}`}
                    </small>
                  </div>
                  <p>{row.oldNode.label}</p>
                  {row.newNode ? (
                    <p className="arrow">
                      <Check size={12} /> {row.newNode.label}
                    </p>
                  ) : (
                    <p className="arrow rejected">
                      <X size={12} /> 无对应节点（删除）
                    </p>
                  )}
                  <small>
                    {row.decidedBy} · 置信度 {row.confidence.toFixed(2)} · {row.reasons.join('，')}
                  </small>
                </div>
              ))}
          </div>
        </aside>
      </section>
    </main>
  );
}

function StatsBar({stats}: {stats: ReconcileStats}) {
  const within = stats.scoredEdges <= stats.edgeBound;
  return (
    <div className="stats">
      <h3>
        <ShieldQuestion size={14} /> 匹配复杂度
      </h3>
      <dl>
        <div>
          <dt>节点（旧/新）</dt>
          <dd>
            {stats.oldNodeCount} / {stats.newNodeCount}
          </dd>
        </div>
        <div>
          <dt>实际打分边数</dt>
          <dd>{stats.scoredEdges}</dd>
        </div>
        <div>
          <dt>线性上界 12·N</dt>
          <dd className={within ? 'ok' : 'bad'}>
            {stats.edgeBound} {within ? '✓' : '✗'}
          </dd>
        </div>
        <div>
          <dt>桶索引</dt>
          <dd>{stats.candidateBuckets}</dd>
        </div>
        <div>
          <dt>耗时</dt>
          <dd>{stats.durationMs} ms</dd>
        </div>
      </dl>
    </div>
  );
}

function PendingCard({
  pending,
  candidateIndex,
  onSelect,
  onConfirm,
  onReject,
}: {
  pending: AuditState['pendingMappings'][number];
  candidateIndex: number;
  onSelect: (index: number) => void;
  onConfirm: () => void;
  onReject: () => void;
}) {
  const candidate = pending.candidates[candidateIndex] ?? null;
  const diff: NodeDiff = useMemo(
    () => diffNodes(pending.currentNode ?? pending.oldNode, candidate),
    [pending, candidate],
  );
  return (
    <div className="pending-card">
      <div className="pending-head">
        <ShieldQuestion size={16} />
        <strong>{PENDING_REASON[pending.status] ?? pending.status}</strong>
        <span className="badge badge-pending">置信度 {pending.confidence.toFixed(2)}</span>
      </div>
      <div className="diff-grid">
        <div>
          <h4>原节点（审阅结果所在）</h4>
          <NodeCard view={pending.oldNode} muted />
        </div>
        <div>
          <h4>候选新节点</h4>
          {pending.candidates.length === 0 && <p className="hint">无候选 —— 节点可能已删除。</p>}
          <select
            value={candidateIndex}
            onChange={(event) => onSelect(Number(event.target.value))}
            disabled={pending.candidates.length === 0}
          >
            {pending.candidates.map((option, index) => (
              <option key={`${option.ref.frameId}/${option.ref.uid}`} value={index}>
                {option.label}（{option.score.toFixed(2)}）
              </option>
            ))}
          </select>
          {candidate && <NodeCard view={candidate} />}
        </div>
      </div>
      <DiffView diff={diff} />
      <div className="toolbar">
        <button className="primary" onClick={onConfirm} disabled={!candidate}>
          <Check size={15} /> 确认映射并迁移
        </button>
        <button onClick={onReject}>
          <Trash2 size={15} /> 节点已删除，丢弃
        </button>
      </div>
    </div>
  );
}

function NodeCard({view, muted}: {view: NodeView; muted?: boolean}) {
  return (
    <div className={`node-card ${muted ? 'muted' : ''}`}>
      <p className="node-label">{view.label}</p>
      <small>
        路径（仅展示）: {view.ref.frameId === 'top' ? '' : view.ref.frameId + ' / '}
        {view.pathText}
      </small>
      <dl className="node-meta">
        <div>
          <dt>role</dt>
          <dd>{view.role ?? '—'}</dd>
        </div>
        <div>
          <dt>name</dt>
          <dd>{view.name || '—'}</dd>
        </div>
        <div>
          <dt>子树</dt>
          <dd>
            {view.childCount} 子 / {view.subtreeSize} 节点
          </dd>
        </div>
      </dl>
    </div>
  );
}

function DiffView({diff}: {diff: NodeDiff}) {
  return (
    <div className="diff-view">
      <h4>差异</h4>
      {diff.tagChanged && <p className="diff-warn">标签发生变化</p>}
      {diff.attributes.length > 0 && (
        <ul className="diff-attrs">
          {diff.attributes.slice(0, 6).map((change) => (
            <li key={change.name}>
              <code>{change.name}</code>：
              <span className="removed">{change.oldValue ?? '∅'}</span> →{' '}
              <span className="added">{change.newValue ?? '∅'}</span>
            </li>
          ))}
        </ul>
      )}
      {diff.textLines.length > 0 && (
        <p className="diff-text">
          {diff.textLines.map((line, index) => (
            <span key={index} className={`text-${line.kind}`}>
              {line.text}{' '}
            </span>
          ))}
        </p>
      )}
      {diff.structural.structChanged && (
        <small className="diff-warn">
          结构指纹变化（{diff.structural.oldSubtreeSize} → {diff.structural.newSubtreeSize} 节点）
        </small>
      )}
    </div>
  );
}
