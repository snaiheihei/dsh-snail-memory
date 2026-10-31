import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { MemoryEntry, MemoryIndexEntry, MemoryScope, WorkspaceId } from '../../src/store/types.js'
import { formatBeijingMinute, formatBeijingTime } from '../../src/time.js'
import { formatCount } from './format.js'
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

const CATEGORY_ORDER = [
  'preference', 'project-convention', 'environment-fact', 'troubleshooting', 'long-term-decision',
] as const satisfies readonly MemoryEntry['category'][]

const CATEGORY_HELP = {
  preference: 'preferenceHelp',
  'project-convention': 'projectConventionHelp',
  'environment-fact': 'environmentFactHelp',
  troubleshooting: 'troubleshootingHelp',
  'long-term-decision': 'longTermDecisionHelp',
} as const satisfies Record<MemoryEntry['category'], MemoryCopyKey>

/** The stored detail repeats the summary and metadata the dialog already shows. */
function detailBody(entry: MemoryEntry): string {
  const lines = entry.detail.split('\n')
  const first = lines.findIndex(line => line.trim() !== '')
  if (first === -1) return ''
  let cursor = first
  if (lines[first]!.replace(/^#\s+/, '').trim() !== entry.summary.trim()) return entry.detail
  cursor += 1
  while (cursor < lines.length && /^-\s+(Category|Updated|Last verified|Revision):/i.test(lines[cursor]!.trim())) cursor += 1
  return lines.slice(cursor).join('\n').trim()
}

export function MemoryPage({ sessionId, store, t }: MemoryPageProps) {
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const [tab, setTab] = useState<MemoryTab>('global')
  const [workspaceSelection, setWorkspaceSelection] = useState<{ id: WorkspaceId; manual: boolean } | null>(null)
  const [detail, setDetail] = useState<DetailState | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [promoting, setPromoting] = useState(false)
  const [consolidating, setConsolidating] = useState(false)
  const [consolidationConfirming, setConsolidationConfirming] = useState(false)
  const [consolidationFeedback, setConsolidationFeedback] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const [notice, setNotice] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null)
  const detailRequest = useRef(0)
  const consolidationRequest = useRef(0)
  const detailTrigger = useRef<HTMLElement | null>(null)
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
      consolidationRequest.current += 1
    }
  }, [])
  useEffect(() => { void store.loadIndex(GLOBAL_SCOPE) }, [store])
  useEffect(() => {
    setNotice(null)
    setDetail(null)
    setConsolidating(false)
    setConsolidationConfirming(false)
    setConsolidationFeedback(null)
    detailRequest.current += 1
    consolidationRequest.current += 1
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
    consolidationRequest.current += 1
    setDetail(null)
    setConfirming(false)
    setConsolidating(false)
    setConsolidationConfirming(false)
    setConsolidationFeedback(null)
    setNotice(null)
    setTab(next)
  }

  const openDetails = async (entry: MemoryIndexEntry, trigger: HTMLElement): Promise<void> => {
    const request = ++detailRequest.current
    detailTrigger.current = trigger
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
    if (deleting || promoting) return
    detailRequest.current += 1
    setDetail(null)
    setConfirming(false)
    detailTrigger.current?.focus()
  }

  useEffect(() => {
    if (detail === null) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDetails()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [detail, deleting, promoting])

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
      setNotice({ kind: 'status', text: t('deleteSuccess') })
    } catch (reason) {
      if (mounted.current) setNotice({ kind: 'alert', text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      if (mounted.current) setDeleting(false)
    }
  }

  const promote = async (): Promise<void> => {
    if (detail === null || detail.scope.kind !== 'workspace' || promoting) return
    const target = detail
    setPromoting(true)
    setNotice(null)
    try {
      const result = await store.promote(target.scope, target.id)
      if (mounted.current) setNotice({ kind: 'status', text: t(result.created ? 'promoteSuccess' : 'promoteAlready') })
    } catch (reason) {
      if (mounted.current) setNotice({ kind: 'alert', text: reason instanceof Error ? reason.message : String(reason) })
    } finally {
      if (mounted.current) setPromoting(false)
    }
  }

  const consolidate = async (): Promise<void> => {
    if (scope === undefined || consolidating) return
    const target = scope
    const request = ++consolidationRequest.current
    setConsolidating(true)
    setConsolidationConfirming(false)
    setConsolidationFeedback(null)
    try {
      const result = await store.consolidate(target)
      if (mounted.current && consolidationRequest.current === request) {
        setConsolidationFeedback({
          kind: 'status',
          text: t('consolidationCompleted').replace('{count}', String(result.written)),
        })
      }
    } catch (reason) {
      if (mounted.current && consolidationRequest.current === request) {
        setConsolidationFeedback({ kind: 'alert', text: reason instanceof Error ? reason.message : String(reason) })
      }
    } finally {
      if (mounted.current && consolidationRequest.current === request) setConsolidating(false)
    }
  }

  const revisions = state === undefined ? [] : [state.layers.global.committedRevision, state.layers.workspace.committedRevision]
    .filter((revision): revision is number => revision !== null)
  const latestRevision = revisions.length === 0 ? null : Math.max(...revisions)
  const tokens = (state?.layers.global.committedTokens ?? 0) + (state?.layers.workspace.committedTokens ?? 0)
  const entries = [...(index?.entries ?? [])].sort((a, b) =>
    b.rank - a.rank || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
  const emptyScope = tab === 'global' ? t('emptyGlobal') : t('emptyWorkspace')
  const showToolbar = scope !== undefined && (tab === 'workspaces' || index === undefined || entries.length > 0)
  const detailText = detail?.entry === undefined ? '' : detailBody(detail.entry)

  const toolbar = scope === undefined ? null : (
    <div className="snail-memory-toolbar">
      {tab === 'workspaces' && (
        <div className="snail-memory-scope">
          <label htmlFor="snail-memory-workspace-select">{t('workspaceSelect')}</label>
          <select
            id="snail-memory-workspace-select"
            value={selectedWorkspaceId ?? ''}
            disabled={workspaces === undefined || workspaces.length === 0}
            onChange={event => {
              detailRequest.current += 1
              consolidationRequest.current += 1
              setDetail(null)
              setConfirming(false)
              setConsolidating(false)
              setConsolidationConfirming(false)
              setConsolidationFeedback(null)
              setNotice(null)
              setWorkspaceSelection({ id: event.target.value as WorkspaceId, manual: true })
            }}
          >
            {selectedWorkspaceId === undefined && <option value="" />}
            {workspaces?.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.title}</option>)}
          </select>
        </div>
      )}
      <div className="snail-memory-toolbar-end">
        <button
          type="button"
          className="snail-memory-button"
          disabled={consolidating}
          onClick={() => {
            setConsolidationFeedback(null)
            setConsolidationConfirming(true)
          }}
        >
          {consolidating ? t('consolidating') : t(tab === 'global' ? 'consolidateGlobal' : 'consolidateWorkspace')}
        </button>
      </div>
    </div>
  )

  return (
    <section className="snail-memory-page" aria-label={t('title')}>
      <header className="snail-memory-head">
        <h1>{t('title')}</h1>
        <dl className="snail-memory-figures">
          <div className="snail-memory-figure">
            <dt>{t('memoryCountLabel')}</dt>
            <dd data-snail="memory-count">{formatCount(entries.length)}</dd>
          </div>
          <div className="snail-memory-figure">
            <dt>{t('estimatedTokens')}</dt>
            <dd data-snail="session-tokens">{formatCount(tokens)}</dd>
          </div>
          <div className="snail-memory-figure">
            <dt>{t('injectedSnapshot')}</dt>
            <dd data-snail="session-revision">{latestRevision === null ? '—' : formatCount(latestRevision)}</dd>
          </div>
        </dl>
        {latestRevision === null && <p className="snail-memory-hint">{t('noSnapshot')}</p>}
      </header>
      <div className="snail-memory-tabs" role="tablist" aria-label={t('title')}>
        <button type="button" role="tab" id="snail-memory-global-tab" aria-selected={tab === 'global'} aria-controls="snail-memory-panel" onClick={() => selectTab('global')}>{t('globalTab')}</button>
        <button type="button" role="tab" id="snail-memory-workspaces-tab" aria-selected={tab === 'workspaces'} aria-controls="snail-memory-panel" onClick={() => selectTab('workspaces')}>{t('workspaceTab')}</button>
        <button type="button" role="tab" id="snail-memory-settings-tab" aria-selected={tab === 'settings'} aria-controls="snail-memory-panel" onClick={() => selectTab('settings')}>{t('settingsTab')}</button>
      </div>
      {notice !== null && <p className="snail-memory-notice" role={notice.kind}>{notice.text}</p>}
      {sessionError !== undefined && <p className="snail-memory-notice" role="alert">{sessionError}</p>}
      <div
        role="tabpanel"
        id="snail-memory-panel"
        aria-labelledby={tab === 'global' ? 'snail-memory-global-tab' : tab === 'workspaces' ? 'snail-memory-workspaces-tab' : 'snail-memory-settings-tab'}
      >
        {tab === 'settings' ? <SettingsPanel store={store} t={t} /> : <>
          {showToolbar && toolbar}
          {tab === 'workspaces' && workspacesError !== undefined && (
            <p className="snail-memory-feedback-line" role="alert">
              {workspacesError} <button type="button" className="snail-memory-button" onClick={() => { void store.loadWorkspaces() }}>{t('retry')}</button>
            </p>
          )}
          {tab === 'workspaces' && workspaces === undefined && workspacesError === undefined && (
            <p className="snail-memory-feedback-line" role="status">{t('loading')}</p>
          )}
          {tab === 'workspaces' && workspaces?.length === 0 && (
            <div className="snail-memory-empty snail-memory-empty--plain">
              <p className="snail-memory-empty-title">{t('noWorkspaces')}</p>
            </div>
          )}
          {consolidationConfirming && scope !== undefined && (
            <div className="snail-memory-confirm">
              <p role="alert">{t(tab === 'global' ? 'consolidateGlobalConfirmation' : 'consolidateWorkspaceConfirmation')}</p>
              <div className="snail-memory-confirm-actions">
                <button type="button" className="snail-memory-button" data-variant="primary" onClick={() => { void consolidate() }}>{t('confirmConsolidation')}</button>
                <button type="button" className="snail-memory-button" onClick={() => setConsolidationConfirming(false)}>{t('cancel')}</button>
              </div>
            </div>
          )}
          {consolidationFeedback !== null && <p className="snail-memory-feedback-line" role={consolidationFeedback.kind}>{consolidationFeedback.text}</p>}
          {scope !== undefined && (tab !== 'workspaces' || (workspaces !== undefined && workspaces.length > 0)) && <>
            {indexError !== undefined && (
              <p className="snail-memory-feedback-line" role="alert">
                {indexError} <button type="button" className="snail-memory-button" onClick={() => { void store.loadIndex(scope) }}>{t('retry')}</button>
              </p>
            )}
            {index === undefined && indexError === undefined && (
              <div className="snail-memory-list" role="status" aria-label={t('loading')}>
                {[0, 1, 2].map(row => (
                  <div className="snail-memory-entry" key={row}>
                    <div className="snail-memory-skeleton">
                      <span className="snail-memory-bar" />
                      <span className="snail-memory-bar snail-memory-bar--short" />
                    </div>
                  </div>
                ))}
              </div>
            )}
            {index !== undefined && entries.length === 0 && (
              <div className={tab === 'global' ? 'snail-memory-empty' : 'snail-memory-empty snail-memory-empty--plain'}>
                <div className="snail-memory-empty-main">
                  <p className="snail-memory-empty-title">{emptyScope}</p>
                  {tab === 'global' && <p>{t('emptyGlobalWhy')}</p>}
                  {tab === 'global' && <button type="button" className="snail-memory-button" onClick={() => selectTab('workspaces')}>{t('browseWorkspaces')}</button>}
                </div>
                {tab === 'global' && (
                  <dl className="snail-memory-kinds">
                    {CATEGORY_ORDER.map(category => (
                      <div className="snail-memory-kind" key={category}>
                        <dt>{t(CATEGORY_COPY[category])}</dt>
                        <dd>{t(CATEGORY_HELP[category])}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )}
            <ul className="snail-memory-list">
              {entries.map(entry => (
                <li className="snail-memory-entry" key={`${entry.scope.kind}:${entry.scope.kind === 'workspace' ? entry.scope.workspaceId : ''}:${entry.id}`}>
                  <div className="snail-memory-entry-main">
                    <h2>{entry.summary}</h2>
                    <p className="snail-memory-entry-meta">
                      <span className="snail-memory-tag">{t(CATEGORY_COPY[entry.category])}</span>
                      <span className="snail-memory-meta">{t('rank')}: {entry.rank} · {t('updatedAt')}: {formatBeijingMinute(entry.updatedAt)} · {t('revision')} {entry.revision}</span>
                    </p>
                  </div>
                  <button type="button" className="snail-memory-entry-action" aria-label={`${t('viewDetails')} ${entry.summary}`} onClick={event => { void openDetails(entry, event.currentTarget) }}>{t('details')}</button>
                </li>
              ))}
            </ul>
          </>}
        </>}
      </div>
      {detail !== null && (
        <div className="snail-memory-detail-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) closeDetails() }}>
          <div className="snail-memory-detail" role="dialog" aria-modal="true" aria-labelledby="snail-memory-detail-title">
            <div className="snail-memory-detail-head">
              <h2 id="snail-memory-detail-title">{detail.summary}</h2>
              {detail.entry !== undefined && (
                <dl className="snail-memory-detail-facts">
                  <div>
                    <dt>{t('category')}</dt>
                    <dd>{t(CATEGORY_COPY[detail.entry.category])}</dd>
                  </div>
                  <div>
                    <dt>{t('rank')}</dt>
                    <dd data-snail="detail-rank">{detail.entry.rank}</dd>
                  </div>
                  <div>
                    <dt>{t('updatedAt')}</dt>
                    <dd data-snail="detail-updated">{formatBeijingTime(detail.entry.updatedAt)}</dd>
                  </div>
                </dl>
              )}
            </div>
            {detail.entry === undefined && detail.error === undefined && <p className="snail-memory-detail-body" role="status">{t('loading')}</p>}
            {detail.error !== undefined && <p className="snail-memory-detail-note" role="alert">{detail.error}</p>}
            {detail.entry !== undefined && (
              <div className="snail-memory-detail-body">{detailText === '' ? t('noDetail') : detailText}</div>
            )}
            {confirming && <p className="snail-memory-detail-note" role="alert">{t('deleteConfirmation')}</p>}
            <div className="snail-memory-detail-foot">
              {confirming ? <>
                <button type="button" className="snail-memory-button" data-variant="danger-fill" autoFocus disabled={deleting} onClick={() => { void remove() }}>{deleting ? t('deleting') : t('confirmDelete')}</button>
                <button type="button" className="snail-memory-button" disabled={deleting} onClick={() => setConfirming(false)}>{t('cancel')}</button>
              </> : <>
                {detail.scope.kind === 'workspace' && <button type="button" className="snail-memory-button" disabled={detail.entry === undefined || promoting || deleting} onClick={() => { void promote() }}>{promoting ? t('promoting') : t('promote')}</button>}
                <button type="button" className="snail-memory-button" data-variant="danger" disabled={detail.entry === undefined || promoting || deleting} onClick={() => setConfirming(true)}>{t('delete')}</button>
                <span className="snail-memory-spacer" />
                <button type="button" className="snail-memory-button" autoFocus disabled={promoting || deleting} onClick={closeDetails}>{t('close')}</button>
              </>}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

const SETTINGS_FIELDS = [
  { key: 'reviewEveryUserTurns', id: 'snail-memory-review-turns', label: 'reviewEveryUserTurns', help: 'reviewEveryUserTurnsHelp', whole: true },
  { key: 'idleDelayMinutes', id: 'snail-memory-idle-delay', label: 'idleDelayMinutes', help: 'idleDelayMinutesHelp', whole: false },
  { key: 'consolidationCooldownHours', id: 'snail-memory-consolidation-delay', label: 'consolidationCooldownHours', help: 'consolidationCooldownHoursHelp', whole: false },
  { key: 'globalConsolidationCooldownDays', id: 'snail-memory-global-consolidation-delay', label: 'globalConsolidationCooldownDays', help: 'globalConsolidationCooldownDaysHelp', whole: false },
  { key: 'snapshotTokenBudget', id: 'snail-memory-snapshot-token-budget', label: 'snapshotTokenBudget', help: 'snapshotTokenBudgetHelp', whole: true },
] as const satisfies readonly { key: string; id: string; label: MemoryCopyKey; help: MemoryCopyKey; whole: boolean }[]

const SETTINGS_SECTIONS = [
  { id: 'trigger', title: 'sectionTrigger', help: 'sectionTriggerHelp', fields: SETTINGS_FIELDS.slice(0, 2) },
  { id: 'consolidation', title: 'sectionConsolidation', help: 'sectionConsolidationHelp', fields: SETTINGS_FIELDS.slice(2, 4) },
  { id: 'snapshot', title: 'sectionSnapshot', help: 'sectionSnapshotHelp', fields: SETTINGS_FIELDS.slice(4) },
] as const satisfies readonly { id: string; title: MemoryCopyKey; help: MemoryCopyKey; fields: readonly { key: string }[] }[]

function SettingsPanel({ store, t }: { readonly store: MemoryClientStore; readonly t: MemoryTranslator }) {
  const settings = store.getSettings()
  const error = store.getSettingsError()
  const [draft, setDraft] = useState({
    reviewEveryUserTurns: '15',
    idleDelayMinutes: '60',
    consolidationCooldownHours: '20',
    globalConsolidationCooldownDays: '7',
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
        globalConsolidationCooldownDays: String(settings.globalConsolidationCooldownDays),
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
        globalConsolidationCooldownDays: Number(draft.globalConsolidationCooldownDays),
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
      {error !== undefined && <p className="snail-memory-feedback-line" role="alert">{error} <button type="button" className="snail-memory-button" onClick={() => { void store.loadSettings() }}>{t('retry')}</button></p>}
      {error === undefined && <p className="snail-memory-feedback-line" role="status">{t('loading')}</p>}
    </>
  }

  const update = (key: (typeof SETTINGS_FIELDS)[number]['key'], value: string): void => {
    setDraft(current => ({ ...current, [key]: value }))
  }

  return (
    <form className="snail-memory-settings" onSubmit={event => { event.preventDefault(); void save() }}>
      {SETTINGS_SECTIONS.map(section => (
        <div className="snail-memory-section" key={section.id}>
          <div className="snail-memory-section-head">
            <h2>{t(section.title)}</h2>
            <p>{t(section.help)}</p>
          </div>
          <div className="snail-memory-fields">
            {section.fields.map(field => (
              <div className="snail-memory-field" key={field.id}>
                <label htmlFor={field.id}>{t(field.label)}</label>
                <input
                  id={field.id}
                  type="number"
                  min={field.whole ? 1 : 0}
                  step={field.whole ? 1 : 'any'}
                  required
                  disabled={saving}
                  value={draft[field.key]}
                  onChange={event => update(field.key, event.target.value)}
                />
                <p>{t(field.help)}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="snail-memory-section">
        <div className="snail-memory-section-head">
          <h2>{t('retentionSettings')}</h2>
          <p>{t('retentionDaysHelp')}</p>
        </div>
        <div className="snail-memory-lines">
          {RETENTION_CATEGORIES.map(category => (
            <div className="snail-memory-line" key={category}>
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
        </div>
      </div>
      <div className="snail-memory-settings-foot">
        {feedback !== null && <p role={feedback.kind}>{feedback.text}</p>}
        {feedback === null && error !== undefined && <p role="alert">{error}</p>}
        <button type="submit" className="snail-memory-button" data-variant="primary" disabled={saving}>{saving ? t('savingSettings') : t('saveSettings')}</button>
      </div>
    </form>
  )
}
