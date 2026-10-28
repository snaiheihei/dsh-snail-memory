import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { MemoryLayer, WorkspaceId } from '../../src/store/types.js'
import { MemoryIcon, RefreshIcon } from './icons.js'
import type { MemoryCopyKey, MemoryTranslator } from './locale.js'
import type { MemoryClientStore } from './store.js'

interface ComposerMemoryProps {
  readonly sessionId: string
  readonly store: MemoryClientStore
  readonly t: MemoryTranslator
}

type Operation = { readonly sessionId: string; readonly selection: MemoryLayer; readonly method: 'enable' | 'disable' | 'refresh' }
type Message = { readonly sessionId: string; readonly selection: MemoryLayer; readonly method: Operation['method']; readonly text: string }

export function ComposerMemory({ sessionId, store, t }: ComposerMemoryProps) {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [open, setOpen] = useState(false)
  const [selectedWorkspace, setSelectedWorkspace] = useState<WorkspaceId | null>(null)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [feedback, setFeedback] = useState<Message | null>(null)
  const [error, setError] = useState<Message | null>(null)
  const currentSession = useRef(sessionId)
  const mounted = useRef(true)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const popover = useRef<HTMLDivElement>(null)
  const popoverId = useId()
  currentSession.current = sessionId

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    setOpen(false)
    setSelectedWorkspace(null)
    setOperation(null)
    setFeedback(null)
    setError(null)
    void store.loadSession(sessionId)
  }, [sessionId, store])

  useEffect(() => {
    if (!open) return
    void store.loadWorkspaces()
    popover.current?.querySelector<HTMLButtonElement>('button')?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
      trigger.current?.focus()
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open, store])

  const state = store.getSession(sessionId)
  const sessionError = store.getSessionError(sessionId)
  const workspaces = store.getWorkspaces()
  const workspacesError = store.getWorkspacesError()
  const activeLayer: MemoryLayer | null = state?.layers.workspace.enabled ? 'workspace' : state?.layers.global.enabled ? 'global' : null
  const busy = operation?.sessionId === sessionId
  const enabledWorkspaceId = state?.selectedWorkspaceId ?? state?.workspaceId
  const selectedWorkspaceId = selectedWorkspace !== null && workspaces?.some(item => item.id === selectedWorkspace)
    ? selectedWorkspace
    : enabledWorkspaceId !== undefined && workspaces?.some(item => item.id === enabledWorkspaceId)
      ? enabledWorkspaceId
      : workspaces?.[0]?.id

  const run = async (selection: MemoryLayer, method: Operation['method']): Promise<void> => {
    if (operation !== null) return
    const target = { sessionId, selection, method } as const
    setOperation(target)
    setFeedback(null)
    setError(null)
    try {
      const result = method === 'disable' ? await store.disable(sessionId)
        : method === 'enable' ? await store.enable(sessionId, selection, selection === 'workspace' ? selectedWorkspaceId : undefined)
          : await store.refresh(sessionId, selection)
      if (!mounted.current || currentSession.current !== sessionId) return
      const suffix = selection === 'global' ? 'Global' : 'Workspace'
      const key: MemoryCopyKey = result.status === 'disabled' ? 'memoryDisabled'
        : result.status === 'up-to-date' ? `upToDate${suffix}`
          : result.status === 'refreshed' ? `refreshed${suffix}` : `enabled${suffix}`
      setFeedback({ ...target, text: t(key) })
    } catch (reason) {
      if (mounted.current && currentSession.current === sessionId) {
        setError({ ...target, text: reason instanceof Error ? reason.message : String(reason) })
      }
    } finally {
      if (mounted.current && currentSession.current === sessionId) setOperation(null)
    }
  }

  const rowMessages = (layer: MemoryLayer, method?: Operation['method']) => {
    const matches = (candidate: Operation['method']) => method === undefined ? candidate !== 'refresh' : candidate === method
    const layerBusy = busy && operation.selection === layer && matches(operation.method)
    const pending = method === undefined ? state?.layers[layer].pending ?? 0 : 0
    const notice = feedback?.sessionId === sessionId && feedback.selection === layer && matches(feedback.method) ? feedback : null
    const failure = error?.sessionId === sessionId && error.selection === layer && matches(error.method) ? error : null
    return <>
      {layerBusy && <span className="snail-memory-feedback" role="status">{t(operation.method === 'disable' ? 'disablingMemory' : `${operation.method === 'enable' ? 'enabling' : 'refreshing'}${layer === 'global' ? 'Global' : 'Workspace'}`)}</span>}
      {pending > 0 && <span className="snail-memory-feedback" role="status">{pending} {t(layer === 'global' ? 'globalSnapshotsQueued' : 'workspaceSnapshotsQueued')}</span>}
      {notice !== null && <span className="snail-memory-feedback" role="status">{notice.text}</span>}
      {failure !== null && <span className="snail-memory-feedback snail-memory-error" role="alert">{failure.text}</span>}
    </>
  }

  const enableButton = (layer: MemoryLayer) => {
    const enabled = activeLayer === layer && (layer === 'global' || selectedWorkspaceId === enabledWorkspaceId)
    const disabled = state === undefined || busy || (layer === 'workspace'
      && (selectedWorkspaceId === undefined || workspaces === undefined || workspaces.length === 0))
    return <button
      type="button"
      className="snail-memory-enable"
      aria-pressed={enabled}
      title={enabled ? t('disableMemory') : t(layer === 'global' ? 'enableGlobal' : 'enableWorkspace')}
      disabled={disabled}
      onClick={() => { void run(layer, enabled ? 'disable' : 'enable') }}
    >{enabled ? t('enabled') : t('enable')}</button>
  }

  return (
    <div className="snail-memory-controls" ref={root}>
      <button
        type="button"
        ref={trigger}
        className="snail-memory-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => { setOpen(value => !value) }}
      ><MemoryIcon size={16} /><span>{t('panel')}</span></button>
      {open && <div className="snail-memory-popover" id={popoverId} ref={popover} role="dialog" aria-modal={false} aria-label={t('panel')}>
        <div className="snail-memory-row" role="group" aria-label={t('global')}>
          <span className="snail-memory-row-label">{t('global')}</span>
          {enableButton('global')}
          {state === undefined && sessionError === undefined && <span className="snail-memory-feedback" role="status">{t('loading')}</span>}
          {sessionError !== undefined && <span className="snail-memory-feedback snail-memory-error" role="alert">{sessionError}</span>}
          {rowMessages('global')}
        </div>
        <div className="snail-memory-row" role="group" aria-label={t('workspace')}>
          <select
            aria-label={t('workspaceTab')}
            value={selectedWorkspaceId ?? ''}
            disabled={busy || workspaces === undefined || workspaces.length === 0}
            onChange={event => {
              setSelectedWorkspace(event.target.value as WorkspaceId)
              setFeedback(null)
              setError(null)
            }}
          >
            {selectedWorkspaceId === undefined && <option value="">{workspaces?.length === 0 ? t('noWorkspaces') : ''}</option>}
            {workspaces?.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
          </select>
          {enableButton('workspace')}
          {workspaces === undefined && workspacesError === undefined && <span className="snail-memory-feedback" role="status">{t('loading')}</span>}
          {workspacesError !== undefined && <span className="snail-memory-feedback snail-memory-error" role="alert">{workspacesError}</span>}
          {rowMessages('workspace')}
        </div>
        <div className="snail-memory-row snail-memory-refresh-row">
          <button
            type="button"
            className="snail-memory-refresh"
            title={activeLayer === null ? t('refresh') : t(activeLayer === 'global' ? 'refreshGlobal' : 'refreshWorkspace')}
            disabled={state === undefined || activeLayer === null || busy}
            onClick={() => { if (activeLayer !== null) void run(activeLayer, 'refresh') }}
          ><RefreshIcon /><span>{t('refresh')}</span></button>
          {activeLayer !== null && rowMessages(activeLayer, 'refresh')}
        </div>
      </div>}
    </div>
  )
}
