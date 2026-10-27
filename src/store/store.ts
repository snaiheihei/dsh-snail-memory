import { appendFile, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { WriterLock } from './lock.js'
import { emptyState, readLegacyState, readState, writeJsonAtomic, type LegacyStoreState } from './json.js'
import { StorePaths } from './paths.js'
import { removeDetailProjection, writeDetailProjection, writeIndexProjections } from './projections.js'
import { readDetailRecord, removeUnreferencedDetailRecords, writeDetailRecord } from './records.js'
import type {
  DesiredInjection,
  MemoryEntry,
  MemoryId,
  MemoryIndex,
  MemoryIndexEntry,
  MemoryMeta,
  MemoryScope,
  SessionMemoryState,
  StoreState,
  StoredMemoryEntry,
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

function storedEntry(entry: MemoryEntry): StoredMemoryEntry {
  const stored = { ...entry, detailChars: entry.detail.length } as StoredMemoryEntry & { detail?: string }
  delete stored.detail
  return stored
}

function withoutDetail(entry: StoredMemoryEntry): MemoryIndexEntry {
  const index = { ...entry } as MemoryIndexEntry & { detailChars?: number }
  delete index.detailChars
  return index
}

function migrateState(legacy: LegacyStoreState): StoreState {
  return {
    ...legacy,
    formatVersion: 2,
    entries: legacy.entries.map(storedEntry),
  }
}

interface ProjectionPending {
  readonly formatVersion: 1
  readonly ids: string[]
}

function changedProjectionIds(before: StoreState, after: StoreState): string[] {
  const previous = new Map(before.entries.map(entry => [entry.id as string, entry]))
  const ids = new Set<string>()
  for (const entry of after.entries) {
    if (previous.get(entry.id)?.revision !== entry.revision) ids.add(entry.id)
  }
  for (const id of previous.keys()) {
    if (!after.entries.some(entry => entry.id === id)) ids.add(id)
  }
  return [...ids]
}

export class MemoryStore {
  readonly paths: StorePaths
  private state: StoreState
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false
  private legacyEntries: ReadonlyMap<string, MemoryEntry> | undefined

  private constructor(
    options: Required<MemoryStoreOptions>,
    private readonly lock: WriterLock,
    state: StoreState,
    legacyEntries?: readonly MemoryEntry[],
  ) {
    this.paths = new StorePaths(options.root)
    this.state = state
    this.now = options.now
    if (legacyEntries) this.legacyEntries = new Map(legacyEntries.map(entry => [entry.id as string, entry]))
  }

  private readonly now: () => Date

  static async open(options: MemoryStoreOptions): Promise<MemoryStore> {
    const resolved = {
      heartbeatMs: options.heartbeatMs ?? 5_000,
      lockStaleMs: options.lockStaleMs ?? 30_000,
      now: options.now ?? (() => new Date()),
      root: options.root,
    }
    const paths = new StorePaths(resolved.root)
    const lock = await WriterLock.acquire(resolved.root, paths.lock, resolved)
    try {
      const current = await readState(paths.state)
      const legacy = current ? null : await readLegacyState(paths.legacyState)
      const state = current ?? (legacy ? migrateState(legacy) : emptyState())
      const store = new MemoryStore(resolved, lock, state, legacy && !lock.writable ? legacy.entries : undefined)
      if (lock.writable) {
        if (legacy) await store.migrateLegacy(legacy.entries)
        else {
          await store.recoverPendingProjections()
          await writeIndexProjections(store.paths, state)
          await removeUnreferencedDetailRecords(store.paths, state)
          await rm(store.paths.legacyState, { force: true })
        }
      }
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

  async read(scope: MemoryScope, id: MemoryId): Promise<MemoryEntry | null> {
    const run = this.queue.then(async () => {
      if (!this.lock.writable) await this.reloadSecondary()
      try {
        return await this.readCurrent(scope, id)
      } catch (error) {
        if (this.lock.writable || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.reloadSecondary()
        return this.readCurrent(scope, id)
      }
    })
    this.queue = run.catch(() => {})
    return run
  }

  private async readCurrent(scope: MemoryScope, id: MemoryId): Promise<MemoryEntry | null> {
    const entry = this.state.entries.find(candidate => candidate.id === id && scopeKey(candidate.scope) === scopeKey(scope))
    if (!entry) return null
    if (this.legacyEntries) {
      const legacy = this.legacyEntries.get(id)
      if (!legacy || legacy.revision !== entry.revision) throw new Error(`Cannot read legacy detail ${id} at revision ${entry.revision}`)
      return structuredClone(legacy)
    }
    return readDetailRecord(this.paths, entry)
  }

  private async reloadSecondary(): Promise<void> {
    const current = await readState(this.paths.state)
    if (!current) return
    this.state = current
    this.legacyEntries = undefined
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
      draft.entries = [...draft.entries.filter(candidate => candidate.id !== entry.id), storedEntry(entry)]
      if (input.scope.kind === 'workspace') {
        const current = draft.workspaces[input.scope.workspaceId]
        draft.workspaces[input.scope.workspaceId] = { createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp }
      }
      draft.meta.dirty = true
      return structuredClone(entry)
    }, async (_entry, draft) => {
      await removeUnreferencedDetailRecords(this.paths, draft)
    }, async entry => {
      await writeDetailRecord(this.paths, entry)
      await writeDetailProjection(this.paths, entry)
    })
  }

  async remove(scope: MemoryScope, id: MemoryId): Promise<boolean> {
    return this.transaction('memory/forget', draft => {
      const exists = draft.entries.some(entry => entry.id === id && scopeKey(entry.scope) === scopeKey(scope))
      if (!exists) return false
      draft.entries = draft.entries.filter(entry => entry.id !== id)
      this.nextScopeRevision(draft, scope)
      draft.meta.dirty = true
      return true
    }, async removed => {
      if (!removed) return
      await Promise.all([
        removeDetailProjection(this.paths, id),
        rm(this.paths.detailDataDirectory(id), { recursive: true, force: true }),
      ])
    })
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

  private async migrateLegacy(entries: readonly MemoryEntry[]): Promise<void> {
    for (const entry of entries) await writeDetailRecord(this.paths, entry)
    await writeJsonAtomic(this.paths.projectionPending, {
      formatVersion: 1,
      ids: entries.map(entry => entry.id),
    } satisfies ProjectionPending)
    for (const entry of entries) await writeDetailProjection(this.paths, entry)
    await writeJsonAtomic(this.paths.state, this.state)
    await this.recoverPendingProjections()
    await removeUnreferencedDetailRecords(this.paths, this.state)
    await rm(this.paths.legacyState, { force: true })
  }

  private async readPendingProjections(): Promise<ProjectionPending | null> {
    let text: string
    try {
      text = await readFile(this.paths.projectionPending, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    const value = JSON.parse(text) as Partial<ProjectionPending>
    if (value.formatVersion !== 1 || !Array.isArray(value.ids)
      || value.ids.some(id => typeof id !== 'string')) {
      throw new Error('Cannot read projection recovery intent')
    }
    return value as ProjectionPending
  }

  private async recoverPendingProjections(): Promise<void> {
    const pending = await this.readPendingProjections()
    if (!pending) return
    for (const id of pending.ids) {
      const index = this.state.entries.find(entry => entry.id === id)
      if (index) await writeDetailProjection(this.paths, await readDetailRecord(this.paths, index))
      else await removeDetailProjection(this.paths, id)
    }
    await writeIndexProjections(this.paths, this.state)
    await removeUnreferencedDetailRecords(this.paths, this.state)
    await rm(this.paths.projectionPending, { force: true })
  }

  private transaction<T>(
    operation: string,
    update: (draft: StoreState) => T,
    finalize?: (result: T, draft: StoreState) => Promise<void>,
    prepare?: (result: T, draft: StoreState) => Promise<void>,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      if (!this.writable) throw new MemoryStoreReadonlyError('This Snail Memory host is read-only')
      await this.lock.assertOwner()
      await this.recoverPendingProjections()
      const draft = structuredClone(this.state)
      const result = update(draft)
      const ids = changedProjectionIds(this.state, draft)
      await writeJsonAtomic(this.paths.projectionPending, { formatVersion: 1, ids } satisfies ProjectionPending)
      try {
        await prepare?.(result, draft)
        draft.revision += 1
        await appendFile(this.paths.audit, `${JSON.stringify({ time: this.now().toISOString(), operation, revision: draft.revision })}\n`, 'utf8')
        await writeJsonAtomic(this.paths.state, draft)
      } catch (error) {
        await this.recoverPendingProjections().catch(() => {})
        throw error
      }
      this.state = draft
      try {
        await writeIndexProjections(this.paths, draft)
        await finalize?.(result, draft)
        await rm(this.paths.projectionPending, { force: true })
      } catch {
        // The authoritative state is committed. Keep the intent for a later retry.
      }
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
