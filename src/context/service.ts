import { randomUUID } from 'node:crypto'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import './message-source.js'
import { pendingInjection, type MemoryStore } from '../store/store.js'
import type {
  MemoryEntry,
  MemoryId,
  MemoryLayer,
  MemoryScope,
  SessionMemoryState,
  WorkspaceId,
} from '../store/types.js'
import { estimateTokens, renderSnapshot, snapshotMetadata } from './snapshot.js'

export interface InjectionAgent {
  readonly session: { readonly id: string }
  inject(message: UserMessage): void
}

export interface SessionEventLike {
  readonly type: string
  readonly data: unknown
}

export interface MemoryContextOptions {
  readonly now?: () => Date
  readonly maxSnapshotTokens?: number
}

export interface MemoryOperationResult {
  readonly status: 'enabled' | 'already-enabled' | 'refreshed' | 'up-to-date'
  readonly injectionId?: string
}

export class MemoryContextService {
  private readonly now: () => Date
  private readonly maxSnapshotTokens: number
  private readonly queued = new Set<string>()

  constructor(readonly store: MemoryStore, options: MemoryContextOptions) {
    this.now = options.now ?? (() => new Date())
    this.maxSnapshotTokens = options.maxSnapshotTokens ?? 1_200
  }

  getSessionState(sessionId: string): SessionMemoryState {
    return this.store.getSessionState(sessionId)
  }

  async enable(agent: InjectionAgent, layer: MemoryLayer, workspaceId?: WorkspaceId): Promise<MemoryOperationResult> {
    const sessionId = agent.session.id
    const before = this.store.getSessionState(sessionId)
    if (before.layers[layer].enabled) {
      await this.restore(agent)
      return { status: 'already-enabled' }
    }
    const scope = this.scopeFor(sessionId, layer, workspaceId)
    await this.store.updateSessionState(sessionId, state => {
      if (scope.kind === 'workspace') state.workspaceId = scope.workspaceId
      state.layers[layer].enabled = true
    })
    if (!before.layers[layer].desired.some(item => item.automatic)) {
      await this.createDesired(agent, layer, scope, true)
    }
    await this.restore(agent)
    return { status: 'enabled' }
  }

  async refresh(agent: InjectionAgent, layer: MemoryLayer): Promise<MemoryOperationResult> {
    const sessionId = agent.session.id
    const state = this.store.getSessionState(sessionId)
    if (!state.layers[layer].enabled) throw new Error('Cannot refresh a disabled memory layer; enable it first')
    const scope = this.scopeFor(sessionId, layer)
    const index = this.store.list(scope)
    const latest = Math.max(0, ...state.layers[layer].desired.map(item => item.revision))
    if (index.revision <= latest) {
      await this.restore(agent)
      return { status: 'up-to-date' }
    }
    const desired = await this.createDesired(agent, layer, scope, false)
    await this.restore(agent)
    return { status: 'refreshed', injectionId: desired.injectionId }
  }

  async restore(agent: InjectionAgent): Promise<void> {
    const state = this.store.getSessionState(agent.session.id)
    for (const layer of ['global', 'workspace'] as const) {
      for (const desired of pendingInjection(state, layer)) {
        const key = `${agent.session.id}:${layer}:${desired.injectionId}`
        if (this.queued.has(key)) continue
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: desired.snapshot }],
          source: { kind: 'snail-memory' },
        }))
        this.queued.add(key)
      }
    }
  }

  async handleSessionEvent(sessionId: string, event: SessionEventLike): Promise<boolean> {
    if (event.type !== 'user/message' || !event.data || typeof event.data !== 'object') return false
    const message = event.data as UserMessage
    const metadata = snapshotMetadata(message)
    if (!metadata) return false
    const state = this.store.getSessionState(sessionId)
    const layerState = state.layers[metadata.layer]
    const desired = layerState.desired.find(item => item.injectionId === metadata.injectionId)
    if (!desired || layerState.committed.some(item => item.injectionId === metadata.injectionId)) return false
    const text = message.content.find(block => block.type === 'text')?.text ?? desired.snapshot
    await this.store.updateSessionState(sessionId, current => {
      const currentLayer = current.layers[metadata.layer]
      if (currentLayer.committed.some(item => item.injectionId === metadata.injectionId)) return
      currentLayer.committed.push({
        injectionId: metadata.injectionId,
        revision: metadata.revision,
        tokens: estimateTokens(text),
        committedAt: this.now().toISOString(),
      })
    })
    this.queued.delete(`${sessionId}:${metadata.layer}:${metadata.injectionId}`)
    return true
  }

  handleDiscarded(sessionId: string, message: UserMessage): void {
    const metadata = snapshotMetadata(message)
    if (metadata) this.queued.delete(`${sessionId}:${metadata.layer}:${metadata.injectionId}`)
  }

  readDetail(sessionId: string, layer: MemoryLayer, id: MemoryId): MemoryEntry | null {
    const state = this.store.getSessionState(sessionId)
    if (!state.layers[layer].enabled) return null
    const scope = this.scopeFor(sessionId, layer)
    return this.store.read(scope, id)
  }

  private scopeFor(sessionId: string, layer: MemoryLayer, workspaceId?: WorkspaceId): MemoryScope {
    if (layer === 'global') return { kind: 'global' }
    const resolved = workspaceId ?? this.store.getSessionState(sessionId).workspaceId
    if (!resolved) throw new Error('Workspace memory is unavailable for an Ungrouped session')
    return { kind: 'workspace', workspaceId: resolved }
  }

  private async createDesired(
    agent: InjectionAgent,
    layer: MemoryLayer,
    scope: MemoryScope,
    automatic: boolean,
  ) {
    const injectionId = randomUUID()
    const snapshot = renderSnapshot({
      injectionId,
      layer,
      scope,
      index: this.store.list(scope),
      automatic,
      now: this.now(),
      maxTokens: this.maxSnapshotTokens,
    })
    const desired = {
      injectionId,
      revision: this.store.list(scope).revision,
      snapshot,
      createdAt: this.now().toISOString(),
      automatic,
    }
    await this.store.updateSessionState(agent.session.id, state => {
      state.layers[layer].desired.push(desired)
    })
    return desired
  }
}
