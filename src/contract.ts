import type {
  MemoryCategory,
  MemoryEntry,
  MemoryId,
  MemoryIndex,
  MemoryLayer,
  MemoryMeta,
  MemoryScope,
  PromoteMemoryResult,
  SessionMemoryState,
  WorkspaceId,
} from './store/types.js'
import type { MemoryOperationResult } from './context/service.js'

export const RPC_ROUTE_PREFIX = '/snail-memory/rpc'
export const RPC_METHODS = [
  'getSessionState', 'enable', 'disable', 'refresh', 'list', 'consolidate', 'read', 'remove', 'promote', 'remember', 'correct', 'status',
  'getSettings', 'updateSettings', 'listWorkspaces',
] as const

export type RpcMethod = typeof RPC_METHODS[number]
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface SessionRequest { readonly sessionId: string }
export interface LayerRequest extends SessionRequest { readonly layer: MemoryLayer }
export interface EnableRequest extends LayerRequest { readonly workspaceId?: WorkspaceId }
export interface ScopeRequest { readonly scope: MemoryScope }
export interface ReadRequest extends ScopeRequest { readonly id: MemoryId }
export interface WriteRequest extends ScopeRequest {
  readonly category: MemoryCategory
  readonly summary: string
  readonly detail: string
  readonly sessionId?: string
}
export interface CorrectRequest extends WriteRequest { readonly id: MemoryId }
export interface ConsolidateMemoryResult {
  readonly intentId: string
  readonly written: number
}

export interface SessionLayerView {
  readonly enabled: boolean
  readonly desiredRevision: number | null
  readonly committedRevision: number | null
  readonly pending: number
  readonly lastTokens: number
  readonly committedTokens: number
}
export interface SessionStateView extends Omit<SessionMemoryState, 'layers' | 'workspaceId' | 'selectedWorkspaceId' | 'activeDesired'> {
  readonly workspaceId?: WorkspaceId
  readonly selectedWorkspaceId?: WorkspaceId
  readonly layers: Record<MemoryLayer, SessionLayerView>
}
export interface MemoryStatus extends MemoryMeta { readonly writable: boolean }
export type MemoryRetentionDays = Readonly<Record<MemoryCategory, number>>
export interface MemorySettings {
  readonly reviewEveryUserTurns: number
  readonly idleDelayMinutes: number
  readonly consolidationCooldownHours: number
  readonly globalConsolidationCooldownDays: number
  /** Estimated-token budget used when creating new memory snapshots. */
  readonly snapshotTokenBudget: number
  /** Days since last verification; zero disables category-based expiry. */
  readonly retentionDays: MemoryRetentionDays
}
export interface WorkspaceView {
  readonly id: WorkspaceId
  readonly title: string
}

export type RpcPayload = SessionRequest | LayerRequest | EnableRequest | ScopeRequest | ReadRequest | WriteRequest | CorrectRequest | MemorySettings | Record<string, never>
export type RpcValue = SessionStateView | MemoryOperationResult | MemoryIndex | MemoryEntry | { removed: boolean } | PromoteMemoryResult | ConsolidateMemoryResult | MemoryStatus | MemorySettings | WorkspaceView[]
