import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { StoreState } from './types.js'

export function emptyState(): StoreState {
  return {
    formatVersion: 1,
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
      lastRetentionAt: null,
      lastError: null,
      pending: {},
    },
  }
}

export async function readState(path: string): Promise<StoreState> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object') throw new Error('state is not an object')
    const candidate = value as Partial<StoreState>
    if (candidate.formatVersion !== 1 || !Array.isArray(candidate.entries)
      || !candidate.sessions || !candidate.meta || !candidate.scopeRevisions
      || !candidate.workspaces || typeof candidate.revision !== 'number') {
      throw new Error('state has an unsupported or incomplete format')
    }
    return value as StoreState
  } catch (error) {
    const wrapped = new Error(`Cannot read authoritative ${path}: ${error instanceof Error ? error.message : String(error)}`)
    Object.defineProperty(wrapped, 'cause', { value: error, configurable: true, writable: true })
    throw wrapped
  }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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
