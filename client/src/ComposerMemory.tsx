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

type Selection = 'disabled' | MemoryLayer
type Operation = { readonly sessionId: string; readonly selection: Selection; readonly method: 'enable' | 'disable' | 'refresh' }

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
  const selection: Selection = state?.layers.workspace.enabled ? 'workspace' : state?.layers.global.enabled ? 'global' : 'disabled'
  const busy = operation?.sessionId === sessionId

  const run = async (targetSelection: Selection, method: 'enable' | 'disable' | 'refresh'): Promise<void> => {
    if (operation !== null) return
    const target = { sessionId, selection: targetSelection, method } as const
    setOperation(target)
    setFeedback(null)
    setError(null)
    try {
      const result = method === 'disable' ? await store.disable(sessionId)
        : method === 'enable' ? await store.enable(sessionId, targetSelection as MemoryLayer)
          : await store.refresh(sessionId, targetSelection as MemoryLayer)
      if (!mounted.current || currentSession.current !== sessionId) return
      const suffix = targetSelection === 'global' ? 'Global' : 'Workspace'
      const key: MemoryCopyKey = result.status === 'disabled' ? 'memoryDisabled'
        : result.status === 'up-to-date' ? `upToDate${suffix}`
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
    <div className="snail-memory-controls">
      <div className="snail-memory-layer" role="radiogroup" aria-label={t('panel')}>
        {(['disabled', 'workspace', 'global'] as const).map(option => {
          const suffix = option === 'global' ? 'Global' : 'Workspace'
          const label = option === 'disabled' ? t('disableMemory') : t(`enable${suffix}`)
          return (
            <label key={option} title={option === 'workspace' && unavailable ? t('ungrouped') : label}>
              <input
                type="radio"
                name={`snail-memory-layer-${sessionId}`}
                value={option}
                checked={selection === option}
                disabled={state === undefined || busy || (option === 'workspace' && unavailable)}
                onChange={() => { void run(option, option === 'disabled' ? 'disable' : 'enable') }}
              />
              {label}
            </label>
          )
        })}
        {selection !== 'disabled' && <button
          type="button"
          aria-label={t(selection === 'global' ? 'refreshGlobal' : 'refreshWorkspace')}
          disabled={state === undefined || busy}
          onClick={() => { void run(selection, 'refresh') }}
        ><RefreshIcon /></button>}
      </div>
      {busy && <span className="snail-memory-feedback" role="status">{t(operation.method === 'disable' ? 'disablingMemory' : `${operation.method === 'enable' ? 'enabling' : 'refreshing'}${operation.selection === 'global' ? 'Global' : 'Workspace'}`)}</span>}
      {selection !== 'disabled' && (state?.layers[selection].pending ?? 0) > 0 && (
        <span className="snail-memory-feedback" role="status">{state?.layers[selection].pending ?? 0} {t(selection === 'global' ? 'globalSnapshotsQueued' : 'workspaceSnapshotsQueued')}</span>
      )}
      {unavailable && <span className="snail-memory-feedback">{t('ungrouped')}</span>}
      {feedback?.sessionId === sessionId && <span className="snail-memory-feedback" role="status">{feedback.text}</span>}
      {error?.sessionId === sessionId && <span className="snail-memory-feedback snail-memory-error" role="alert">{error.text}</span>}
    </div>
  )
}
