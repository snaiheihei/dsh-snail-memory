import type {
  ConsolidateMemoryResult, CorrectRequest, EnableRequest, LayerRequest, MemorySettings, MemoryStatus, ReadRequest, ScopeRequest, SessionRequest,
  SessionStateView, WorkspaceView, WriteRequest, RpcPayload, RpcValue, RpcMethod, MemoryOperationResult,
} from '../contract.js'
import type { MemoryContextService, InjectionAgent } from '../context/service.js'
import type { LifecycleIntentRunResult } from '../lifecycle/activity.js'
import { pendingInjection, type MemoryStore } from '../store/store.js'
import type { MemoryEntry, MemoryId, MemoryIndex, MemoryScope, PromoteMemoryResult, UpsertMemoryInput, WorkspaceId } from '../store/types.js'
import { prepareMemoryCandidate } from '../safety/index.js'
import { MemoryApiError, safeError } from './errors.js'

export interface ResolvedSession {
  readonly agent: InjectionAgent
  readonly workspaceId?: WorkspaceId
}
export interface MemoryWriteLifecycle {
  remember(input: UpsertMemoryInput): Promise<MemoryEntry>
  correct(input: UpsertMemoryInput & { id: MemoryId }): Promise<MemoryEntry>
  promote(scope: MemoryScope, id: MemoryId): Promise<PromoteMemoryResult>
  forget(scope: MemoryScope, id: MemoryId): Promise<boolean>
}
export interface MemorySettingsLifecycle {
  getSettings(): MemorySettings
  updateSettings(settings: MemorySettings): Promise<MemorySettings>
}
export interface MemoryConsolidationLifecycle {
  consolidateNow(scope: MemoryScope): Promise<LifecycleIntentRunResult>
}

