import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  LifecycleActivityFileSink,
  type LifecycleActivityRecord,
} from '../../src/lifecycle/activity.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function activity(overrides: Partial<LifecycleActivityRecord> = {}): LifecycleActivityRecord {
  return {
    formatVersion: 1,
    time: '2026-10-29T06:30:00.000Z',
    event: 'run-succeeded',
    operation: 'idle',
    intentId: 'intent-1',
    sessionId: 'session-1',
    workspaceId: 'workspace-1',
    durationMs: 12,
    batches: 1,
    written: 1,
    ...overrides,
  }
}

describe('LifecycleActivityFileSink', () => {
  it('writes versioned JSONL with only whitelisted operational metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-activity-'))
    roots.push(root)
    const file = join(root, 'logs', 'lifecycle.v1.jsonl')
    const sink = new LifecycleActivityFileSink({ file })
    const record = {
      ...activity(),
      prompt: 'private prompt must not be logged',
      detail: 'private memory detail must not be logged',
      exception: 'secret exception must not be logged',
    } as LifecycleActivityRecord

    sink.record(record)
    await sink.close()

    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toEqual(activity())
    expect(lines[0]).not.toContain('private')
    expect(lines[0]).not.toContain('secret exception')
  })

  it('rotates by size, retains the configured generations, and drains the latest record on close', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-activity-'))
    roots.push(root)
    const file = join(root, 'lifecycle.v1.jsonl')
    const sink = new LifecycleActivityFileSink({ file, maxBytes: 360, retainedFiles: 2 })

    for (let index = 0; index < 12; index += 1) {
      sink.record(activity({ intentId: `intent-${index}`, written: index }))
    }
    await sink.close()

    const names = (await readdir(root)).sort()
    expect(names).toEqual(['lifecycle.v1.jsonl', 'lifecycle.v1.jsonl.1', 'lifecycle.v1.jsonl.2'])
    const records = (await Promise.all(names.map(async name => (await readFile(join(root, name), 'utf8'))
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as LifecycleActivityRecord)))).flat()
    const current = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as LifecycleActivityRecord)
    expect(current.at(-1)).toMatchObject({ intentId: 'intent-11', written: 11 })
    expect(records.length).toBeLessThan(12)
    expect(records.some(record => record.intentId === 'intent-0')).toBe(false)
  })

  it('keeps logging best-effort when the log directory cannot be created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-activity-'))
    roots.push(root)
    const blocker = join(root, 'not-a-directory')
    await writeFile(blocker, 'block directory creation')
    const onError = vi.fn()
    const sink = new LifecycleActivityFileSink({
      file: join(blocker, 'lifecycle.v1.jsonl'),
      onError,
    })

    expect(() => sink.record(activity())).not.toThrow()
    await expect(sink.flush()).resolves.toBeUndefined()
    await expect(sink.close()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalled()
  })
})
