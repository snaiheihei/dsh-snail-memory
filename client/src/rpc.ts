import type {
  CorrectRequest, LayerRequest, MemorySettings, MemoryStatus, ReadRequest, RpcMethod, RpcResult, ScopeRequest,
  SessionRequest, SessionStateView, WorkspaceView, WriteRequest,
} from '../../src/contract.js'
import type { MemoryEntry, MemoryIndex } from '../../src/store/types.js'

export type MemoryRpcMethod = RpcMethod
export interface MemoryOperationResult {
  readonly status: 'enabled' | 'already-enabled' | 'refreshed' | 'up-to-date'
  readonly injectionId?: string
}

export interface RpcRequestMap {
  readonly getSessionState: SessionRequest
  readonly enable: LayerRequest
  readonly refresh: LayerRequest
  readonly list: ScopeRequest
  readonly read: ReadRequest
  readonly remove: ReadRequest
  readonly remember: WriteRequest
  readonly correct: CorrectRequest
  readonly status: Record<string, never>
  readonly getSettings: Record<string, never>
  readonly updateSettings: MemorySettings
  readonly listWorkspaces: Record<string, never>
}

export interface RpcResponseMap {
  readonly getSessionState: SessionStateView
  readonly enable: MemoryOperationResult
  readonly refresh: MemoryOperationResult
  readonly list: MemoryIndex
  readonly read: MemoryEntry
  readonly remove: { readonly removed: boolean }
  readonly remember: MemoryEntry
  readonly correct: MemoryEntry
  readonly status: MemoryStatus
  readonly getSettings: MemorySettings
  readonly updateSettings: MemorySettings
  readonly listWorkspaces: WorkspaceView[]
}

export interface MemoryRpc {
  call<M extends MemoryRpcMethod>(method: M, payload: RpcRequestMap[M]): Promise<RpcResponseMap[M]>
}

export class MemoryRpcError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message)
    this.name = 'MemoryRpcError'
  }
}

export function createMemoryRpc(fetcher: typeof fetch): MemoryRpc {
  return {
    async call<M extends MemoryRpcMethod>(method: M, payload: RpcRequestMap[M]): Promise<RpcResponseMap[M]> {
      const response = await fetcher(`/snail-memory/rpc/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-snail-memory': '1' },
        body: JSON.stringify(payload),
      })
      let envelope: RpcResult<RpcResponseMap[M]>
      try {
        envelope = await response.json() as RpcResult<RpcResponseMap[M]>
      } catch {
        throw new MemoryRpcError('The Host returned malformed JSON.', 'invalid-response', response.status)
      }
      if (typeof envelope !== 'object' || envelope === null || typeof envelope.ok !== 'boolean') {
        throw new MemoryRpcError('The Host returned an invalid RPC envelope.', 'invalid-response', response.status)
      }
      if (!envelope.ok) {
        const error = envelope.error
        if (typeof error?.code !== 'string' || typeof error.message !== 'string') {
          throw new MemoryRpcError('The Host returned an invalid RPC error.', 'invalid-response', response.status)
        }
        throw new MemoryRpcError(error.message, error.code, response.status)
      }
      if (!response.ok || !('value' in envelope)) {
        throw new MemoryRpcError('The Host returned an invalid RPC response.', 'invalid-response', response.status)
      }
      return envelope.value
    },
  }
}
