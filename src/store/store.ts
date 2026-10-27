import { appendFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { WriterLock } from './lock.js'
import { emptyState, readState, writeJsonAtomic } from './json.js'
import { StorePaths } from './paths.js'
import { writeProjections } from './projections.js'
import type {
  DesiredInjection,
  MemoryEntry,
  MemoryId,
  MemoryIndex,
  MemoryMeta,
  MemoryScope,
  SessionMemoryState,
  StoreState,
  UpsertMemoryInput,
  WorkspaceIndexRef,
} from './types.js'
import { memoryId, workspaceId } from './types.js'

export class MemoryStoreReadonlyError extends Error {
  override readonly name = 'MemoryStoreReadonlyError'
}

export interface MemoryStoreOptions {
  readonly root: string
  readonly heartbeatMs?: number
  readonly lockStaleMs?: number
  readonly now?: () => Date
}

function emptyLayer() {
  return { enabled: false, desired: [], committed: [] }
}

function emptySession(sessionId: string): SessionMemoryState {
  return { sessionId, layers: { global: emptyLayer(), workspace: emptyLayer() } }
}

function scopeKey(scope: MemoryScope): string {
  return scope.kind === 'global' ? 'global' : scope.workspaceId
}

function withoutDetail(entry: MemoryEntry): Omit<MemoryEntry, 'detail'> {
  const index = { ...entry }
  delete (index as { detail?: string }).detail
  return index
}

export class MemoryStore {
  readonly paths: StorePaths
  private state: StoreState
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  private constructor(
    options: Required<MemoryStoreOptions>,
    private readonly lock: WriterLock,
    state: StoreState,
  ) {
    this.paths = new StorePaths(options.root)
    this.state = state
    this.now = options.now
  }

  private readonly now: () => Date

  static async open(options: MemoryStoreOptions): Promise<MemoryStore> {
    const resolved = {
      heartbeatMs: options.heartbeatMs ?? 5_000,
      lockStaleMs: options.lockStaleMs ?? 30_000,
      now: options.now ?? (() => new Date()),
      root: options.root,
    }
    const lock = await WriterLock.acquire(resolved.root, new StorePaths(resolved.root).lock, resolved)
    try {
      const state = await readState(new StorePaths(resolved.root).state)
      const store = new MemoryStore(resolved, lock, state)
      if (lock.writable) await writeProjections(store.paths, state)
      return store
    } catch (error) {
      await lock.close()
      throw error
    }
  }

  get writable(): boolean {
    return this.lock.writable && !this.closed
  }

  list(scope: MemoryScope): MemoryIndex {
    const entries = this.state.entries
      .filter(entry => scopeKey(entry.scope) === scopeKey(scope))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map(withoutDetail)
    const workspaces: WorkspaceIndexRef[] = scope.kind === 'global'
      ? Object.entries(this.state.workspaces).map(([id, meta]) => ({
          workspaceId: workspaceId(id),
          entryCount: this.state.entries.filter(entry => scopeKey(entry.scope) === id).length,
          revision: this.state.scopeRevisions.workspaces[id] ?? 0,
          updatedAt: meta.updatedAt,
        })).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId))
      : []
    return {
      scope,
      revision: scope.kind === 'global'
        ? this.state.scopeRevisions.global
        : this.state.scopeRevisions.workspaces[scope.workspaceId] ?? 0,
      entries,
      workspaces,
    }
  }

  read(scope: MemoryScope, id: MemoryId): MemoryEntry | null {
    const entry = this.state.entries.find(candidate => candidate.id === id && scopeKey(candidate.scope) === scopeKey(scope))
    return entry ? structuredClone(entry) : null
  }

  getSessionState(sessionId: string): SessionMemoryState {
    return structuredClone(this.state.sessions[sessionId] ?? emptySession(sessionId))
  }

  getMeta(): MemoryMeta {
    return structuredClone(this.state.meta)
  }

  async upsert(input: UpsertMemoryInput): Promise<MemoryEntry> {
    return this.transaction('memory/upsert', draft => {
      const timestamp = this.now().toISOString()
      const existing = input.id ? draft.entries.find(entry => entry.id === input.id) : undefined
      if (existing && scopeKey(existing.scope) !== scopeKey(input.scope)) throw new Error('Cannot move a memory between scopes by correction')
      const revision = this.nextScopeRevision(draft, input.scope)
      const entry: MemoryEntry = {
        ...input,
        id: input.id ?? memoryId(randomUUID()),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        revision,
      }
      draft.entries = [...draft.entries.filter(candidate => candidate.id !== entry.id), entry]
      if (input.scope.kind === 'workspace') {
        const current = draft.workspaces[input.scope.workspaceId]
        draft.workspaces[input.scope.workspaceId] = { createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp }
      }
      draft.meta.dirty = true
      return structuredClone(entry)
    })
  }

  async remove(scope: MemoryScope, id: MemoryId): Promise<boolean> {
    const removed = await this.transaction('memory/forget', draft => {
      const exists = draft.entries.some(entry => entry.id === id && scopeKey(entry.scope) === scopeKey(scope))
      if (!exists) return false
      draft.entries = draft.entries.filter(entry => entry.id !== id)
      this.nextScopeRevision(draft, scope)
      draft.meta.dirty = true
      return true
    })
    if (removed) await rm(this.paths.detail(id), { force: true })
    return removed
  }

  async updateSessionState(sessionId: string, update: (state: SessionMemoryState) => void): Promise<SessionMemoryState> {
    return this.transaction('session-state/update', draft => {
      const state = structuredClone(draft.sessions[sessionId] ?? emptySession(sessionId))
      update(state)
      draft.sessions[sessionId] = state
      return structuredClone(state)
    })
  }

  async updateMeta(update: (meta: MemoryMeta) => void): Promise<MemoryMeta> {
    return this.transaction('memory-meta/update', draft => {
      update(draft.meta)
      return structuredClone(draft.meta)
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.queue.catch(() => {})
    await this.lock.close()
  }

  private nextScopeRevision(draft: StoreState, scope: MemoryScope): number {
    const revision = (scope.kind === 'global'
      ? draft.scopeRevisions.global
      : draft.scopeRevisions.workspaces[scope.workspaceId] ?? 0) + 1
    if (scope.kind === 'global') draft.scopeRevisions.global = revision
    else draft.scopeRevisions.workspaces[scope.workspaceId] = revision
    return revision
  }

  private transaction<T>(operation: string, update: (draft: StoreState) => T): Promise<T> {
    const run = this.queue.then(async () => {
      if (!this.writable) throw new MemoryStoreReadonlyError('This Snail Memory host is read-only')
      await this.lock.assertOwner()
      const draft = structuredClone(this.state)
      const result = update(draft)
      draft.revision += 1
      await appendFile(this.paths.audit, `${JSON.stringify({ time: this.now().toISOString(), operation, revision: draft.revision })}\n`, 'utf8')
      await writeJsonAtomic(this.paths.state, draft)
      await writeProjections(this.paths, draft)
      this.state = draft
      return result
    })
    this.queue = run.catch(() => {})
    return run
  }
}

export function pendingInjection(state: SessionMemoryState, layer: 'global' | 'workspace'): DesiredInjection[] {
  const value = state.layers[layer]
  const committed = new Set(value.committed.map(item => item.injectionId))
  return value.desired.filter(item => !committed.has(item.injectionId))
}

export { emptyState }
