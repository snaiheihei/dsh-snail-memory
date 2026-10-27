import { mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeJsonAtomic } from '../../src/store/json.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const roots: string[] = []

afterEach(async () => {
  vi.mocked(rename).mockClear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('writeJsonAtomic', () => {
  it('retries a transient Windows EPERM without losing the new state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-json-'))
    roots.push(root)
    const path = join(root, 'state.v1.json')
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('temporarily locked'), { code: 'EPERM' }))

    await writeJsonAtomic(path, { formatVersion: 1, revision: 1 })

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ formatVersion: 1, revision: 1 })
    expect(rename).toHaveBeenCalledTimes(2)
  })
})
