import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { MemoryEntry, StoreState } from './types.js'

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
      dirty: false,
      nextConsolidationAt: null,
      nextRetentionAt: null,
      lastConsolidationAt: null,
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
  const legacyGlobal = state.meta.globalDirty === undefined
  const aggregateRevision = Object.values(state.scopeRevisions.workspaces).reduce((total, revision) => total + revision, 0)
  return {
    ...state,
    scopeRevisions: {
      ...state.scopeRevisions,
      global: legacyGlobal
        ? Math.max(state.scopeRevisions.global, aggregateRevision + 1)
        : state.scopeRevisions.global,
    },
    meta: {
      ...state.meta,
      globalDirty: state.meta.globalDirty ?? false,
      nextGlobalConsolidationAt: state.meta.nextGlobalConsolidationAt ?? null,
      lastGlobalConsolidationAt: state.meta.lastGlobalConsolidationAt ?? null,
      pending: Object.fromEntries(Object.entries(state.meta.pending).map(([key, intent]) => [key, {
        ...intent,
        id: intent.id ?? `legacy:${key}:${intent.createdAt}`,
      }])),
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
