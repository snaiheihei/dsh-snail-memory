import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'
import { MemoryLifecycleService } from '../../src/lifecycle/service.js'
import type { AuxiliaryModelCallConfig } from '../../src/lifecycle/llm.js'
import { MemoryStore } from '../../src/store/store.js'
import { workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []
const effects: Array<() => void | Promise<void>> = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(effects.splice(0).map(effect => effect()))
  vi.useRealTimers()
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('lifecycle dsh runtime composition', () => {
  it('resolves a late model route per intent and runs session work in maintenance', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-host-lifecycle-'))
    roots.push(root)
    const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
    stores.push(store)
    await store.updateSessionState('session-1', state => { state.workspaceId = workspaceId('workspace-1') })
    const routes: AuxiliaryModelCallConfig[] = []
    const maintenance: string[] = []
    const model = {
      prepareCall(config: AuxiliaryModelCallConfig) {
        routes.push(config)
        return Promise.resolve({
          async *stream() { yield { type: 'text-delta', text: '{"candidates":[]}' } },
        })
      },
    }
    const lifecycle = new MemoryLifecycleService(store, {
      model,
      route: () => ({ provider: 'late-provider', model: 'late-model' }),
      transcriptEvents: () => [{ seq: 1, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'A verified project convention.' }] } }],
      runMaintenance: async (sessionId, task) => { maintenance.push(sessionId); return task(new AbortController().signal) },
    })

    await expect(lifecycle.runIntent('review:session-1')).resolves.toEqual({ written: 0 })
    expect(routes[0]).toMatchObject({ provider: 'late-provider', model: 'late-model' })
    expect(maintenance).toEqual(['session-1'])
    await lifecycle.dispose()
  })

  it('retries the initial lifecycle start without unloading the plugin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-host-start-'))
    roots.push(root)
    vi.useFakeTimers()
    const start = MemoryLifecycleService.prototype.start
    let starts = 0
    vi.spyOn(MemoryLifecycleService.prototype, 'start').mockImplementation(async function (this: MemoryLifecycleService) {
      starts += 1
      if (starts === 1) throw new Error('state temporarily unavailable')
      await start.call(this)
    })
    const ctx = {
      agents: { list: () => [], get: () => undefined },
      commands: { register: () => () => {} },
      llm: {},
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
      workspaceRegistry: { list: () => [] },
      logger: { warn: () => {} },
      on: () => () => {},
      effect: (effect: () => () => void | Promise<void>) => { effects.push(effect()) },
    } as unknown as Context

    await expect(apply(ctx, { dshHome: root })).resolves.toBeUndefined()
    expect(starts).toBe(1)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(starts).toBe(2)
  })
})
