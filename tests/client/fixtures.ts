import type { SessionStateView } from '../../src/contract.js'
import type { MemoryEntry, MemoryIndex, MemoryScope, WorkspaceId } from '../../src/store/types.js'
import type { MemoryRpc, RpcRequestMap, RpcResponseMap } from '../../client/src/rpc.js'
import type { MemoryRpcMethod } from '../../client/src/rpc.js'
import type { MemoryTranslator } from '../../client/src/locale.js'
import { translator } from '../../client/src/locale.js'

export const GLOBAL_SCOPE: MemoryScope = { kind: 'global' }
export const WORKSPACE = 'workspace-1' as WorkspaceId
export const WORKSPACE_SCOPE: MemoryScope = { kind: 'workspace', workspaceId: WORKSPACE }

export function sessionState(sessionId = 'session-1', enabled = false): SessionStateView {
  return {
    sessionId,
    workspaceId: WORKSPACE,
    layers: {
      global: layer(enabled, 12),
      workspace: layer(false, 8),
    },
  }
}

export function layer(enabled: boolean, committedTokens = 0) {
  return {
    enabled,
    desiredRevision: enabled ? 2 : null,
    committedRevision: enabled ? 1 : null,
    pending: 0,
    lastTokens: enabled ? committedTokens : 0,
    committedTokens,
  }
}

export const ENTRY: MemoryEntry = {
  id: 'memory-1' as MemoryEntry['id'],
  scope: GLOBAL_SCOPE,
  category: 'project-convention',
  summary: 'Use pnpm workspaces',
  detail: 'All packages use the workspace protocol for local dependencies.',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T03:04:05.000Z',
  lastVerifiedAt: '2026-01-02T03:04:05.000Z',
  revision: 2,
  sourceRefs: [{ sessionId: 'session-1', eventSeqs: [3, 4] }],
}

export function memoryIndex(scope: MemoryScope = GLOBAL_SCOPE): MemoryIndex {
  return {
    scope,
    revision: 2,
    entries: [{ ...ENTRY, scope }],
    workspaces: [],
  }
}

export class FakeRpc implements MemoryRpc {
  readonly calls: Array<{ method: MemoryRpcMethod; payload: unknown }> = []
  readonly handlers = new Map<MemoryRpcMethod, (payload: never) => unknown>()

  on<M extends MemoryRpcMethod>(method: M, handler: (payload: RpcRequestMap[M]) => RpcResponseMap[M] | Promise<RpcResponseMap[M]>): this {
    this.handlers.set(method, handler as (payload: never) => unknown)
    return this
  }

  async call<M extends MemoryRpcMethod>(method: M, payload: RpcRequestMap[M]): Promise<RpcResponseMap[M]> {
    this.calls.push({ method, payload })
    const handler = this.handlers.get(method)
    if (handler === undefined) throw new Error(`Unexpected RPC: ${method}`)
    return await handler(payload as never) as RpcResponseMap[M]
  }

  count(method: MemoryRpcMethod): number {
    return this.calls.filter(call => call.method === method).length
  }
}

export const t: MemoryTranslator = translator('en')
export const zhT: MemoryTranslator = translator('zh')

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
