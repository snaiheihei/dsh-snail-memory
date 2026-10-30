import { appendFile, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { entriesForScope, revisionForScope, workspaceIndexRefs } from './aggregate.js'
import { WriterLock, WriterLockOwnershipError } from './lock.js'
import { emptyState, readLegacyState, readState, writeJsonAtomic, type LegacyStoreState } from './json.js'
import { StorePaths } from './paths.js'
import { removeDetailProjection, writeDetailProjection, writeIndexProjections } from './projections.js'
import { readDetailRecord, removeUnreferencedDetailRecords, writeDetailRecord } from './records.js'
import type {
  DesiredInjection,
  MemoryEntry,
  MemoryFeedbackInput,
  MemoryFeedbackResult,
  MemoryId,
  MemoryIndex,
  MemoryIndexEntry,
  MemoryMeta,
  MemoryScope,
  PromoteMemoryResult,
  SessionMemoryState,
  StoreState,
  StoredMemoryEntry,
  UpsertMemoryInput,
} from './types.js'
import { memoryId } from './types.js'

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
  return { sessionId, activeDesired: null, layers: { global: emptyLayer(), workspace: emptyLayer() } }
}

function normalizeSessionSelection(state: SessionMemoryState): SessionMemoryState {
  // Legacy builds allowed both latches. Prefer the narrower workspace scope.
  if (state.layers.global.enabled && state.layers.workspace.enabled) state.layers.global.enabled = false
  const legacy = state.activeDesired === undefined
  const active = state.activeDesired
  const activeLayer = active ? state.layers[active.layer] : undefined
  const activeValid = active !== null && active !== undefined && activeLayer?.enabled === true
    && activeLayer.desired.some(item => item.injectionId === active.injectionId)
    && !activeLayer.committed.some(item => item.injectionId === active.injectionId)
  if (activeValid) return state

  state.activeDesired = null
  if (!legacy) return state
  // A legacy Session could have several independently pending generations.
  // Only its latest desired survives migration; older generations are superseded.
  const layer = state.layers.workspace.enabled ? 'workspace' : state.layers.global.enabled ? 'global' : null
  const latest = layer ? state.layers[layer].desired.at(-1) : undefined
  if (layer && latest && !state.layers[layer].committed.some(item => item.injectionId === latest.injectionId)) {
    state.activeDesired = { layer, injectionId: latest.injectionId }
  }
  return state
}

function scopeKey(scope: MemoryScope): string {
  return scope.kind === 'global' ? 'global' : scope.workspaceId
}

