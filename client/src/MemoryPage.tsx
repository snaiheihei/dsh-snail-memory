import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { MemoryEntry, MemoryIndexEntry, MemoryScope } from '../../src/store/types.js'
import type { MemoryCopyKey, MemoryTranslator } from './locale.js'
import type { MemoryClientStore } from './store.js'

const GLOBAL_SCOPE: MemoryScope = { kind: 'global' }

interface MemoryPageProps {
  readonly sessionId?: string | undefined
  readonly store: MemoryClientStore
  readonly t: MemoryTranslator
}

interface DetailState {
  readonly scope: MemoryScope
  readonly summary: string
  readonly id: MemoryEntry['id']
  readonly entry?: MemoryEntry
  readonly error?: string
}

const CATEGORY_COPY = {
  preference: 'preference',
  'project-convention': 'projectConvention',
  'environment-fact': 'environmentFact',
  troubleshooting: 'troubleshooting',
  'long-term-decision': 'longTermDecision',
} as const satisfies Record<MemoryEntry['category'], MemoryCopyKey>

export function MemoryPage({ sessionId, store, t }: MemoryPageProps) {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [tab, setTab] = useState<'global' | 'workspace'>('global')
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const mounted = useRef(true)
  const state = sessionId === undefined ? undefined : store.getSession(sessionId)
  const workspaceScope = useMemo<MemoryScope | undefined>(() => state?.workspaceId === undefined
    ? undefined
    : { kind: 'workspace', workspaceId: state.workspaceId }, [state?.workspaceId])
  const scope = tab === 'global' ? GLOBAL_SCOPE : workspaceScope
  const index = scope === undefined ? undefined : store.getIndex(scope)
  const indexError = scope === undefined ? undefined : store.getIndexError(scope)
  const sessionError = sessionId === undefined ? undefined : store.getSessionError(sessionId)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      detailRequest.current += 1
    }
  }, [])
  useEffect(() => { void store.loadIndex(GLOBAL_SCOPE) }, [store])
  useEffect(() => {
    setNotice(null)
    setDetail(null)
    detailRequest.current += 1
    if (sessionId !== undefined) void store.loadSession(sessionId)
  }, [sessionId, store])
  useEffect(() => {
    if (workspaceScope !== undefined) void store.loadIndex(workspaceScope)
  }, [store, workspaceScope])

  const selectTab = (next: 'global' | 'workspace'): void => {
    detailRequest.current += 1
    setDetail(null)
    setConfirming(false)
    setNotice(null)
    setTab(next)
  }

  const openDetails = async (entry: MemoryIndexEntry): Promise<void> => {
    const request = ++detailRequest.current
    setDetail({ scope: entry.scope, id: entry.id, summary: entry.summary })
    setConfirming(false)
    setNotice(null)
    try {
      const full = await store.read(entry.scope, entry.id)
      if (mounted.current && detailRequest.current === request) {
        setDetail({ scope: entry.scope, id: entry.id, summary: full.summary, entry: full })
      }
    } catch (reason) {
      if (mounted.current && detailRequest.current === request) {
        setDetail({
          scope: entry.scope, id: entry.id, summary: entry.summary,
          error: reason instanceof Error ? reason.message : String(reason),
        })
      }
    }
  }

  const closeDetails = (): void => {
    if (deleting) return
    detailRequest.current += 1
    setDetail(null)
    setConfirming(false)
  }

  const remove = async (): Promise<void> => {
    if (detail === null || deleting) return
    const target = detail
    setDeleting(true)
    try {
      await store.remove(target.scope, target.id)
      if (!mounted.current) return
      detailRequest.current += 1
      setDetail(null)
      setConfirming(false)
      setNotice(t('deleteSuccess'))
    } catch (reason) {
      if (mounted.current) setNotice(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mounted.current) setDeleting(false)
    }
  }

  const revisions = state === undefined ? [] : [state.layers.global.desiredRevision, state.layers.workspace.desiredRevision]
    .filter((revision): revision is number => revision !== null)
  const latestRevision = revisions.length === 0 ? null : Math.max(...revisions)
  const tokens = (state?.layers.global.committedTokens ?? 0) + (state?.layers.workspace.committedTokens ?? 0)
  const entries = index?.entries ?? []

  return (
    <section className="snail-memory-page" aria-label={t('title')}>
      <header>
        <h1>{t('title')}</h1>
        <div className="snail-memory-stats" aria-label={t('title')}>
          <span>{entries.length} {t(entries.length === 1 ? 'activeMemorySingular' : 'activeMemoryPlural')}</span>
          <span>{t('estimatedTokens')}: {tokens}</span>
          <span>{latestRevision === null ? t('noSnapshot') : `${t('latestSnapshot')}: ${t('revision')} ${latestRevision}`}</span>
        </div>
      </header>
      <div className="snail-memory-tabs" role="tablist" aria-label={t('title')}>
        <button type="button" role="tab" id="snail-memory-global-tab" aria-selected={tab === 'global'} aria-controls="snail-memory-panel" onClick={() => selectTab('global')}>{t('globalTab')}</button>
        <button type="button" role="tab" id="snail-memory-workspace-tab" aria-selected={tab === 'workspace'} aria-controls="snail-memory-panel" onClick={() => selectTab('workspace')}>{t('workspaceTab')}</button>
      </div>
      {notice !== null && <p role={notice === t('deleteSuccess') ? 'status' : 'alert'}>{notice}</p>}
      {sessionError !== undefined && <p className="snail-memory-error" role="alert">{sessionError}</p>}
      <div
        role="tabpanel"
        id="snail-memory-panel"
        aria-labelledby={tab === 'global' ? 'snail-memory-global-tab' : 'snail-memory-workspace-tab'}
      >
        {scope === undefined ? <p>{t('noWorkspace')}</p> : <>
          {indexError !== undefined && <div role="alert">{indexError} <button type="button" onClick={() => { void store.loadIndex(scope) }}>{t('retry')}</button></div>}
          {index === undefined && indexError === undefined && <p role="status">{t('loading')}</p>}
          {index !== undefined && entries.length === 0 && <p>{t(tab === 'global' ? 'emptyGlobal' : 'emptyWorkspace')}</p>}
          <ul className="snail-memory-list">
            {entries.map(entry => (
              <li className="snail-memory-entry" key={entry.id}>
                <h2>{entry.summary}</h2>
                <p>{t(CATEGORY_COPY[entry.category])}</p>
                <small>{t('updatedAt')}: {entry.updatedAt} · {t('revision')} {entry.revision}</small>
                {entry.sourceRefs.length > 0 && (
                  <p>{t('sources')}: {entry.sourceRefs.map(ref => `${ref.sessionId}${ref.eventSeqs === undefined ? '' : ` (${t('events')} ${ref.eventSeqs.join(', ')})`}`).join('; ')}</p>
                )}
                <button type="button" aria-label={`${t('viewDetails')} ${entry.summary}`} onClick={() => { void openDetails(entry) }}>{t('details')}</button>
              </li>
            ))}
          </ul>
          {tab === 'global' && index !== undefined && index.workspaces.length > 0 && (
            <section aria-label={t('workspaceReferences')}>
              <h2>{t('workspaceReferences')}</h2>
              <ul className="snail-memory-list">
                {index.workspaces.map(workspace => (
                  <li className="snail-memory-entry" key={workspace.workspaceId}>
                    <strong>{workspace.workspaceId}</strong>
                    <p>{workspace.entryCount} {t('entries')} · {t('revision')} {workspace.revision}</p>
                    <small>{t('updatedAt')}: {workspace.updatedAt}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>}
      </div>
      {detail !== null && (
        <div className="snail-memory-detail" role="dialog" aria-modal="true" aria-labelledby="snail-memory-detail-title">
          <h2 id="snail-memory-detail-title">{detail.summary}</h2>
          {detail.entry === undefined && detail.error === undefined && <p role="status">{t('loading')}</p>}
          {detail.error !== undefined && <p role="alert">{detail.error}</p>}
          {detail.entry !== undefined && <>
            <p>{t('category')}: {t(CATEGORY_COPY[detail.entry.category])}</p>
            <p>{t('updatedAt')}: {detail.entry.updatedAt}</p>
            <pre>{detail.entry.detail}</pre>
          </>}
          {confirming && <p role="alert">{t('deleteConfirmation')}</p>}
          <div className="snail-memory-actions">
            {confirming ? <>
              <button type="button" autoFocus disabled={deleting} onClick={() => { void remove() }}>{deleting ? t('deleting') : t('confirmDelete')}</button>
              <button type="button" disabled={deleting} onClick={() => setConfirming(false)}>{t('cancel')}</button>
            </> : <>
              <button type="button" disabled={detail.entry === undefined} onClick={() => setConfirming(true)}>{t('delete')}</button>
              <button type="button" autoFocus onClick={closeDetails}>{t('close')}</button>
            </>}
          </div>
        </div>
      )}
    </section>
  )
}
