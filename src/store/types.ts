export type MemoryId = string & { readonly __memoryId: unique symbol }
export type WorkspaceId = string & { readonly __workspaceId: unique symbol }

export function memoryId(value: string): MemoryId {
  return value as MemoryId
}

export function workspaceId(value: string): WorkspaceId {
  return value as WorkspaceId
}

export type MemoryScope =
  | { readonly kind: 'global' }
  | { readonly kind: 'workspace'; readonly workspaceId: WorkspaceId }

export type MemoryLayer = 'global' | 'workspace'

export type MemoryCategory =
  | 'preference'
  | 'project-convention'
  | 'environment-fact'
  | 'troubleshooting'
  | 'long-term-decision'

export interface MemorySourceRef {
  readonly sessionId: string
  readonly eventSeqs?: readonly number[]
}

export interface MemoryEntry {
  readonly id: MemoryId
  readonly scope: MemoryScope
  readonly category: MemoryCategory
  readonly summary: string
  readonly detail: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastVerifiedAt: string
  readonly revision: number
  readonly sourceRefs: readonly MemorySourceRef[]
  readonly expiresAt?: string
  readonly supersedes?: readonly MemoryId[]
}

export interface UpsertMemoryInput {
  readonly id?: MemoryId
  readonly scope: MemoryScope
  readonly category: MemoryCategory
  readonly summary: string
  readonly detail: string
  readonly sourceRefs: readonly MemorySourceRef[]
  readonly lastVerifiedAt: string
  readonly expiresAt?: string
  readonly supersedes?: readonly MemoryId[]
}

export type MemoryIndexEntry = Omit<MemoryEntry, 'detail'>

export interface WorkspaceIndexRef {
  readonly workspaceId: WorkspaceId
  readonly entryCount: number
  readonly revision: number
  readonly updatedAt: string
}

export interface MemoryIndex {
  readonly scope: MemoryScope
  readonly revision: number
  readonly entries: readonly MemoryIndexEntry[]
  readonly workspaces: readonly WorkspaceIndexRef[]
}

export interface DesiredInjection {
  readonly injectionId: string
  readonly revision: number
  readonly snapshot: string
  readonly createdAt: string
  readonly automatic: boolean
}

export interface CommittedInjection {
  readonly injectionId: string
  readonly revision: number
  readonly tokens: number
  readonly committedAt: string
}

export interface LayerMemoryState {
  enabled: boolean
  desired: DesiredInjection[]
  committed: CommittedInjection[]
}

export interface SessionMemoryState {
  readonly sessionId: string
  workspaceId?: WorkspaceId
  readonly layers: Record<MemoryLayer, LayerMemoryState>
}

export interface MemoryMeta {
  dirty: boolean
  nextConsolidationAt: string | null
  nextRetentionAt: string | null
  lastConsolidationAt: string | null
  lastRetentionAt: string | null
  lastError: string | null
  pending: Record<string, { readonly kind: string; readonly createdAt: string }>
}

export interface StoreState {
  readonly formatVersion: 1
  revision: number
  entries: MemoryEntry[]
  workspaces: Record<string, { readonly createdAt: string; updatedAt: string }>
  scopeRevisions: { global: number; workspaces: Record<string, number> }
  sessions: Record<string, SessionMemoryState>
  meta: MemoryMeta
}
