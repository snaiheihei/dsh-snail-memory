import { readFile } from 'node:fs/promises'
import type { MemorySettings } from '../contract.js'
import { writeJsonAtomic } from '../store/json.js'
import { MemoryStoreReadonlyError, type MemoryStore } from '../store/store.js'
import type { MemoryCategory } from '../store/types.js'

const CATEGORIES: readonly MemoryCategory[] = ['preference', 'project-convention', 'environment-fact', 'troubleshooting', 'long-term-decision']

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
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

function validate(value: unknown): MemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Memory settings must be an object')
  const input = value as Record<string, unknown>
  if (!Number.isSafeInteger(input.reviewEveryUserTurns) || (input.reviewEveryUserTurns as number) < 1) {
    throw new Error('reviewEveryUserTurns must be a positive integer')
  }
  if (typeof input.idleDelayMinutes !== 'number' || !Number.isFinite(input.idleDelayMinutes) || input.idleDelayMinutes < 0) {
    throw new Error('idleDelayMinutes must be a non-negative finite number')
  }
  if (typeof input.consolidationCooldownHours !== 'number'
    || !Number.isFinite(input.consolidationCooldownHours) || input.consolidationCooldownHours < 0) {
    throw new Error('consolidationCooldownHours must be a non-negative finite number')
  }
  if (typeof input.globalConsolidationCooldownDays !== 'number'
    || !Number.isFinite(input.globalConsolidationCooldownDays) || input.globalConsolidationCooldownDays < 0) {
    throw new Error('globalConsolidationCooldownDays must be a non-negative finite number')
  }
  if (!Number.isSafeInteger(input.snapshotTokenBudget) || (input.snapshotTokenBudget as number) < 1) {
    throw new Error('snapshotTokenBudget must be a positive integer')
  }
  if (!input.retentionDays || typeof input.retentionDays !== 'object' || Array.isArray(input.retentionDays)) {
    throw new Error('retentionDays must be an object')
  }
  const retention = input.retentionDays as Record<string, unknown>
  const retentionDays = {} as Record<MemoryCategory, number>
  for (const category of CATEGORIES) {
    const days = retention[category]
    if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
      throw new Error(`retentionDays.${category} must be a non-negative finite number`)
    }
    retentionDays[category] = days
  }
  return {
    reviewEveryUserTurns: input.reviewEveryUserTurns as number,
    idleDelayMinutes: input.idleDelayMinutes,
    consolidationCooldownHours: input.consolidationCooldownHours,
    globalConsolidationCooldownDays: input.globalConsolidationCooldownDays,
    snapshotTokenBudget: input.snapshotTokenBudget as number,
    retentionDays,
  }
}

function clone(settings: MemorySettings): MemorySettings {
  return { ...settings, retentionDays: { ...settings.retentionDays } }
}

/** UI-owned lifecycle settings, persisted inside the MemoryStore writer boundary. */
export class MemorySettingsStore {
  private current: MemorySettings
  private queue: Promise<void> = Promise.resolve()

  private constructor(private readonly store: MemoryStore, defaults: MemorySettings) {
    this.current = defaults
  }

  static async open(store: MemoryStore, defaults: MemorySettings = DEFAULT_MEMORY_SETTINGS): Promise<MemorySettingsStore> {
    const initial = validate(defaults)
    const settings = new MemorySettingsStore(store, initial)
    let text: string
    try {
      text = await readFile(store.paths.settings, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return settings
      throw error
    }
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || (value as Record<string, unknown>).formatVersion !== 1) {
      throw new Error('Memory settings have an unsupported format')
    }
    settings.current = validate({ ...initial, ...value })
    return settings
  }

  get(): MemorySettings {
    return clone(this.current)
  }

  update(input: MemorySettings): Promise<MemorySettings> {
    const operation = this.queue.then(async () => {
      if (!this.store.writable) throw new MemoryStoreReadonlyError()
      const next = validate(input)
      await writeJsonAtomic(this.store.paths.settings, { formatVersion: 1, ...next })
      this.current = next
      return clone(next)
    })
    this.queue = operation.then(() => {}, () => {})
    return operation
  }
}
