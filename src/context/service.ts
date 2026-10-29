import { randomUUID } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import './message-source.js'
import { activeInjection, type MemoryStore } from '../store/store.js'
import type {
  DesiredInjection,
  MemoryEntry,
  MemoryFeedbackOutcome,
  MemoryFeedbackResult,
  MemoryId,
  MemoryIndex,
  MemoryLayer,
  MemoryScope,
  SessionMemoryState,
  WorkspaceId,
} from '../store/types.js'
import { estimateTokens, renderSnapshotWithIds, snapshotMetadata, type SnapshotMetadata } from './snapshot.js'

export interface InjectionInbox {
  readonly nextTurn: readonly UserMessage[]
  readonly nextStep: readonly UserMessage[]
  replace(messageId: UserMessage['id'], newMessage: UserMessage): boolean
  remove(messageId: UserMessage['id']): boolean
}

export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

export interface InjectionAgent {
  readonly session: {
    readonly id: string
    snapshotEvents?(): readonly SessionEventLike[]
  }
  readonly inbox: InjectionInbox
  inject(message: UserMessage): void
}

export type PreStepDecision =
  | { readonly kind: 'reject' }
  | {
    readonly kind: 'enter'
    readonly messages: UserMessage[]
    readonly startsRequestSeries?: true
  }

export interface PreStepInput {
  readonly messages: UserMessage[]
  readonly turn: number
  readonly step: number
}

export interface MemoryContextOptions {
  readonly now?: () => Date
  readonly maxSnapshotTokens?: number
  readonly getSnapshotTokenBudget?: () => number
}

export interface MemoryOperationResult {
  readonly status: 'enabled' | 'already-enabled' | 'refreshed' | 'up-to-date' | 'disabled'
  readonly injectionId?: string
}

interface AdmittedInjection extends SnapshotMetadata {
  readonly turn: number
}

export class MemoryContextService {
  private readonly now: () => Date
  private readonly getSnapshotTokenBudget: () => number
  private readonly queued = new Set<string>()
  private readonly turnAdmissions = new Map<string, { readonly turn: number; readonly injectionId: string }>()
  private readonly admittedInjections = new Map<string, AdmittedInjection>()

  constructor(readonly store: MemoryStore, options: MemoryContextOptions) {
    this.now = options.now ?? (() => new Date())
    const fallback = options.maxSnapshotTokens ?? 1_200
    this.getSnapshotTokenBudget = options.getSnapshotTokenBudget ?? (() => fallback)
  }

  getSessionState(sessionId: string): SessionMemoryState {
    return this.store.getSessionState(sessionId)
  }

  async enable(agent: InjectionAgent, layer: MemoryLayer, workspaceId?: WorkspaceId): Promise<MemoryOperationResult> {
    const sessionId = agent.session.id
    const scope = this.scopeFor(sessionId, layer, workspaceId)
    const before = this.store.getSessionState(sessionId)
    const sameWorkspace = layer === 'global' || (scope.kind === 'workspace'
      && (before.selectedWorkspaceId ?? before.workspaceId) === scope.workspaceId)
    if (before.layers[layer].enabled && sameWorkspace) {
      await this.restore(agent)
      return { status: 'already-enabled' }
    }
    const desired = this.createDesired(layer, scope, true)
    await this.store.updateSessionState(sessionId, state => {
      if (scope.kind === 'workspace') state.selectedWorkspaceId = scope.workspaceId
      for (const candidate of ['global', 'workspace'] as const) {
        state.layers[candidate].enabled = candidate === layer
      }
      state.layers[layer].desired.push(desired)
      state.activeDesired = { layer, injectionId: desired.injectionId }
    })
    await this.restore(agent)
    return { status: 'enabled', injectionId: desired.injectionId }
  }

  async disable(agent: InjectionAgent): Promise<MemoryOperationResult> {
    await this.store.updateSessionState(agent.session.id, state => {
      state.layers.global.enabled = false
      state.layers.workspace.enabled = false
      state.activeDesired = null
    })
    await this.restore(agent)
    return { status: 'disabled' }
  }

