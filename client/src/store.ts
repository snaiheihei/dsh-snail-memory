import type { SessionStateView } from '../../src/contract.js'
import type { MemoryEntry, MemoryId, MemoryIndex, MemoryLayer, MemoryScope } from '../../src/store/types.js'
import type { MemoryOperationResult, MemoryRpc } from './rpc.js'

interface StoreOptions {
  readonly eventTarget?: EventTarget
}

function scopeKey(scope: MemoryScope): string {
  return scope.kind === 'global' ? 'global' : `workspace:${scope.workspaceId}`
}

export class MemoryClientStore {
  private readonly sessions = new Map<string, SessionStateView>()
  private readonly indexes = new Map<string, MemoryIndex>()
  private readonly errors = new Map<string, string>()
  private readonly sessionRequests = new Map<string, number>()
  private readonly indexRequests = new Map<string, number>()
  private readonly trackedSessions = new Set<string>()
  private readonly trackedScopes = new Map<string, MemoryScope>()
  private readonly mutations = new Map<string, Promise<MemoryOperationResult>>()
  private readonly listeners = new Set<() => void>()
  private readonly eventTarget: EventTarget | undefined
  private revision = 0
  private disposed = false

  constructor(private readonly rpc: MemoryRpc, options: StoreOptions = {}) {
    this.eventTarget = options.eventTarget ?? (typeof window === 'undefined' ? undefined : window)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  readonly getSnapshot = (): number => this.revision

  getSession(sessionId: string): SessionStateView | undefined {
    return this.sessions.get(sessionId)
  }

  getIndex(scope: MemoryScope): MemoryIndex | undefined {
    return this.indexes.get(scopeKey(scope))
  }

  getSessionError(sessionId: string): string | undefined {
    return this.errors.get(`session:${sessionId}`)
  }

  getIndexError(scope: MemoryScope): string | undefined {
    return this.errors.get(`index:${scopeKey(scope)}`)
  }

  async loadSession(sessionId: string): Promise<SessionStateView | undefined> {
    if (this.disposed) return undefined
    this.trackedSessions.add(sessionId)
    const request = (this.sessionRequests.get(sessionId) ?? 0) + 1
    this.sessionRequests.set(sessionId, request)
    try {
      const state = await this.rpc.call('getSessionState', { sessionId })
      if (!this.current(this.sessionRequests, sessionId, request)) return undefined
      this.sessions.set(sessionId, state)
      this.errors.delete(`session:${sessionId}`)
      this.publish()
      return state
    } catch (error) {
      if (this.current(this.sessionRequests, sessionId, request)) {
        this.errors.set(`session:${sessionId}`, messageOf(error))
        this.publish()
      }
      return undefined
    }
  }

  async loadIndex(scope: MemoryScope): Promise<MemoryIndex | undefined> {
    if (this.disposed) return undefined
    const key = scopeKey(scope)
    this.trackedScopes.set(key, scope)
    const request = (this.indexRequests.get(key) ?? 0) + 1
    this.indexRequests.set(key, request)
    try {
      const index = await this.rpc.call('list', { scope })
      if (!this.current(this.indexRequests, key, request)) return undefined
      this.indexes.set(key, index)
      this.errors.delete(`index:${key}`)
      this.publish()
      return index
    } catch (error) {
      if (this.current(this.indexRequests, key, request)) {
        this.errors.set(`index:${key}`, messageOf(error))
        this.publish()
      }
      return undefined
    }
  }

  read(scope: MemoryScope, id: MemoryId): Promise<MemoryEntry> {
    return this.rpc.call('read', { scope, id })
  }

  enable(sessionId: string, layer: MemoryLayer): Promise<MemoryOperationResult> {
    return this.mutateLayer('enable', sessionId, layer)
  }

  refresh(sessionId: string, layer: MemoryLayer): Promise<MemoryOperationResult> {
    return this.mutateLayer('refresh', sessionId, layer)
  }

  async remove(scope: MemoryScope, id: MemoryId): Promise<{ readonly removed: boolean }> {
    const result = await this.rpc.call('remove', { scope, id })
    await this.notifyChanged()
    return result
  }

  notifyChanged(): Promise<void> {
    return this.refreshActive()
  }

  listen(): () => void {
    const target = this.eventTarget
    if (target === undefined || this.disposed) return () => {}
    let listening = true
    const onFocus = (): void => { void this.refreshActive() }
    target.addEventListener('focus', onFocus)
    return () => {
      if (!listening) return
      listening = false
      target.removeEventListener('focus', onFocus)
    }
  }

  dispose(): void {
    this.disposed = true
    this.sessionRequests.clear()
    this.indexRequests.clear()
    this.listeners.clear()
  }

  private mutateLayer(method: 'enable' | 'refresh', sessionId: string, layer: MemoryLayer): Promise<MemoryOperationResult> {
    const key = `${method}:${sessionId}:${layer}`
    const existing = this.mutations.get(key)
    if (existing !== undefined) return existing
    const operation = (async () => {
      const result = await this.rpc.call(method, { sessionId, layer })
      this.trackedSessions.add(sessionId)
      await this.notifyChanged()
      return result
    })()
    this.mutations.set(key, operation)
    void operation.then(
      () => { if (this.mutations.get(key) === operation) this.mutations.delete(key) },
      () => { if (this.mutations.get(key) === operation) this.mutations.delete(key) },
    )
    return operation
  }

  private async refreshActive(): Promise<void> {
    if (this.disposed) return
    await Promise.all([
      ...[...this.trackedSessions].map(sessionId => this.loadSession(sessionId)),
      ...[...this.trackedScopes.values()].map(scope => this.loadIndex(scope)),
    ])
  }

  private current(requests: Map<string, number>, key: string, request: number): boolean {
    return !this.disposed && requests.get(key) === request
  }

  private publish(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) listener()
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
