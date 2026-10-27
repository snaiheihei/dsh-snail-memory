import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MemoryLayer } from '../../src/store/types.js'
import { RefreshIcon } from './icons.js'
import type { MemoryCopyKey, MemoryTranslator } from './locale.js'
import type { MemoryClientStore } from './store.js'

interface ComposerMemoryProps {
  readonly sessionId: string
  readonly store: MemoryClientStore
  readonly t: MemoryTranslator
}

type Operation = { readonly sessionId: string; readonly layer: MemoryLayer; readonly method: 'enable' | 'refresh' }

export function ComposerMemory({ sessionId, store, t }: ComposerMemoryProps) {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [feedback, setFeedback] = useState<{ readonly sessionId: string; readonly text: string } | null>(null)
  const [error, setError] = useState<{ readonly sessionId: string; readonly text: string } | null>(null)
  const currentSession = useRef(sessionId)
  const mounted = useRef(true)
  currentSession.current = sessionId

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setOperation(null)
    setFeedback(null)
    setError(null)
    void store.loadSession(sessionId)
  }, [sessionId, store])

  const state = store.getSession(sessionId)
  const unavailable = state?.workspaceId === undefined

  const run = async (layer: MemoryLayer, method: 'enable' | 'refresh'): Promise<void> => {
    if (operation !== null) return
    const target = { sessionId, layer, method } as const
    setOperation(target)
    setFeedback(null)
    setError(null)
    try {
      const result = method === 'enable' ? await store.enable(sessionId, layer) : await store.refresh(sessionId, layer)
      if (!mounted.current || currentSession.current !== sessionId) return
      const suffix = layer === 'global' ? 'Global' : 'Workspace'
      const key: MemoryCopyKey = result.status === 'up-to-date' ? `upToDate${suffix}`
        : result.status === 'refreshed' ? `refreshed${suffix}` : `enabled${suffix}`
      setFeedback({ sessionId, text: t(key) })
    } catch (reason) {
      if (mounted.current && currentSession.current === sessionId) {
        setError({ sessionId, text: reason instanceof Error ? reason.message : String(reason) })
      }
    } finally {
      if (mounted.current && currentSession.current === sessionId) setOperation(null)
    }
  }

  return (
    <div className="snail-memory-controls" aria-label={t('panel')}>
      {(['global', 'workspace'] as const).map(layer => {
        const layerState = state?.layers[layer]
        const enabled = layerState?.enabled === true
        const busy = operation?.sessionId === sessionId && operation.layer === layer
        const workspaceDisabled = layer === 'workspace' && unavailable
        const suffix = layer === 'global' ? 'Global' : 'Workspace'
        return (
          <div className="snail-memory-layer" key={layer} title={workspaceDisabled ? t('ungrouped') : t(layer)}>
            <span className="snail-memory-status">{layer === 'global' ? 'G' : 'W'}</span>
            {enabled && <span className="snail-memory-status">{t('enabled')}</span>}
            {!enabled && (
              <button
                type="button"
                aria-label={t(`enable${suffix}`)}
                disabled={state === undefined || busy || workspaceDisabled}
                onClick={() => { void run(layer, 'enable') }}
              >+</button>
            )}
            <button
              type="button"
              aria-label={t(`refresh${suffix}`)}
              disabled={!enabled || busy || workspaceDisabled}
              onClick={() => { void run(layer, 'refresh') }}
            ><RefreshIcon /></button>
            {busy && <span className="snail-memory-feedback" role="status">{t(`${operation?.method === 'enable' ? 'enabling' : 'refreshing'}${suffix}`)}</span>}
            {(layerState?.pending ?? 0) > 0 && (
              <span className="snail-memory-feedback" role="status">{layerState?.pending ?? 0} {t(layer === 'global' ? 'globalSnapshotsQueued' : 'workspaceSnapshotsQueued')}</span>
            )}
          </div>
        )
      })}
      {unavailable && <span className="snail-memory-feedback">{t('ungrouped')}</span>}
      {feedback?.sessionId === sessionId && <span className="snail-memory-feedback" role="status">{feedback.text}</span>}
      {error?.sessionId === sessionId && <span className="snail-memory-feedback snail-memory-error" role="alert">{error.text}</span>}
    </div>
  )
}
