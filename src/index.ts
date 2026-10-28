import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-workspace'
import z from '@deepseek-ai/schemastery'
import { MemoryController } from './api/controller.js'
import { registerMemoryApi } from './api/index.js'
import { MemoryContextService } from './context/service.js'
import { registerMemoryReadTool } from './context/tool.js'
import { MemoryLifecycleService } from './lifecycle/service.js'
import { WriterLifecycleRuntime } from './lifecycle/scheduler.js'
import { DEFAULT_MEMORY_SETTINGS, MemorySettingsStore } from './lifecycle/settings.js'
import { MemoryStore } from './store/store.js'
import { workspaceId } from './store/types.js'
import { DshAuxiliaryModel, resolveSessionWorkspace, selectModelRoute, type TranscriptEvent } from './runtime.js'

export const name = 'snail-memory'
export const inject = ['agents', 'commands', 'llm', 'tools', 'webServer', 'workspaceRegistry'] as const

export interface Config {
  readonly dshHome?: string
  readonly provider?: string
  readonly model?: string
  readonly reviewEveryUserTurns?: number
  readonly idleDelayMinutes?: number
  readonly consolidationCooldownHours?: number
  readonly globalConsolidationCooldownDays?: number
  readonly retentionSweepHours?: number
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  provider: z.string(),
  model: z.string(),
  reviewEveryUserTurns: z.number().min(1).default(15),
  idleDelayMinutes: z.number().min(0).default(60),
  consolidationCooldownHours: z.number().min(0).default(20),
  globalConsolidationCooldownDays: z.number().min(0).default(7),
  retentionSweepHours: z.number().min(0).default(24),
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  const root = join(resolveDshHome(config.dshHome), 'snail_memory')
  const store = await MemoryStore.open({ root })
  let settings: MemorySettingsStore
  try {
    settings = await MemorySettingsStore.open(store, {
      reviewEveryUserTurns: config.reviewEveryUserTurns ?? 15,
      idleDelayMinutes: config.idleDelayMinutes ?? 60,
      consolidationCooldownHours: config.consolidationCooldownHours ?? 20,
      globalConsolidationCooldownDays: config.globalConsolidationCooldownDays ?? 7,
      snapshotTokenBudget: DEFAULT_MEMORY_SETTINGS.snapshotTokenBudget,
      retentionDays: { ...DEFAULT_MEMORY_SETTINGS.retentionDays },
    })
  } catch (error) {
    await store.close()
    throw error
  }
  const memories = new MemoryContextService(store, {
    getSnapshotTokenBudget: () => settings.get().snapshotTokenBudget,
  })
  const transcripts = new Map<string, readonly TranscriptEvent[]>()
  const configuredRoute = config.provider && config.model ? { provider: config.provider, model: config.model } : undefined
  const lifecycle = new MemoryLifecycleService(store, {
    settings,
    model: new DshAuxiliaryModel(ctx.llm),
    route: () => selectModelRoute(ctx.agents.list(), configuredRoute),
    ...(config.reviewEveryUserTurns === undefined ? {} : { reviewEveryUserTurns: config.reviewEveryUserTurns }),
    ...(config.idleDelayMinutes === undefined ? {} : { idleDelayMinutes: config.idleDelayMinutes }),
    ...(config.consolidationCooldownHours === undefined ? {} : { consolidationCooldownHours: config.consolidationCooldownHours }),
    ...(config.globalConsolidationCooldownDays === undefined ? {} : { globalConsolidationCooldownDays: config.globalConsolidationCooldownDays }),
    ...(config.retentionSweepHours === undefined ? {} : { retentionSweepHours: config.retentionSweepHours }),
    transcriptEvents: sessionId => {
      const agent = ctx.agents.get(SessionId(sessionId))
      const events = agent ? agent.session.snapshotEvents() : transcripts.get(sessionId)
      if (events === undefined) throw new Error('Session transcript is not currently available')
      return events
    },
    runMaintenance: (sessionId, task) => {
      const agent = ctx.agents.get(SessionId(sessionId))
      return agent ? agent.runMaintenance(signal => task(signal)) : task(new AbortController().signal)
    },
  })
  const resolveSession = (sessionId: string) => {
    const agent = ctx.agents.get(SessionId(sessionId))
    if (!agent) return undefined
    const workspaceId = resolveSessionWorkspace(ctx.workspaceRegistry.list(), sessionId)
    return { agent, ...(workspaceId === undefined ? {} : { workspaceId }) }
  }
  const controller = new MemoryController(store, memories, {
    resolveSession,
    isWorkspace: id => ctx.workspaceRegistry.list().some(workspace => workspace.id === id),
    lifecycle,
    settings: lifecycle,
    listWorkspaces: () => ctx.workspaceRegistry.list().map(workspace => ({ id: workspaceId(workspace.id), title: workspace.title })),
  })
  const disposeApi = registerMemoryApi(ctx, controller)
  const disposeTool = registerMemoryReadTool(ctx, memories)

  const prepareAgent = async (agent: Agent) => {
    const sessionId = agent.session.id
    const owner = resolveSessionWorkspace(ctx.workspaceRegistry.list(), sessionId)
    if (store.writable) {
      await store.updateSessionState(sessionId, state => {
        if (owner) state.workspaceId = owner
        else delete state.workspaceId
      })
    }
    await memories.restore(agent)
  }
  ctx.on('agent/created', async ({ agent }) => {
    await prepareAgent(agent)
    return undefined
  })
  ctx.on('agent/inbox/discarded', ({ agent, message }) => memories.handleDiscarded(agent.session.id, message))
  ctx.on('agent/pre-step', ({ agent, messages, turn, step }, next) =>
    memories.handlePreStep(agent, { messages, turn, step }, next))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    // A refreshed generation claimed in a later step of the same turn is deferred until the agent settles.
    void memories.restore(agent).catch(() => {
      ctx.logger.warn('[snail-memory] Could not restore a deferred memory injection')
    })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    void lifecycle.handleSessionEvent(agent.session.id, { type: 'agent/stop', data: {} }).catch(() => {
      ctx.logger.warn('[snail-memory] Could not schedule session-end distillation')
    })
  })
  ctx.on('session/event', (session, event) => {
    transcripts.set(session.id, session.snapshotEvents())
    if (transcripts.size > 50) transcripts.delete(transcripts.keys().next().value!)
    void memories.handleSessionEvent(session.id, event).catch(() => {
      ctx.logger.warn('[snail-memory] Could not reconcile a memory injection')
    })
    void lifecycle.handleSessionEvent(session.id, event).catch(() => {
      ctx.logger.warn('[snail-memory] Could not schedule memory maintenance')
    })
  })
  for (const agent of ctx.agents.list()) await prepareAgent(agent)
  const writerRuntime = new WriterLifecycleRuntime({
    prepare: async () => {
      for (const agent of ctx.agents.list()) await prepareAgent(agent)
    },
    start: () => lifecycle.start(),
    stop: () => lifecycle.stop(),
    onError: () => {
      ctx.logger.warn('[snail-memory] Could not apply writer lock transition')
    },
  })
  const disposeWritable = store.onWritableChange(writable => { writerRuntime.setWritable(writable) })
  writerRuntime.setWritable(store.writable)
  await writerRuntime.drain()

  ctx.effect(() => async () => {
    disposeWritable()
    disposeApi()
    disposeTool()
    await writerRuntime.dispose()
    await lifecycle.dispose()
    await store.close()
  })
}

export type * from './contract.js'
