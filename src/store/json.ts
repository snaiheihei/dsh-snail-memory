import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { LifecycleIntent, MemoryEntry, MemoryMeta, StoreState, WorkspaceConsolidationMeta } from './types.js'

export type LegacyStoreState = Omit<StoreState, 'formatVersion' | 'entries'> & {
  readonly formatVersion: 1
  entries: MemoryEntry[]
}

export function emptyState(): StoreState {
  return {
    formatVersion: 2,
    revision: 0,
    entries: [],
    workspaces: {},
    scopeRevisions: { global: 0, workspaces: {} },
    sessions: {},
    meta: {
      workspaceConsolidation: {},
      nextRetentionAt: null,
      globalDirty: false,
      nextGlobalConsolidationAt: null,
      lastGlobalConsolidationAt: null,
      lastRetentionAt: null,
      lastError: null,
      pending: {},
    },
  }
}

async function readSnapshot(path: string, formatVersion: 1 | 2): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object') throw new Error('state is not an object')
    const candidate = value as Partial<StoreState>
    if (candidate.formatVersion !== formatVersion || !Array.isArray(candidate.entries)
      || !candidate.sessions || !candidate.meta || !candidate.scopeRevisions
      || !candidate.workspaces || typeof candidate.revision !== 'number') {
      throw new Error('state has an unsupported or incomplete format')
    }
    return value
  } catch (error) {
    const wrapped = new Error(`Cannot read authoritative ${path}: ${error instanceof Error ? error.message : String(error)}`)
    Object.defineProperty(wrapped, 'cause', { value: error, configurable: true, writable: true })
    throw wrapped
  }
}

export async function readState(path: string): Promise<StoreState | null> {
  const state = await readSnapshot(path, 2) as StoreState | null
  return state ? normalizeState(state) : null
}

export async function readLegacyState(path: string): Promise<LegacyStoreState | null> {
  const state = await readSnapshot(path, 1) as LegacyStoreState | null
  return state ? normalizeState(state) : null
}

function normalizeState<T extends StoreState | LegacyStoreState>(state: T): T {
  const normalizeRank = (rank: unknown): number => typeof rank === 'number' && Number.isSafeInteger(rank) ? rank : 0
  type LegacyMeta = Omit<MemoryMeta, 'workspaceConsolidation'> & {
    workspaceConsolidation?: Record<string, WorkspaceConsolidationMeta>
    dirty?: boolean
    nextConsolidationAt?: string | null
    lastConsolidationAt?: string | null
  }
  const legacyMeta = state.meta as LegacyMeta
  const legacyGlobal = legacyMeta.globalDirty === undefined
  const aggregateRevision = Object.values(state.scopeRevisions.workspaces).reduce((total, revision) => total + revision, 0)
  const legacyConsolidation = legacyMeta.pending.consolidate
  const sharedDirty = legacyMeta.dirty === true || legacyConsolidation !== undefined
  const workspaceIds = new Set([...Object.keys(state.workspaces), ...Object.keys(legacyMeta.workspaceConsolidation ?? {})])
  const workspaceConsolidation: Record<string, WorkspaceConsolidationMeta> = {}
  for (const id of workspaceIds) {
    const existing = legacyMeta.workspaceConsolidation?.[id]
    workspaceConsolidation[id] = sharedDirty
      ? {
          dirty: true,
          nextConsolidationAt: existing?.nextConsolidationAt ?? legacyMeta.nextConsolidationAt ?? legacyConsolidation?.createdAt ?? null,
          lastConsolidationAt: existing?.lastConsolidationAt ?? legacyMeta.lastConsolidationAt ?? null,
        }
      : existing ?? { dirty: false, nextConsolidationAt: null, lastConsolidationAt: null }
  }
  const pending: Record<string, LifecycleIntent> = {}
  for (const [key, raw] of Object.entries(legacyMeta.pending)) {
    if (key === 'consolidate') continue
    const { attempts, retryAt, ...rest } = raw as LifecycleIntent & { attempts?: unknown; retryAt?: unknown }
    pending[key] = {
      ...rest,
      id: rest.id ?? `legacy:${key}:${rest.createdAt}`,
      ...(typeof attempts === 'number' && Number.isSafeInteger(attempts) && attempts > 0 ? { attempts } : {}),
      ...(typeof retryAt === 'string' && Number.isFinite(new Date(retryAt).getTime()) ? { retryAt } : {}),
    }
  }
  if (legacyConsolidation) {
    for (const id of workspaceIds) {
      const kind = `consolidate:${encodeURIComponent(id)}`
      pending[kind] = {
        ...legacyConsolidation,
        id: `${legacyConsolidation.id ?? 'legacy:consolidate'}:${encodeURIComponent(id)}`,
        kind,
      }
    }
  }
  return {
    ...state,
    entries: state.entries.map(entry => ({ ...entry, rank: normalizeRank(entry.rank) })),
    scopeRevisions: {
      ...state.scopeRevisions,
      global: legacyGlobal
        ? Math.max(state.scopeRevisions.global, aggregateRevision + 1)
        : state.scopeRevisions.global,
    },
    meta: {
      workspaceConsolidation,
      globalDirty: legacyMeta.globalDirty ?? false,
      nextGlobalConsolidationAt: legacyMeta.nextGlobalConsolidationAt ?? null,
      lastGlobalConsolidationAt: legacyMeta.lastGlobalConsolidationAt ?? null,
      nextRetentionAt: legacyMeta.nextRetentionAt,
      lastRetentionAt: legacyMeta.lastRetentionAt,
      lastError: legacyMeta.lastError,
      pending,
    },
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, 'utf8')
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path)
        return
      } catch (error) {
        // Windows antivirus and search indexers can briefly hold the destination open.
        if ((error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= 5) throw error
        await delay(Math.min(10 * 2 ** attempt, 250))
      }
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}
