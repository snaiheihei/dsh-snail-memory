import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MemoryEntry, MemoryIndexEntry, MemoryScope, WorkspaceId } from '../../src/store/types.js'
import type { MemoryCopyKey, MemoryTranslator } from './locale.js'
import type { MemoryClientStore } from './store.js'

const GLOBAL_SCOPE: MemoryScope = { kind: 'global' }
type MemoryTab = 'global' | 'workspaces' | 'settings'

interface MemoryPageProps {
  readonly sessionId?: string | undefined
  readonly store: MemoryClientStore
  readonly t: MemoryTranslator
}

interface DetailState {
  readonly scope: MemoryScope
  readonly summary: string
  readonly id: MemoryEntry['id']
  readonly readOnly: boolean
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

const RETENTION_CATEGORIES = [
  'environment-fact', 'project-convention', 'troubleshooting', 'preference', 'long-term-decision',
] as const satisfies readonly MemoryEntry['category'][]

export function MemoryPage({ sessionId, store, t }: MemoryPageProps) {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [tab, setTab] = useState<MemoryTab>('global')
  const [workspaceSelection, setWorkspaceSelection] = useState<{ id: WorkspaceId; manual: boolean } | null>(null)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const detailRequest = useRef(0)
  const mounted = useRef(true)
  const state = sessionId === undefined ? undefined : store.getSession(sessionId)
  const workspaces = store.getWorkspaces()
  const selectedWorkspaceId = workspaceSelection !== null && workspaces?.some(item => item.id === workspaceSelection.id)
    ? workspaceSelection.id
    : !workspaceSelection?.manual && state?.workspaceId !== undefined && workspaces?.some(item => item.id === state.workspaceId)
      ? state.workspaceId
      : workspaces?.[0]?.id
  const workspaceScope: MemoryScope | undefined = selectedWorkspaceId === undefined
    ? undefined
    : { kind: 'workspace', workspaceId: selectedWorkspaceId }
  const scope = tab === 'global' ? GLOBAL_SCOPE : tab === 'workspaces' ? workspaceScope : undefined
  const index = scope === undefined ? undefined : store.getIndex(scope)
  const indexError = scope === undefined ? undefined : store.getIndexError(scope)
  const sessionError = sessionId === undefined ? undefined : store.getSessionError(sessionId)
  const workspacesError = store.getWorkspacesError()

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
    if (tab === 'workspaces') void store.loadWorkspaces()
    if (tab === 'settings') void store.loadSettings()
  }, [store, tab])
  useEffect(() => {
    if (tab === 'workspaces' && selectedWorkspaceId !== undefined) {
      void store.loadIndex({ kind: 'workspace', workspaceId: selectedWorkspaceId })
    }
  }, [store, tab, selectedWorkspaceId])

  const selectTab = (next: MemoryTab): void => {
    detailRequest.current += 1
    setDetail(null)
    setConfirming(false)
    setNotice(null)
    setTab(next)
  }

  const openDetails = async (entry: MemoryIndexEntry): Promise<void> => {
    const request = ++detailRequest.current
    const readOnly = tab === 'global'
    setDetail({ scope: entry.scope, id: entry.id, summary: entry.summary, readOnly })
    setConfirming(false)
    setNotice(null)
    try {
      const full = await store.read(entry.scope, entry.id)
      if (mounted.current && detailRequest.current === request) {
        setDetail({ scope: entry.scope, id: entry.id, summary: full.summary, entry: full, readOnly })
      }
    } catch (reason) {
      if (mounted.current && detailRequest.current === request) {
        setDetail({
          scope: entry.scope, id: entry.id, summary: entry.summary, readOnly,
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
        <button type="button" role="tab" id="snail-memory-workspaces-tab" aria-selected={tab === 'workspaces'} aria-controls="snail-memory-panel" onClick={() => selectTab('workspaces')}>{t('workspaceTab')}</button>
        <button type="button" role="tab" id="snail-memory-settings-tab" aria-selected={tab === 'settings'} aria-controls="snail-memory-panel" onClick={() => selectTab('settings')}>{t('settingsTab')}</button>
      </div>
      {notice !== null && <p role={notice === t('deleteSuccess') ? 'status' : 'alert'}>{notice}</p>}
      {sessionError !== undefined && <p className="snail-memory-error" role="alert">{sessionError}</p>}
      <div
        role="tabpanel"
        id="snail-memory-panel"
        aria-labelledby={tab === 'global' ? 'snail-memory-global-tab' : tab === 'workspaces' ? 'snail-memory-workspaces-tab' : 'snail-memory-settings-tab'}
      >
        {tab === 'settings' ? <SettingsPanel store={store} t={t} /> : <>
          {tab === 'workspaces' && <div className="snail-memory-workspace-picker">
            <label htmlFor="snail-memory-workspace-select">{t('workspaceSelect')}</label>
            <select
              id="snail-memory-workspace-select"
              value={selectedWorkspaceId ?? ''}
              disabled={workspaces === undefined || workspaces.length === 0}
              onChange={event => {
                detailRequest.current += 1
                setDetail(null)
                setConfirming(false)
                setNotice(null)
                setWorkspaceSelection({ id: event.target.value as WorkspaceId, manual: true })
              }}
            >
              {selectedWorkspaceId === undefined && <option value="" />}
              {workspaces?.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
            </select>
          </div>}
          {tab === 'workspaces' && workspacesError !== undefined && <div role="alert">{workspacesError} <button type="button" onClick={() => { void store.loadWorkspaces() }}>{t('retry')}</button></div>}
          {tab === 'workspaces' && workspaces === undefined && workspacesError === undefined && <p role="status">{t('loading')}</p>}
          {tab === 'workspaces' && workspaces?.length === 0 ? <p>{t('noWorkspaces')}</p> : scope !== undefined && <>
          {indexError !== undefined && <div role="alert">{indexError} <button type="button" onClick={() => { void store.loadIndex(scope) }}>{t('retry')}</button></div>}
          {index === undefined && indexError === undefined && <p role="status">{t('loading')}</p>}
          {index !== undefined && entries.length === 0 && <p>{t(tab === 'global' ? 'emptyGlobal' : 'emptyWorkspace')}</p>}
          <ul className="snail-memory-list">
            {entries.map(entry => (
              <li className="snail-memory-entry" key={`${entry.scope.kind}:${entry.scope.kind === 'workspace' ? entry.scope.workspaceId : ''}:${entry.id}`}>
                <h2>{entry.summary}</h2>
                <p>{t(CATEGORY_COPY[entry.category])}</p>
                {tab === 'global' && entry.scope.kind === 'workspace' && <p>{t('workspace')}: {entry.scope.workspaceId}</p>}
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
              {!detail.readOnly && <button type="button" disabled={detail.entry === undefined} onClick={() => setConfirming(true)}>{t('delete')}</button>}
              <button type="button" autoFocus onClick={closeDetails}>{t('close')}</button>
            </>}
          </div>
        </div>
      )}
    </section>
  )
}

function SettingsPanel({ store, t }: { readonly store: MemoryClientStore; readonly t: MemoryTranslator }) {
  const settings = store.getSettings()
  const error = store.getSettingsError()
  const [draft, setDraft] = useState({
    reviewEveryUserTurns: '15',
    idleDelayMinutes: '60',
    consolidationCooldownHours: '20',
    snapshotTokenBudget: '1200',
    retentionDays: {
      'environment-fact': '30',
      'project-convention': '180',
      troubleshooting: '180',
      preference: '0',
      'long-term-decision': '0',
    },
  })
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)

  useEffect(() => {
    if (settings !== undefined) {
      setDraft({
        reviewEveryUserTurns: String(settings.reviewEveryUserTurns),
        idleDelayMinutes: String(settings.idleDelayMinutes),
        consolidationCooldownHours: String(settings.consolidationCooldownHours),
        snapshotTokenBudget: String(settings.snapshotTokenBudget),
        retentionDays: {
          'environment-fact': String(settings.retentionDays['environment-fact']),
          'project-convention': String(settings.retentionDays['project-convention']),
          troubleshooting: String(settings.retentionDays.troubleshooting),
          preference: String(settings.retentionDays.preference),
          'long-term-decision': String(settings.retentionDays['long-term-decision']),
        },
      })
    }
  }, [settings])

  const save = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    setFeedback(null)
    try {
      await store.updateSettings({
        reviewEveryUserTurns: Number(draft.reviewEveryUserTurns),
        idleDelayMinutes: Number(draft.idleDelayMinutes),
        consolidationCooldownHours: Number(draft.consolidationCooldownHours),
        snapshotTokenBudget: Number(draft.snapshotTokenBudget),
        retentionDays: {
          'environment-fact': Number(draft.retentionDays['environment-fact']),
          'project-convention': Number(draft.retentionDays['project-convention']),
          troubleshooting: Number(draft.retentionDays.troubleshooting),
          preference: Number(draft.retentionDays.preference),
          'long-term-decision': Number(draft.retentionDays['long-term-decision']),
        },
      })
      setFeedback({ kind: 'status', text: t('settingsSaved') })
    } catch (reason) {
      setFeedback({ kind: 'alert', text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      setSaving(false)
    }
  }

  if (settings === undefined) {
    return <>
      {error !== undefined && <div role="alert">{error} <button type="button" onClick={() => { void store.loadSettings() }}>{t('retry')}</button></div>}
      {error === undefined && <p role="status">{t('loading')}</p>}
    </>
  }

  return (
    <form className="snail-memory-settings" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="snail-memory-setting">
        <label htmlFor="snail-memory-review-turns">{t('reviewEveryUserTurns')}</label>
        <input
          id="snail-memory-review-turns"
          type="number"
          min={1}
          step={1}
          required
          disabled={saving}
          value={draft.reviewEveryUserTurns}
          onChange={event => setDraft(current => ({ ...current, reviewEveryUserTurns: event.target.value }))}
        />
        <p>{t('reviewEveryUserTurnsHelp')}</p>
      </div>
      <div className="snail-memory-setting">
        <label htmlFor="snail-memory-idle-delay">{t('idleDelayMinutes')}</label>
        <input
          id="snail-memory-idle-delay"
          type="number"
          min={0}
          step="any"
          required
          disabled={saving}
          value={draft.idleDelayMinutes}
          onChange={event => setDraft(current => ({ ...current, idleDelayMinutes: event.target.value }))}
        />
        <p>{t('idleDelayMinutesHelp')}</p>
      </div>
      <div className="snail-memory-setting">
        <label htmlFor="snail-memory-consolidation-delay">{t('consolidationCooldownHours')}</label>
        <input
          id="snail-memory-consolidation-delay"
          type="number"
          min={0}
          step="any"
          required
          disabled={saving}
          value={draft.consolidationCooldownHours}
          onChange={event => setDraft(current => ({ ...current, consolidationCooldownHours: event.target.value }))}
        />
        <p>{t('consolidationCooldownHoursHelp')}</p>
      </div>
      <div className="snail-memory-setting">
        <label htmlFor="snail-memory-snapshot-token-budget">{t('snapshotTokenBudget')}</label>
        <input
          id="snail-memory-snapshot-token-budget"
          type="number"
          min={1}
          step={1}
          required
          disabled={saving}
          value={draft.snapshotTokenBudget}
          onChange={event => setDraft(current => ({ ...current, snapshotTokenBudget: event.target.value }))}
        />
        <p>{t('snapshotTokenBudgetHelp')}</p>
      </div>
      <fieldset className="snail-memory-retention">
        <legend>{t('retentionSettings')}</legend>
        <p>{t('retentionDaysHelp')}</p>
        {RETENTION_CATEGORIES.map(category => (
          <div className="snail-memory-setting" key={category}>
            <label htmlFor={`snail-memory-retention-${category}`}>{t(CATEGORY_COPY[category])} {t('retentionDays')}</label>
            <input
              id={`snail-memory-retention-${category}`}
              type="number"
              min={0}
              step="any"
              required
              disabled={saving}
              value={draft.retentionDays[category]}
              onChange={event => setDraft(current => ({
                ...current,
                retentionDays: { ...current.retentionDays, [category]: event.target.value },
              }))}
            />
          </div>
        ))}
      </fieldset>
      {error !== undefined && <p role="alert">{error}</p>}
      {feedback !== null && <p role={feedback.kind}>{feedback.text}</p>}
      <button type="submit" disabled={saving}>{saving ? t('savingSettings') : t('saveSettings')}</button>
    </form>
  )
}