  async refresh(agent: InjectionAgent, layer: MemoryLayer): Promise<MemoryOperationResult> {
    const sessionId = agent.session.id
    const state = this.store.getSessionState(sessionId)
    if (!state.layers[layer].enabled) throw new Error('Cannot refresh a disabled memory layer; enable it first')
    const scope = this.scopeFor(sessionId, layer)
    const index = this.store.list(scope)
    const scopedDesired = state.layers[layer].desired.filter(item =>
      scope.kind === 'global' || (item.workspaceId ?? state.workspaceId) === scope.workspaceId)
    const latest = Math.max(0, ...scopedDesired.map(item => item.revision))
    if (index.revision <= latest) {
      await this.restore(agent)
      return { status: 'up-to-date' }
    }
    const desired = this.createDesired(layer, scope, false, index)
    await this.store.updateSessionState(sessionId, current => {
      current.layers[layer].desired.push(desired)
      current.activeDesired = { layer, injectionId: desired.injectionId }
    })
    await this.restore(agent)
    return { status: 'refreshed', injectionId: desired.injectionId }
  }

  async restore(agent: InjectionAgent): Promise<void> {
    // Session commit is authoritative even if the process died before committed state was persisted.
    const sessionId = agent.session.id
    const committedInSession = new Set<string>()
    for (const event of agent.session.snapshotEvents?.() ?? []) {
      if (event.type !== 'user/message' || !event.data || typeof event.data !== 'object') continue
      const message = event.data as UserMessage
      const metadata = snapshotMetadata(message)
      if (!metadata) continue
      committedInSession.add(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
      if (this.store.writable) await this.commitInjection(sessionId, message, metadata, false)
    }

    let active = activeInjection(this.store.getSessionState(sessionId))
    if (active && committedInSession.has(this.queueKey(sessionId, active.layer, active.desired.injectionId))) {
      // A secondary read-only Host cannot persist the reconciliation, but it must still avoid duplicate injection.
      active = null
    }
    const activeMessage = active ? this.messageFor(active.desired) : null
    let activePending = false
    const pending = [...agent.inbox.nextStep, ...agent.inbox.nextTurn]
    for (const message of pending) {
      const metadata = snapshotMetadata(message)
      if (!metadata) continue
      const matchesActive = active !== null && metadata.injectionId === active.desired.injectionId
        && metadata.layer === active.layer
      if (matchesActive && !activePending) {
        activePending = true
        this.queued.add(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
        continue
      }
      // Replace the first stale item in place so the new snapshot stays before the next user prompt.
      if (activeMessage && !activePending && agent.inbox.replace(message.id, activeMessage)) {
        activePending = true
        this.queued.delete(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
        this.queued.add(this.queueKey(sessionId, active!.layer, active!.desired.injectionId))
        continue
      }
      if (agent.inbox.remove(message.id)) {
        this.queued.delete(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
      }
    }
    if (active && activeMessage && !activePending) {
      agent.inject(activeMessage)
      this.queued.add(this.queueKey(sessionId, active.layer, active.desired.injectionId))
    }
  }

  async handlePreStep(
    agent: InjectionAgent,
    input: PreStepInput,
    next: () => Promise<PreStepDecision>,
  ): Promise<PreStepDecision> {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const sessionId = agent.session.id
    const active = activeInjection(this.store.getSessionState(sessionId))
    const previous = this.turnAdmissions.get(sessionId)
    const canAdmit = previous?.turn !== input.turn
    let admitted: SnapshotMetadata | null = null
    const messages = decision.messages.filter(message => {
      const metadata = snapshotMetadata(message)
      if (!metadata) return true
      const matchesActive = canAdmit && active !== null && admitted === null
        && metadata.injectionId === active.desired.injectionId && metadata.layer === active.layer
      if (matchesActive) {
        admitted = metadata
        return true
      }
      this.queued.delete(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
      return false
    })
    if (admitted) {
      const metadata: SnapshotMetadata = admitted
      this.turnAdmissions.set(sessionId, { turn: input.turn, injectionId: metadata.injectionId })
      this.admittedInjections.set(this.admissionKey(sessionId, metadata.injectionId), { ...metadata, turn: input.turn })
    }
    return { ...decision, messages }
  }

  async handleSessionEvent(sessionId: string, event: SessionEventLike): Promise<boolean> {
    if (event.type !== 'user/message' || !event.data || typeof event.data !== 'object') return false
    const message = event.data as UserMessage
    const metadata = snapshotMetadata(message)
    if (!metadata) return false
    return this.commitInjection(sessionId, message, metadata, true)
  }

  handleDiscarded(sessionId: string, message: UserMessage): void {
    const metadata = snapshotMetadata(message)
    if (metadata) this.queued.delete(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
  }

  async readDetail(sessionId: string, layer: MemoryLayer, id: MemoryId): Promise<MemoryEntry | null> {
    const state = this.store.getSessionState(sessionId)
    if (!state.layers[layer].enabled) return null
    return this.store.read(this.scopeFor(sessionId, layer), id)
  }

  async recordFeedback(
    sessionId: string,
    layer: MemoryLayer,
    id: MemoryId,
    outcome: MemoryFeedbackOutcome,
  ): Promise<MemoryFeedbackResult> {
    return this.store.recordFeedback({ sessionId, layer, memoryId: id, outcome })
  }

  private async commitInjection(
    sessionId: string,
    message: UserMessage,
    metadata: SnapshotMetadata,
    requireAdmission: boolean,
  ): Promise<boolean> {
    const admissionKey = this.admissionKey(sessionId, metadata.injectionId)
    if (requireAdmission && !this.admittedInjections.has(admissionKey)) return false
    const before = this.store.getSessionState(sessionId).layers[metadata.layer]
    if (!before.desired.some(item => item.injectionId === metadata.injectionId)
      || before.committed.some(item => item.injectionId === metadata.injectionId)) return false
    const text = message.content.find(block => block.type === 'text')?.text
    let committed = false
    await this.store.updateSessionState(sessionId, current => {
      const layer = current.layers[metadata.layer]
      const desired = layer.desired.find(item => item.injectionId === metadata.injectionId)
      if (!desired || layer.committed.some(item => item.injectionId === metadata.injectionId)) return
      layer.committed.push({
        injectionId: metadata.injectionId,
        revision: metadata.revision,
        ...(desired.workspaceId === undefined ? {} : { workspaceId: desired.workspaceId }),
        ...(desired.memoryIds === undefined ? {} : { memoryIds: [...desired.memoryIds] }),
        tokens: estimateTokens(text ?? desired.snapshot),
        committedAt: this.now().toISOString(),
      })
      if (current.activeDesired?.injectionId === metadata.injectionId) current.activeDesired = null
      committed = true
    })
    if (committed) {
      this.queued.delete(this.queueKey(sessionId, metadata.layer, metadata.injectionId))
      this.admittedInjections.delete(admissionKey)
    }
    return committed
  }

  private scopeFor(sessionId: string, layer: MemoryLayer, workspaceId?: WorkspaceId): MemoryScope {
    if (layer === 'global') return { kind: 'global' }
    const state = this.store.getSessionState(sessionId)
    const resolved = workspaceId ?? state.selectedWorkspaceId ?? state.workspaceId
    if (!resolved) throw new Error('Select a workspace before enabling workspace memory')
    return { kind: 'workspace', workspaceId: resolved }
  }

  private createDesired(
    layer: MemoryLayer,
    scope: MemoryScope,
    automatic: boolean,
    index: MemoryIndex = this.store.list(scope),
  ): DesiredInjection {
    const injectionId = randomUUID()
    const createdAt = this.now().toISOString()
    const rendered = renderSnapshotWithIds({
      injectionId,
      layer,
      scope,
      index,
      automatic,
      now: new Date(createdAt),
      maxTokens: this.getSnapshotTokenBudget(),
    })
    return {
      injectionId,
      revision: index.revision,
      ...(scope.kind === 'workspace' ? { workspaceId: scope.workspaceId } : {}),
      snapshot: rendered.snapshot,
      memoryIds: rendered.memoryIds,
      createdAt,
      automatic,
    }
  }

  private messageFor(desired: DesiredInjection): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: desired.snapshot }],
      source: { kind: 'snail-memory' },
    })
  }

  private queueKey(sessionId: string, layer: MemoryLayer, injectionId: string): string {
    return `${sessionId}:${layer}:${injectionId}`
  }

  private admissionKey(sessionId: string, injectionId: string): string {
    return `${sessionId}:${injectionId}`
  }
}
