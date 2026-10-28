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
export type StoredMemoryEntry = MemoryIndexEntry & { readonly detailChars: number }

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
  /** Absent for global snapshots and legacy workspace generations. */
  readonly workspaceId?: WorkspaceId
  readonly snapshot: string
  readonly createdAt: string
  readonly automatic: boolean
}

export interface CommittedInjection {
  readonly injectionId: string
  readonly revision: number
  /** Absent for global snapshots and legacy workspace commits. */
  readonly workspaceId?: WorkspaceId
  readonly tokens: number
  readonly committedAt: string
}

export interface LayerMemoryState {
  enabled: boolean
  desired: DesiredInjection[]
  committed: CommittedInjection[]
}

/** The only generation currently eligible for Inbox restoration and pre-step admission. */
export interface ActiveDesiredInjection {
  readonly layer: MemoryLayer
  readonly injectionId: string
}

export interface SessionDistillationCursor {
  lastEventSeq: number
  offset: number
  updatedAt: string
}

export interface SessionMemoryState {
  readonly sessionId: string
  /** The Session owner used for automatic distillation and explicit writes. */
  workspaceId?: WorkspaceId
  /** The independently selectable workspace used only for recall and detail reads. */
  selectedWorkspaceId?: WorkspaceId
  distillationCursor?: SessionDistillationCursor
  /** Null is explicit: older superseded generations must not be resurrected after commit/disable. */
  activeDesired: ActiveDesiredInjection | null
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
  readonly formatVersion: 2
  revision: number
  entries: StoredMemoryEntry[]
  workspaces: Record<string, { readonly createdAt: string; updatedAt: string }>
  scopeRevisions: { global: number; workspaces: Record<string, number> }
  sessions: Record<string, SessionMemoryState>
  meta: MemoryMeta
}
