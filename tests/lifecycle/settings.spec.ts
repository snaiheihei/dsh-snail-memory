import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryLifecycleService } from '../../src/lifecycle/service.js'
import { MemorySettingsStore } from '../../src/lifecycle/settings.js'
import { MemoryStore } from '../../src/store/store.js'
import { workspaceId } from '../../src/store/types.js'

const roots: string[] = []
const stores: MemoryStore[] = []

async function open(root: string) {
  const store = await MemoryStore.open({ root, heartbeatMs: 60_000 })
  stores.push(store)
  return store
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const DEFAULT_SETTINGS = {
  reviewEveryUserTurns: 15,
  idleDelayMinutes: 60,
  consolidationCooldownHours: 20,
  globalConsolidationCooldownDays: 7,
  snapshotTokenBudget: 1_200,
  retentionDays: {
    'environment-fact': 30,
    'project-convention': 180,
    troubleshooting: 180,
    preference: 0,
    'long-term-decision': 0,
  },
}

const CUSTOM_SETTINGS = {
  reviewEveryUserTurns: 4,
  idleDelayMinutes: 2.5,
  consolidationCooldownHours: 8,
  globalConsolidationCooldownDays: 3,
  snapshotTokenBudget: 800,
  retentionDays: {
    'environment-fact': 0,
    'project-convention': 90,
    troubleshooting: 120,
    preference: 1,
    'long-term-decision': 365,
  },
}

describe('MemorySettingsStore', () => {
  it('persists UI settings atomically and restores them after reopening', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-settings-'))
    roots.push(root)
    const store = await open(root)
    const settings = await MemorySettingsStore.open(store)

    expect(settings.get()).toEqual(DEFAULT_SETTINGS)
    await expect(settings.update(CUSTOM_SETTINGS)).resolves.toEqual(CUSTOM_SETTINGS)
    expect(JSON.parse(await readFile(store.paths.settings, 'utf8'))).toEqual({ formatVersion: 1, ...CUSTOM_SETTINGS })

    const restored = await MemorySettingsStore.open(store)
    expect(restored.get()).toEqual(CUSTOM_SETTINGS)
  })

  it('reads an older settings file and supplies the new dirty and retention defaults', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-settings-'))
    roots.push(root)
    const store = await open(root)
    await writeFile(store.paths.settings, JSON.stringify({
      formatVersion: 1,
      reviewEveryUserTurns: 10,
      idleDelayMinutes: 15,
    }))

    const settings = await MemorySettingsStore.open(store)
    expect(settings.get()).toEqual({ ...DEFAULT_SETTINGS, reviewEveryUserTurns: 10, idleDelayMinutes: 15 })
  })

  it('keeps settings readable but rejects updates on a secondary host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-settings-'))
    roots.push(root)
    const primary = await open(root)
    const settings = await MemorySettingsStore.open(primary)
    await settings.update(CUSTOM_SETTINGS)
    const secondary = await open(root)
    const readonlySettings = await MemorySettingsStore.open(secondary)

    expect(readonlySettings.get()).toEqual(CUSTOM_SETTINGS)
    await expect(readonlySettings.update({ ...CUSTOM_SETTINGS, reviewEveryUserTurns: 8 }))
      .rejects.toMatchObject({ name: 'MemoryStoreReadonlyError' })
    expect(readonlySettings.get()).toEqual(CUSTOM_SETTINGS)
  })

  it('publishes persisted values and applies changed retention policies through the running lifecycle', async () => {
    const root = await mkdtemp(join(tmpdir(), 'snail-memory-settings-'))
    roots.push(root)
    const store = await open(root)
    const settings = await MemorySettingsStore.open(store)
    const lifecycle = new MemoryLifecycleService(store, { settings, now: () => new Date('2026-10-26T00:00:00.000Z') })
    const scope = { kind: 'workspace', workspaceId: workspaceId('workspace-1') } as const
    await store.upsert({ scope, category: 'environment-fact', summary: 'Keep environment', detail: 'Zero disables automatic expiry.', sourceRefs: [], lastVerifiedAt: '2020-01-01T00:00:00.000Z' })
    await store.upsert({ scope, category: 'preference', summary: 'Expire preference', detail: 'The new one-day policy applies.', sourceRefs: [], lastVerifiedAt: '2026-10-20T00:00:00.000Z' })

    await expect(lifecycle.updateSettings(CUSTOM_SETTINGS)).resolves.toEqual(CUSTOM_SETTINGS)
    expect(lifecycle.getSettings()).toEqual(CUSTOM_SETTINGS)
    await lifecycle.retentionSweep()
    expect(store.list(scope).entries.map(entry => entry.category)).toEqual(['environment-fact'])
    await lifecycle.dispose()
  })
})
