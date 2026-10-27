import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeJsonAtomic } from './json.js'
import type { StorePaths } from './paths.js'
import type { MemoryEntry, StoreState, StoredMemoryEntry } from './types.js'

interface MemoryDetailRecord {
  readonly formatVersion: 1
  readonly id: string
  readonly revision: number
  readonly detail: string
}

export async function writeDetailRecord(paths: StorePaths, entry: MemoryEntry): Promise<void> {
  const record: MemoryDetailRecord = {
    formatVersion: 1,
    id: entry.id,
    revision: entry.revision,
    detail: entry.detail,
  }
  await writeJsonAtomic(paths.detailRecord(entry.id, entry.revision), record)
}

export async function readDetailRecord(paths: StorePaths, index: StoredMemoryEntry): Promise<MemoryEntry> {
  const path = paths.detailRecord(index.id, index.revision)
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  const record = value as Partial<MemoryDetailRecord>
  if (!value || typeof value !== 'object' || record.formatVersion !== 1 || record.id !== index.id
    || record.revision !== index.revision || typeof record.detail !== 'string'
    || record.detail.length !== index.detailChars) {
    throw new Error(`Cannot read authoritative detail ${index.id} at revision ${index.revision}`)
  }
  const entry = { ...index, detail: record.detail } as MemoryEntry & { detailChars?: number }
  delete entry.detailChars
  return entry
}

export async function removeUnreferencedDetailRecords(paths: StorePaths, state: StoreState): Promise<void> {
  await mkdir(paths.detailData, { recursive: true })
  const retained = new Map(state.entries.map(entry => [entry.id as string, `${entry.revision}.json`]))
  for (const id of await readdir(paths.detailData)) {
    const directory = paths.detailDataDirectory(id)
    const expected = retained.get(id)
    if (!expected) {
      await rm(directory, { recursive: true, force: true })
      continue
    }
    for (const name of await readdir(directory)) {
      if (name !== expected) await rm(join(directory, name), { recursive: true, force: true })
    }
  }
}
