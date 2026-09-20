import type {AuditState, NodeRef, RawNode, ReconcileResult} from '../shared/types';

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(await response.json())}`);
  return response.json() as Promise<T>;
}

export const api = {
  state(auditId: string): Promise<AuditState> {
    return fetch(`/api/audits/${auditId}/state`).then((r) => json(r));
  },
  snapshot(auditId: string, root: RawNode) {
    return fetch(`/api/audits/${auditId}/snapshots`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({root}),
    }).then((r) => json<{state: AuditState}>(r));
  },
  finding(
    auditId: string,
    snapshotId: string,
    ref: NodeRef,
    rule: string,
    severity: string,
    message: string,
  ) {
    return fetch(`/api/audits/${auditId}/findings`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({snapshotId, ref, rule, severity, message}),
    }).then((r) => json<{state: AuditState}>(r));
  },
  reconcile(auditId: string, root: RawNode) {
    return fetch(`/api/audits/${auditId}/reconcile`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({root}),
    }).then(
      (r) =>
        json<{
          snapshot: {id: string; seq: number; nodeCount: number};
          matches: ReconcileResult['matches'];
          stats: ReconcileResult['stats'];
          frameAlignment: ReconcileResult['frameAlignment'];
          state: AuditState;
        }>(r),
    );
  },
  decide(auditId: string, findingId: string, targetRef: NodeRef | null, snapshotId: string) {
    return fetch(`/api/audits/${auditId}/decide`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({findingId, targetRef, snapshotId}),
    }).then((r) => json<{state: AuditState}>(r));
  },
  prune(auditId: string, keep = 1) {
    return fetch(`/api/audits/${auditId}/prune`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({keep}),
    }).then((r) => json<{pruned: number; retainedMappings: number; state: AuditState}>(r));
  },
  mappings(auditId: string) {
    return fetch(`/api/audits/${auditId}/mappings`)
      .then((r) => json<{mappings: import('../shared/types').MappingRow[]}>(r));
  },
};
