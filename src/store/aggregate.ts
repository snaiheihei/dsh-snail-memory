import type { MemoryScope, StoreState, StoredMemoryEntry, WorkspaceIndexRef } from './types.js'
import { workspaceId } from './types.js'

/** Global is a read-only projection of workspace entries, never an independent entry scope. */
export function entriesForScope(state: StoreState, scope: MemoryScope): StoredMemoryEntry[] {
  return state.entries.filter(entry => scope.kind === 'global'
    ? entry.scope.kind === 'workspace'
    : entry.scope.kind === 'workspace' && entry.scope.workspaceId === scope.workspaceId)
}

export function revisionForScope(state: StoreState, scope: MemoryScope): number {
  if (scope.kind === 'workspace') return state.scopeRevisions.workspaces[scope.workspaceId] ?? 0
  return Object.values(state.scopeRevisions.workspaces).reduce((total, revision) => total + revision, 0)
}

export function workspaceIndexRefs(state: StoreState): WorkspaceIndexRef[] {
  return Object.entries(state.workspaces).map(([id, meta]) => ({
    workspaceId: workspaceId(id),
    entryCount: state.entries.filter(entry => entry.scope.kind === 'workspace' && entry.scope.workspaceId === id).length,
    revision: state.scopeRevisions.workspaces[id] ?? 0,
    updatedAt: meta.updatedAt,
  })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
}
