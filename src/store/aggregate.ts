import type { MemoryScope, StoreState, StoredMemoryEntry, WorkspaceIndexRef } from './types.js'
import { workspaceId } from './types.js'

/** Each scope reads only its own authoritative entries; Global is no longer an aggregate. */
export function entriesForScope(state: StoreState, scope: MemoryScope): StoredMemoryEntry[] {
  return state.entries.filter(entry => scope.kind === 'global'
    ? entry.scope.kind === 'global'
    : entry.scope.kind === 'workspace' && entry.scope.workspaceId === scope.workspaceId)
}

export function revisionForScope(state: StoreState, scope: MemoryScope): number {
  if (scope.kind === 'global') return state.scopeRevisions.global
  return state.scopeRevisions.workspaces[scope.workspaceId] ?? 0
}

export function workspaceIndexRefs(state: StoreState): WorkspaceIndexRef[] {
  return Object.entries(state.workspaces).map(([id, meta]) => ({
    workspaceId: workspaceId(id),
    entryCount: state.entries.filter(entry => entry.scope.kind === 'workspace' && entry.scope.workspaceId === id).length,
    revision: state.scopeRevisions.workspaces[id] ?? 0,
    updatedAt: meta.updatedAt,
  })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
}
