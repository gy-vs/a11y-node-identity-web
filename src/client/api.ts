// Typed client for the node-identity review API.

import type {SnapshotInput} from '../shared/types';
import type {MatchPlan} from '../shared/matcher';

export type FindingView = {
  id: string; rule: string; message: string;
  severity: 'low' | 'medium' | 'high'; status: 'open' | 'ignored' | 'fixed';
  target: string; currentTarget: string; snapshotId: string; currentSnapshotId: string;
};

export type CandidateView = {
  newNid: string; confidence: number; crossFrame: boolean; samePath: boolean;
  newLabel: string; framePath: string[];
  diff: {
    oldLabel: string; newLabel: string; shapeSimilarity: number;
    fields: Array<
      | {field: 'tag'; old: string; new: string}
      | {field: 'stableAttribute'; name: string; old: string | null; new: string | null}
      | {field: 'class'; added: string[]; removed: string[]}
      | {field: 'text'; old: string; new: string; similarity: number}
      | {field: 'shape'; oldShape: string; newShape: string; similarity: number}
      | {field: 'frame'; oldPath: string[]; newPath: string[]}
      | {field: 'position'; oldPath: number[]; newPath: number[]; moved: true}
    >;
  };
};

export type PendingView = {
  oldNid: string; oldLabel: string; reason: string; detail: string;
  findings: FindingView[]; candidates: CandidateView[];
};

export type ReviewState = {
  auditId: string;
  snapshots: Array<{id: string; revision: number; url: string; capturedAt: string; nodeCount: number; frameCount: number}>;
  findings: FindingView[];
  plan: (MatchPlan & {generatedAt?: string}) | null;
  pending: PendingView[];
  autoMigrated: Array<{findingId: string; oldNid: string; newNid: string; confidence: number}>;
};

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: {'content-type': 'application/json'},
    ...init,
  });
  if (!response.ok) throw new Error(`${response.status} ${(await response.json().catch(() => ({}))).error ?? response.statusText}`);
  return response.status === 204 ? (undefined as T) : response.json();
}

export const api = {
  audits: () => jsonFetch<Array<{id: string; name: string; revision: number}>>('/api/audits'),
  uploadSnapshot: (auditId: string, input: SnapshotInput) =>
    jsonFetch<{id: string; revision: number; nodeCount: number; frameCount: number}>(
      `/api/reviews/${auditId}/snapshots`, {method: 'POST', body: JSON.stringify(input)}),
  addFindings: (auditId: string, snapshotId: string, findings: Array<{
    target: string; rule: string; message: string;
    severity: 'low' | 'medium' | 'high'; status?: 'open' | 'ignored';
  }>) => jsonFetch<unknown>(`/api/reviews/${auditId}/findings`, {
    method: 'POST', body: JSON.stringify({snapshotId, findings}),
  }),
  setFindingStatus: (auditId: string, findingId: string, status: 'open' | 'ignored' | 'fixed') =>
    jsonFetch<unknown>(`/api/reviews/${auditId}/findings/${findingId}`, {
      method: 'PATCH', body: JSON.stringify({status}),
    }),
  match: (auditId: string, oldSnapshotId: string, newSnapshotId: string) =>
    jsonFetch<{plan: MatchPlan; state: ReviewState}>(`/api/reviews/${auditId}/match`, {
      method: 'POST', body: JSON.stringify({oldSnapshotId, newSnapshotId}),
    }),
  state: (auditId: string) => jsonFetch<ReviewState>(`/api/reviews/${auditId}/state`),
  confirmMapping: (auditId: string, body: {
    fromSnapshotId: string; toSnapshotId: string;
    oldNid: string; newNid: string | null; resolution: 'confirmed' | 'deleted_accepted';
    chosenCandidate?: unknown;
  }) => jsonFetch<unknown>(`/api/reviews/${auditId}/mappings`, {
    method: 'POST', body: JSON.stringify(body),
  }),
  mappings: (auditId: string) =>
    jsonFetch<{mappings: Array<Record<string, unknown>>; snapshotIds: Set<string>}>(
      `/api/reviews/${auditId}/mappings`),
  cleanup: (auditId: string, keepLatest = 1) =>
    jsonFetch<{deleted: string[]; retainedMappings: number}>(
      `/api/reviews/${auditId}/cleanup`, {method: 'POST', body: JSON.stringify({keepLatest})}),
  reset: (auditId: string) =>
    jsonFetch<void>(`/api/reviews/${auditId}/reset`, {method: 'POST'}),
};