export interface MemoryControllerOptions {
  readonly resolveSession: (sessionId: string) => ResolvedSession | undefined
  readonly isWorkspace?: (workspaceId: string) => boolean
  readonly lifecycle?: MemoryWriteLifecycle
  readonly settings?: MemorySettingsLifecycle
  readonly consolidation?: MemoryConsolidationLifecycle
  readonly listWorkspaces?: () => readonly WorkspaceView[]
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
  call(method: 'disable', payload: SessionRequest): Promise<MemoryOperationResult>
  call(method: 'enable', payload: EnableRequest): Promise<MemoryOperationResult>
  call(method: 'refresh', payload: LayerRequest): Promise<MemoryOperationResult>
  call(method: 'list', payload: ScopeRequest): Promise<MemoryIndex>
  call(method: 'consolidate', payload: ScopeRequest): Promise<ConsolidateMemoryResult>
  call(method: 'read', payload: ReadRequest): Promise<MemoryEntry>
  call(method: 'remove', payload: ReadRequest): Promise<{ removed: boolean }>
  call(method: 'promote', payload: ReadRequest): Promise<PromoteMemoryResult>
  call(method: 'remember', payload: WriteRequest): Promise<MemoryEntry>
  call(method: 'correct', payload: CorrectRequest): Promise<MemoryEntry>
  call(method: 'status', payload: Record<string, never>): Promise<MemoryStatus>
  call(method: 'getSettings', payload: Record<string, never>): Promise<MemorySettings>
  call(method: 'updateSettings', payload: MemorySettings): Promise<MemorySettings>
  call(method: 'listWorkspaces', payload: Record<string, never>): Promise<WorkspaceView[]>
  call(method: RpcMethod, payload: RpcPayload): Promise<RpcValue>
  async call(method: RpcMethod, payload: RpcPayload): Promise<RpcValue> {
    try {
      switch (method) {
        case 'getSessionState': return this.sessionState((payload as SessionRequest).sessionId)
        case 'enable': return await this.enable(payload as LayerRequest, false)
        case 'disable': return await this.disable((payload as SessionRequest).sessionId)
        case 'refresh': return await this.enable(payload as LayerRequest, true)
        case 'list': return this.list((payload as ScopeRequest).scope)
        case 'consolidate': return await this.consolidate((payload as ScopeRequest).scope)
        case 'read': return await this.readMemory(payload as ReadRequest)
        case 'remove': return { removed: await this.forget(payload as ReadRequest) }
        case 'promote': return await this.promote(payload as ReadRequest)
        case 'remember': return await this.writeMemory(payload as WriteRequest, false)
        case 'correct': return await this.writeMemory(payload as CorrectRequest, true)
        case 'status': return { writable: this.store.writable, ...this.store.getMeta() }
        case 'getSettings': return this.settings().getSettings()
        case 'updateSettings': return await this.settings().updateSettings(payload as MemorySettings)
        case 'listWorkspaces': return [...(this.options.listWorkspaces?.() ?? [])]
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
      const selected = layer === 'workspace' ? state.selectedWorkspaceId : undefined
      const desired = selected === undefined ? value.desired : value.desired.filter(item => (item.workspaceId ?? state.workspaceId) === selected)
      const committed = selected === undefined ? value.committed : value.committed.filter(item => (item.workspaceId ?? state.workspaceId) === selected)
      return {
        enabled: value.enabled,
        desiredRevision: desired.at(-1)?.revision ?? null,
        committedRevision: committed.at(-1)?.revision ?? null,
        pending: pendingInjection(state, layer).length,
        lastTokens: committed.at(-1)?.tokens ?? 0,
        committedTokens: value.committed.reduce((total, item) => total + item.tokens, 0),
      }
    }
    return {
      sessionId,
      ...(resolvedWorkspace ? { workspaceId: resolvedWorkspace } : {}),
      ...(state.selectedWorkspaceId ? { selectedWorkspaceId: state.selectedWorkspaceId } : {}),
      layers: { global: layerView('global'), workspace: layerView('workspace') },
    }
  }

  private async enable(payload: EnableRequest, refresh: boolean): Promise<MemoryOperationResult> {
    const resolved = this.options.resolveSession(payload.sessionId)
    if (!resolved) throw new MemoryApiError('session-not-found', 'The session is not live.', 404)
    if (refresh) return this.context.refresh(resolved.agent, payload.layer)
    if (payload.layer === 'global') return this.context.enable(resolved.agent, payload.layer)
    const selectedWorkspaceId = payload.workspaceId ?? resolved.workspaceId
    if (!selectedWorkspaceId) {
      throw new MemoryApiError('workspace-required', 'Select a registered workspace to enable workspace memory.', 400)
    }
    this.assertWorkspace({ kind: 'workspace', workspaceId: selectedWorkspaceId })
    return this.context.enable(resolved.agent, payload.layer, selectedWorkspaceId)
  }

  private async disable(sessionId: string): Promise<MemoryOperationResult> {
    const resolved = this.options.resolveSession(sessionId)
    if (!resolved) throw new MemoryApiError('session-not-found', 'The session is not live.', 404)
    return this.context.disable(resolved.agent)
  }

  private list(scope: MemoryScope): MemoryIndex {
    this.assertWorkspace(scope, true)
    return this.store.list(scope)
  }

  private async consolidate(scope: MemoryScope): Promise<ConsolidateMemoryResult> {
    this.assertWorkspace(scope, true)
    if (!this.options.consolidation) {
      throw new MemoryApiError('invalid-operation', 'Manual memory consolidation is unavailable.', 409)
    }
    const result = await this.options.consolidation.consolidateNow(scope)
    return { intentId: result.intentId, written: result.written }
  }

  private async readMemory(request: ReadRequest): Promise<MemoryEntry> {
    this.assertWorkspace(request.scope, true)
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
    this.assertWorkspace(request.scope, true)
    return this.options.lifecycle
      ? this.options.lifecycle.forget(request.scope, request.id)
      : this.store.remove(request.scope, request.id)
  }

  private async promote(request: ReadRequest): Promise<PromoteMemoryResult> {
    this.assertWorkspace(request.scope)
    return this.options.lifecycle
      ? this.options.lifecycle.promote(request.scope, request.id)
      : this.store.promote(request.scope, request.id)
  }

  private assertWorkspace(scope: MemoryScope, allowGlobal = false): void {
    if (scope.kind === 'global' && !allowGlobal) {
      throw new MemoryApiError('invalid-operation', 'Direct global writes are unavailable; promote a workspace memory instead.', 409)
    }
    if (scope.kind === 'workspace' && this.options.isWorkspace && !this.options.isWorkspace(scope.workspaceId)) {
      throw new MemoryApiError('workspace-not-found', 'The workspace does not exist.', 404)
    }
  }

  private settings(): MemorySettingsLifecycle {
    if (!this.options.settings) throw new MemoryApiError('invalid-operation', 'Lifecycle settings are unavailable.', 409)
    return this.options.settings
  }
}