function markWorkspaceDirty(meta: MemoryMeta, id: string): void {
  const consolidation = meta.workspaceConsolidation[id] ??= {
    dirty: false,
    nextConsolidationAt: null,
    lastConsolidationAt: null,
  }
  consolidation.dirty = true
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
  private writerReady = false
  private legacyEntries: ReadonlyMap<string, MemoryEntry> | undefined
  private readonly writableListeners = new Set<(writable: boolean) => void>()

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
        await store.initializeWriter(legacy)
        await lock.assertOwner()
        store.writerReady = true
      }
      lock.monitor(owned => store.handleOwnershipChange(owned))
      return store
    } catch (error) {
      await lock.close()
      throw error
    }
  }

  get writable(): boolean {
    return this.lock.writable && this.writerReady && !this.closed
  }

  onWritableChange(listener: (writable: boolean) => void): () => void {
    this.writableListeners.add(listener)
    return () => { this.writableListeners.delete(listener) }
  }

  private async handleOwnershipChange(owned: boolean): Promise<void> {
    if (!owned) {
      this.writerReady = false
      this.emitWritableChange()
      return
    }
    if (this.closed) throw new Error('Cannot promote a closed memory store')
    const run = this.queue.then(async () => {
      const current = await readState(this.paths.state)
      const legacy = current ? null : await readLegacyState(this.paths.legacyState)
      if (current) {
        this.state = current
        this.legacyEntries = undefined
      } else if (legacy) {
        this.state = migrateState(legacy)
        this.legacyEntries = new Map(legacy.entries.map(entry => [entry.id as string, entry]))
      }
      await this.initializeWriter(legacy)
      await this.lock.assertOwner()
      if (this.closed) throw new Error('Cannot promote a closed memory store')
      this.writerReady = true
    })
    this.queue = run.catch(() => {})
    try {
      await run
    } catch (error) {
      this.writerReady = false
      throw error
    }
    this.emitWritableChange()
  }

  private emitWritableChange(): void {
    for (const listener of this.writableListeners) listener(this.writable)
  }

  private async initializeWriter(legacy: Awaited<ReturnType<typeof readLegacyState>>): Promise<void> {
    await this.lock.heartbeat()
    if (legacy) await this.migrateLegacy(legacy.entries)
    else {
      await this.recoverPendingProjections()
      await this.lock.heartbeat()
      await writeIndexProjections(this.paths, this.state)
      await this.lock.heartbeat()
      await removeUnreferencedDetailRecords(this.paths, this.state)
      await this.lock.heartbeat()
      await rm(this.paths.legacyState, { force: true })
    }
    this.legacyEntries = undefined
  }

  list(scope: MemoryScope): MemoryIndex {
    const entries = entriesForScope(this.state, scope)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
      .map(withoutDetail)
    return {
      scope,
      revision: revisionForScope(this.state, scope),
      entries,
      workspaces: [],
    }
  }

  workspaceScopes(): MemoryScope[] {
    return workspaceIndexRefs(this.state).map(ref => ({
      kind: 'workspace',
      workspaceId: ref.workspaceId,
    }))
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
    return normalizeSessionSelection(structuredClone(this.state.sessions[sessionId] ?? emptySession(sessionId)))
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
        rank: existing?.rank ?? 0,
        ...(existing?.promotedFrom === undefined ? {} : { promotedFrom: existing.promotedFrom }),
      }
      draft.entries = [...draft.entries.filter(candidate => candidate.id !== entry.id), storedEntry(entry)]
      if (input.scope.kind === 'workspace') {
        const current = draft.workspaces[input.scope.workspaceId]
        draft.workspaces[input.scope.workspaceId] = { createdAt: current?.createdAt ?? timestamp, updatedAt: timestamp }
        markWorkspaceDirty(draft.meta, input.scope.workspaceId)
      } else {
        draft.meta.globalDirty = true
      }
      return structuredClone(entry)
    }, async (_entry, draft) => {
      await removeUnreferencedDetailRecords(this.paths, draft)
    }, async entry => {
      await writeDetailRecord(this.paths, entry)
      await writeDetailProjection(this.paths, entry)
    })
  }

  async promote(scope: MemoryScope, id: MemoryId): Promise<PromoteMemoryResult> {
    if (scope.kind !== 'workspace') throw new Error('Only workspace memories can be promoted')
    return this.transaction('memory/promote', async draft => {
      const existing = draft.entries.find(entry => entry.scope.kind === 'global'
        && entry.promotedFrom?.workspaceId === scope.workspaceId && entry.promotedFrom.id === id)
      if (existing) return { id: existing.id, created: false }
      const sourceIndex = draft.entries.find(entry => entry.id === id && scopeKey(entry.scope) === scopeKey(scope))
      if (!sourceIndex) throw new Error('Cannot promote a memory that does not exist in this workspace')
      const source = await readDetailRecord(this.paths, sourceIndex)
      const timestamp = this.now().toISOString()
      const entry: MemoryEntry = {
        id: memoryId(randomUUID()),
        scope: { kind: 'global' },
        category: source.category,
        summary: source.summary,
        detail: source.detail,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastVerifiedAt: source.lastVerifiedAt,
        revision: this.nextScopeRevision(draft, { kind: 'global' }),
        rank: 0,
        sourceRefs: structuredClone(source.sourceRefs),
        promotedFrom: { workspaceId: scope.workspaceId, id: source.id },
        ...(source.expiresAt === undefined ? {} : { expiresAt: source.expiresAt }),
      }
      draft.entries = [...draft.entries, storedEntry(entry)]
      draft.meta.globalDirty = true
      return { id: entry.id, created: true }
    }, async (_result, draft) => {
      await removeUnreferencedDetailRecords(this.paths, draft)
    }, async (result, draft) => {
      if (!result.created) return
      const index = draft.entries.find(entry => entry.id === result.id)
      const source = index?.promotedFrom
        ? draft.entries.find(entry => entry.id === index.promotedFrom?.id
          && entry.scope.kind === 'workspace' && entry.scope.workspaceId === index.promotedFrom?.workspaceId)
        : undefined
      if (!index || !source) throw new Error('Cannot prepare promoted memory details')
      const sourceDetail = await readDetailRecord(this.paths, source)
      const entry: MemoryEntry = { ...withoutDetail(index), detail: sourceDetail.detail }
      await writeDetailRecord(this.paths, entry)
      await writeDetailProjection(this.paths, entry)
    })  }

  async recordFeedback(input: MemoryFeedbackInput): Promise<MemoryFeedbackResult> {
    return this.transaction('memory/feedback', draft => {
      const session = draft.sessions[input.sessionId]
      const layer = session?.layers[input.layer]
      if (!session || !layer?.enabled) return { status: 'disabled' }
      const workspaceId = input.layer === 'workspace'
        ? session.selectedWorkspaceId ?? session.workspaceId
        : undefined
      if (input.layer === 'workspace' && !workspaceId) return { status: 'not-injected' }
      const scope: MemoryScope = input.layer === 'global'
        ? { kind: 'global' }
        : { kind: 'workspace', workspaceId: workspaceId! }
      const entryIndex = draft.entries.findIndex(entry => entry.id === input.memoryId
        && scopeKey(entry.scope) === scopeKey(scope))
      if (entryIndex < 0) return { status: 'not-found' }
      let committedIndex = -1
      for (let index = layer.committed.length - 1; index >= 0; index -= 1) {
        const candidate = layer.committed[index]!
        const matches = candidate.memoryIds?.includes(input.memoryId) === true
          && (scope.kind === 'global'
            ? candidate.workspaceId === undefined
            : (candidate.workspaceId ?? session.workspaceId) === scope.workspaceId)
        if (!matches) continue
        committedIndex = index
        break
      }
      if (committedIndex < 0) return { status: 'not-injected' }
      const committed = layer.committed[committedIndex]!
      const currentRank = draft.entries[entryIndex]!.rank
      if (committed.feedback?.[input.memoryId]) return { status: 'duplicate', rank: currentRank }
      const rank = currentRank + (input.outcome === 'helpful' ? 1 : -1)
      draft.entries[entryIndex] = { ...draft.entries[entryIndex]!, rank }
      layer.committed[committedIndex] = {
        ...committed,
        feedback: { ...committed.feedback, [input.memoryId]: input.outcome },
      }
      return { status: 'recorded', rank }
    })
  }

  async remove(scope: MemoryScope, id: MemoryId): Promise<boolean> {
    return this.transaction('memory/forget', draft => {
      const exists = draft.entries.some(entry => entry.id === id && scopeKey(entry.scope) === scopeKey(scope))
      if (!exists) return false
      draft.entries = draft.entries.filter(entry => entry.id !== id)
      this.nextScopeRevision(draft, scope)
      if (scope.kind === 'global') draft.meta.globalDirty = true
      else markWorkspaceDirty(draft.meta, scope.workspaceId)
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
      draft.sessions[sessionId] = normalizeSessionSelection(state)
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
    this.writerReady = false
    await this.queue.catch(() => {})
    await this.lock.close()
    this.writableListeners.clear()
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
    for (const entry of entries) {
      await this.lock.heartbeat()
      await writeDetailRecord(this.paths, entry)
    }
    await this.lock.heartbeat()
    await writeJsonAtomic(this.paths.projectionPending, {
      formatVersion: 1,
      ids: entries.map(entry => entry.id),
    } satisfies ProjectionPending)
    for (const entry of entries) {
      await this.lock.heartbeat()
      await writeDetailProjection(this.paths, entry)
    }
    await this.lock.heartbeat()
    await writeJsonAtomic(this.paths.state, this.state)
    await this.recoverPendingProjections()
    await this.lock.heartbeat()
    await removeUnreferencedDetailRecords(this.paths, this.state)
    await this.lock.heartbeat()
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
      await this.lock.heartbeat()
      const index = this.state.entries.find(entry => entry.id === id)
      if (index) await writeDetailProjection(this.paths, await readDetailRecord(this.paths, index))
      else await removeDetailProjection(this.paths, id)
    }
    await this.lock.heartbeat()
    await writeIndexProjections(this.paths, this.state)
    await this.lock.heartbeat()
    await removeUnreferencedDetailRecords(this.paths, this.state)
    await this.lock.heartbeat()
    await rm(this.paths.projectionPending, { force: true })
  }

  private async assertWritable(): Promise<void> {
    if (!this.writable) throw new MemoryStoreReadonlyError('This Snail Memory host is read-only')
    try {
      await this.lock.assertOwner()
    } catch (error) {
      if (error instanceof WriterLockOwnershipError) {
        throw new MemoryStoreReadonlyError('This Snail Memory host lost writer ownership')
      }
      throw error
    }
  }

  private transaction<T>(
    operation: string,
    update: (draft: StoreState) => T | Promise<T>,
    finalize?: (result: T, draft: StoreState) => Promise<void>,
    prepare?: (result: T, draft: StoreState) => Promise<void>,
  ): Promise<T> {
    const run = this.queue.then(async () => {
      await this.assertWritable()
      await this.recoverPendingProjections()
      const draft = structuredClone(this.state)
      const result = await update(draft)
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
    }).catch(error => {
      if (error instanceof WriterLockOwnershipError) {
        throw new MemoryStoreReadonlyError('This Snail Memory host lost writer ownership')
      }
      throw error
    })
    this.queue = run.catch(() => {})
    return run
  }
}

export function activeInjection(state: SessionMemoryState): {
  readonly layer: 'global' | 'workspace'
  readonly desired: DesiredInjection
} | null {
  const active = state.activeDesired
  if (!active || !state.layers[active.layer].enabled) return null
  const layerState = state.layers[active.layer]
  const desired = layerState.desired.find(item => item.injectionId === active.injectionId)
  if (!desired || layerState.committed.some(item => item.injectionId === active.injectionId)) return null
  return { layer: active.layer, desired }
}

export function pendingInjection(state: SessionMemoryState, layer: 'global' | 'workspace'): DesiredInjection[] {
  const active = activeInjection(state)
  return active?.layer === layer ? [active.desired] : []
}
