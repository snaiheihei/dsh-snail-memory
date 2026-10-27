import type {
  CorrectRequest, LayerRequest, MemoryStatus, ReadRequest, ScopeRequest, SessionRequest,
  SessionStateView, WriteRequest, RpcPayload, RpcValue, RpcMethod,
} from '../contract.js'
import type { MemoryContextService, InjectionAgent, MemoryOperationResult } from '../context/service.js'
import { pendingInjection, type MemoryStore } from '../store/store.js'
import { workspaceId, type MemoryEntry, type MemoryId, type MemoryIndex, type MemoryScope, type UpsertMemoryInput, type WorkspaceId } from '../store/types.js'
import { prepareMemoryCandidate } from '../safety/index.js'
import { MemoryApiError, safeError } from './errors.js'

export interface ResolvedSession {
  readonly agent: InjectionAgent
  readonly workspaceId?: WorkspaceId
}
export interface MemoryWriteLifecycle {
  remember(input: UpsertMemoryInput): Promise<MemoryEntry>
  correct(input: UpsertMemoryInput & { id: MemoryId }): Promise<MemoryEntry>
  forget(scope: MemoryScope, id: MemoryId): Promise<boolean>
}
export interface MemoryControllerOptions {
  readonly resolveSession: (sessionId: string) => ResolvedSession | undefined
  readonly isWorkspace?: (workspaceId: string) => boolean
  readonly lifecycle?: MemoryWriteLifecycle
  readonly now?: () => Date
}

export class MemoryController {
  private readonly now: () => Date

  constructor(
    private readonly store: MemoryStore,
    private readonly context: MemoryContextService,
    private readonly options: MemoryControllerOptions,
  ) {
    this.now = options.now ?? (() => new Date())
  }

  workspaceForSession(sessionId: string): WorkspaceId | undefined {
    return this.store.getSessionState(sessionId).workspaceId ?? this.options.resolveSession(sessionId)?.workspaceId
  }

  call(method: 'getSessionState', payload: SessionRequest): Promise<SessionStateView>
  call(method: 'enable' | 'refresh', payload: LayerRequest): Promise<MemoryOperationResult>
  call(method: 'list', payload: ScopeRequest): Promise<MemoryIndex>
  call(method: 'read', payload: ReadRequest): Promise<MemoryEntry>
  call(method: 'remove', payload: ReadRequest): Promise<{ removed: boolean }>
  call(method: 'remember', payload: WriteRequest): Promise<MemoryEntry>
  call(method: 'correct', payload: CorrectRequest): Promise<MemoryEntry>
  call(method: 'status', payload: Record<string, never>): Promise<MemoryStatus>
  call(method: RpcMethod, payload: RpcPayload): Promise<RpcValue>
  async call(method: RpcMethod, payload: RpcPayload): Promise<RpcValue> {
    try {
      switch (method) {
        case 'getSessionState': return this.sessionState((payload as SessionRequest).sessionId)
        case 'enable': return await this.enable(payload as LayerRequest, false)
        case 'refresh': return await this.enable(payload as LayerRequest, true)
        case 'list': return this.list((payload as ScopeRequest).scope)
        case 'read': return await this.readMemory(payload as ReadRequest)
        case 'remove': return { removed: await this.forget(payload as ReadRequest) }
        case 'remember': return await this.writeMemory(payload as WriteRequest, false)
        case 'correct': return await this.writeMemory(payload as CorrectRequest, true)
        case 'status': return { writable: this.store.writable, ...this.store.getMeta() }
      }
    } catch (error) {
      throw safeError(error)
    }
  }

  private sessionState(sessionId: string): SessionStateView {
    const state = this.store.getSessionState(sessionId)
    const resolvedWorkspace = state.workspaceId ?? this.options.resolveSession(sessionId)?.workspaceId
    const layerView = (layer: 'global' | 'workspace') => {
      const value = state.layers[layer]
      const committed = value.committed
      return {
        enabled: value.enabled,
        desiredRevision: value.desired.at(-1)?.revision ?? null,
        committedRevision: committed.at(-1)?.revision ?? null,
        pending: pendingInjection(state, layer).length,
        lastTokens: committed.at(-1)?.tokens ?? 0,
        committedTokens: committed.reduce((total, item) => total + item.tokens, 0),
      }
    }
    return {
      sessionId,
      ...(resolvedWorkspace ? { workspaceId: resolvedWorkspace } : {}),
      layers: { global: layerView('global'), workspace: layerView('workspace') },
    }
  }

  private async enable(payload: LayerRequest, refresh: boolean): Promise<MemoryOperationResult> {
    const resolved = this.options.resolveSession(payload.sessionId)
    if (!resolved) throw new MemoryApiError('session-not-found', 'The session is not live.', 404)
    return refresh
      ? this.context.refresh(resolved.agent, payload.layer)
      : this.context.enable(resolved.agent, payload.layer, resolved.workspaceId)
  }

  private list(scope: MemoryScope): MemoryIndex {
    this.assertWorkspace(scope)
    return this.store.list(scope)
  }

  private async readMemory(request: ReadRequest): Promise<MemoryEntry> {
    this.assertWorkspace(request.scope)
    const entry = await this.store.read(request.scope, request.id)
    if (!entry) throw new MemoryApiError('memory-not-found', 'The memory entry does not exist.', 404)
    return entry
  }

  private async writeMemory(request: WriteRequest | CorrectRequest, correction: boolean): Promise<MemoryEntry> {
    this.assertWorkspace(request.scope)
    const clean = (text: string) => prepareMemoryCandidate(text, { source: 'explicit', mode: 'explicit' }).text
    const input = {
      scope: request.scope,
      category: request.category,
      summary: clean(request.summary),
      detail: clean(request.detail),
      sourceRefs: request.sessionId ? [{ sessionId: request.sessionId }] : [],
      lastVerifiedAt: this.now().toISOString(),
    }
    if (correction) {
      const corrected = { ...input, id: (request as CorrectRequest).id }
      return this.options.lifecycle ? this.options.lifecycle.correct(corrected) : this.store.upsert(corrected)
    }
    return this.options.lifecycle ? this.options.lifecycle.remember(input) : this.store.upsert(input)
  }

  private async forget(request: ReadRequest): Promise<boolean> {
    this.assertWorkspace(request.scope)
    return this.options.lifecycle
      ? this.options.lifecycle.forget(request.scope, request.id)
      : this.store.remove(request.scope, request.id)
  }

  private assertWorkspace(scope: MemoryScope): void {
    if (scope.kind === 'workspace' && this.options.isWorkspace && !this.options.isWorkspace(scope.workspaceId)) {
      throw new MemoryApiError('workspace-not-found', 'The workspace does not exist.', 404)
    }
  }
}

export { workspaceId }
