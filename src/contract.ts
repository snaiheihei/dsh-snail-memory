import type {
  MemoryCategory,
  MemoryEntry,
  MemoryId,
  MemoryIndex,
  MemoryLayer,
  MemoryMeta,
  MemoryScope,
  SessionMemoryState,
  WorkspaceId,
} from './store/types.js'
import type { MemoryOperationResult } from './context/service.js'

export const RPC_ROUTE_PREFIX = '/snail-memory/rpc'
export const RPC_METHODS = [
  'getSessionState', 'enable', 'refresh', 'list', 'read', 'remove', 'remember', 'correct', 'status',
] as const

export type RpcMethod = typeof RPC_METHODS[number]
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface SessionRequest { readonly sessionId: string }
export interface LayerRequest extends SessionRequest { readonly layer: MemoryLayer }
export interface ScopeRequest { readonly scope: MemoryScope }
export interface ReadRequest extends ScopeRequest { readonly id: MemoryId }
export interface WriteRequest extends ScopeRequest {
  readonly category: MemoryCategory
  readonly summary: string
  readonly detail: string
  readonly sessionId?: string
}
export interface CorrectRequest extends WriteRequest { readonly id: MemoryId }

export interface SessionLayerView {
  readonly enabled: boolean
  readonly desiredRevision: number | null
  readonly committedRevision: number | null
  readonly pending: number
  readonly lastTokens: number
  readonly committedTokens: number
}
export interface SessionStateView extends Omit<SessionMemoryState, 'layers' | 'workspaceId'> {
  readonly workspaceId?: WorkspaceId
  readonly layers: Record<MemoryLayer, SessionLayerView>
}
export interface MemoryStatus extends MemoryMeta { readonly writable: boolean }

export type RpcPayload = SessionRequest | LayerRequest | ScopeRequest | ReadRequest | WriteRequest | CorrectRequest | Record<string, never>
export type RpcValue = SessionStateView | MemoryOperationResult | MemoryIndex | MemoryEntry | { removed: boolean } | MemoryStatus
