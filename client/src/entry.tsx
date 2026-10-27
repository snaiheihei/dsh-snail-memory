import type { Context } from '@deepseek-ai/cordis'
import { ComposerMemory } from './ComposerMemory.js'
import { MemoryIcon } from './icons.js'
import { copy, type MemoryTranslator } from './locale.js'
import { MemoryPage } from './MemoryPage.js'
import { createMemoryRpc } from './rpc.js'
import { MemoryClientStore } from './store.js'
import { installMemoryStyles } from './styles.js'

export const MEMORY_PANEL_ID = 'memory'
const LOCALE_NAMESPACE = 'snailMemory'

interface SessionListSnapshot {
  readonly byId: Readonly<Record<string, {
    readonly id: string
    readonly retainedBy?: { readonly mainView?: number }
  }>>
}

interface MainSlotProps {
  readonly useSessions: <T>(selector: (snapshot: SessionListSnapshot) => T) => T
}

interface MemoryClientContext {
  effect(effect: () => void | (() => void), description?: string): unknown
  slots: {
    inject(name: string, register: () => unknown): unknown
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  locale: {
    register(namespace: string, dictionaries: typeof copy): () => void
    bind(namespace: string): MemoryTranslator
  }
}

export const inject = ['slots', 'locale']

export function apply(context: Context): void {
  const ctx = context as unknown as MemoryClientContext
  const store = new MemoryClientStore(createMemoryRpc((input, init) => fetch(input, init)))
  const t = ctx.locale.bind(LOCALE_NAMESPACE)
  ctx.effect(() => store.listen(), 'snail-memory: focus refresh')
  ctx.effect(() => () => { store.dispose() }, 'snail-memory: store')
  ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, copy), 'snail-memory: dictionaries')
  ctx.effect(() => installMemoryStyles(document), 'snail-memory: styles')

  function ComposerSlot({ sessionId }: { readonly sessionId: string }) {
    return <ComposerMemory sessionId={sessionId} store={store} t={t} />
  }
  function MainSlot({ useSessions }: MainSlotProps) {
    const sessionId = useSessions(snapshot => Object.values(snapshot.byId)
      .find(session => (session.retainedBy?.mainView ?? 0) > 0)?.id)
    return <MemoryPage sessionId={sessionId} store={store} t={t} />
  }
  function SidebarSlot({ size }: { readonly size?: number }) {
    return <MemoryIcon size={size} />
  }

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left', id: 'snail-memory', order: 20, locale: LOCALE_NAMESPACE,
  }, ComposerSlot))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: MEMORY_PANEL_ID, locale: LOCALE_NAMESPACE,
  }, MainSlot))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist', id: MEMORY_PANEL_ID, order: 20, locale: LOCALE_NAMESPACE, label: () => t('panel'),
  }, SidebarSlot))
}
