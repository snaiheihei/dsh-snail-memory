import type { MemorySettings, SessionStateView, WorkspaceView } from '../../src/contract.js'
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
  private settings: MemorySettings | undefined
  private workspaces: readonly WorkspaceView[] | undefined
  private settingsRequest = 0
  private workspacesRequest = 0
  private trackSettings = false
  private trackWorkspaces = false
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

  getSettings(): MemorySettings | undefined {
    return this.settings
  }

  getWorkspaces(): readonly WorkspaceView[] | undefined {
    return this.workspaces
  }

  getSettingsError(): string | undefined {
    return this.errors.get('settings')
  }

  getWorkspacesError(): string | undefined {
    return this.errors.get('workspaces')
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

  async loadSettings(): Promise<MemorySettings | undefined> {
    if (this.disposed) return undefined
    this.trackSettings = true
    const request = ++this.settingsRequest
    try {
      const settings = await this.rpc.call('getSettings', {})
      if (this.disposed || request !== this.settingsRequest) return undefined
      this.settings = settings
      this.errors.delete('settings')
      this.publish()
      return settings
    } catch (error) {
      if (!this.disposed && request === this.settingsRequest) {
        this.errors.set('settings', messageOf(error))
        this.publish()
      }
      return undefined
    }
  }

  async updateSettings(settings: MemorySettings): Promise<MemorySettings> {
    const updated = await this.rpc.call('updateSettings', settings)
    if (!this.disposed) {
      this.settingsRequest += 1
      this.settings = updated
      this.errors.delete('settings')
      this.publish()
    }
    return updated
  }

  async loadWorkspaces(): Promise<readonly WorkspaceView[] | undefined> {
    if (this.disposed) return undefined
    this.trackWorkspaces = true
    const request = ++this.workspacesRequest
    try {
      const workspaces = await this.rpc.call('listWorkspaces', {})
      if (this.disposed || request !== this.workspacesRequest) return undefined
      this.workspaces = workspaces
      this.errors.delete('workspaces')
      this.publish()
      return workspaces
    } catch (error) {
      if (!this.disposed && request === this.workspacesRequest) {
        this.errors.set('workspaces', messageOf(error))
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
      ...(this.trackSettings ? [this.loadSettings()] : []),
      ...(this.trackWorkspaces ? [this.loadWorkspaces()] : []),
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
