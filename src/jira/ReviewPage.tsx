import { useMemo, useState } from 'react'
import type { ChangeEvent } from 'react'
import { TicketWorkflow } from './TicketWorkflow.tsx'
import type {
  ReviewAction,
  ReviewApprovalFile,
  ReviewChoice,
  ReviewedAction,
  SyncReviewReport,
} from './review.ts'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseReviewReport(json: string): SyncReviewReport {
  const value: unknown = JSON.parse(json)

  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new Error('Unsupported review report. Generate a fresh report with npm run jira:sync -- --report.')
  }

  for (const file of value.files) {
    if (
      !isRecord(file) ||
      typeof file.reviewId !== 'string' ||
      typeof file.file !== 'string' ||
      typeof file.ibName !== 'string' ||
      typeof file.version !== 'string' ||
      typeof file.ecuId !== 'string' ||
      !Array.isArray(file.actions) ||
      !Array.isArray(file.blockers) ||
      !Array.isArray(file.notes)
    ) {
      throw new Error('The review report is missing required file information.')
    }

    for (const action of file.actions) {
      if (
        !isRecord(action) ||
        typeof action.id !== 'string' ||
        typeof action.type !== 'string' ||
        typeof action.summary !== 'string'
      ) {
        throw new Error('The review report contains an invalid action.')
      }
    }
  }

  return value as unknown as SyncReviewReport
}

function downloadApprovalFile(approval: ReviewApprovalFile) {
  const blob = new Blob([JSON.stringify(approval, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = 'ib1-jira-approvals.json'
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function actionLabel(action: ReviewAction) {
  switch (action.type) {
    case 'create':
    case 'create-ecu':
      return '+ Added'
    case 'update':
    case 'update-ecu':
      return '~ Changed'
    case 'remove':
      return '- Removed'
    case 'refresh':
      return 'Version refresh'
    case 'adopt':
      return 'Link existing'
    default:
      return 'Unchanged'
  }
}

type ChangeFilter = 'all' | 'added' | 'changed' | 'removed'

function changeCategory(action: ReviewAction): Exclude<ChangeFilter, 'all'> {
  if (action.type === 'create' || action.type === 'create-ecu') return 'added'
  if (action.type === 'remove') return 'removed'
  return 'changed'
}

function choicesFor(action: ReviewAction): Array<{ value: ReviewChoice; label: string }> {
  if (action.held && action.type !== 'remove') {
    return [{ value: 'keep', label: 'Keep current ticket' }]
  }

  if (action.type === 'remove') {
    return [
      { value: 'accept', label: 'Mark as Not Relevant' },
      { value: 'keep', label: 'Keep current ticket' },
    ]
  }

  if (action.type === 'update' || action.type === 'update-ecu' || action.type === 'create' || action.type === 'create-ecu') {
    return [
      { value: 'accept', label: 'Accept incoming change' },
      { value: 'keep', label: 'Keep current ticket' },
      { value: 'merge', label: 'Merge and edit' },
    ]
  }

  return [
    { value: 'accept', label: 'Accept this change' },
    { value: 'keep', label: 'Keep current ticket' },
  ]
}

function reviewed(decision: ReviewedAction | undefined) {
  return Boolean(decision?.checked && decision.choice && (decision.choice !== 'merge' || (decision.summary?.trim() && decision.description?.trim())))
}

function dependencyErrors(file: SyncReviewReport['files'][number], decisions: Record<string, ReviewedAction> | undefined) {
  return file.actions.flatMap((action) => {
    if (!action.parentIbKey || decisions?.[action.id]?.choice === 'keep') return []

    const parent = file.actions.find((candidate) => candidate.ibKey === action.parentIbKey)
    if (!parent || parent.type !== 'create') return []

    const parentDecision = decisions?.[parent.id]
    return reviewed(parentDecision) && parentDecision?.choice !== 'keep'
      ? []
      : [`${action.summary} needs its new block "${parent.summary}" accepted first.`]
  })
}

export function ReviewPage({ hidden }: { hidden?: boolean }) {
  const [report, setReport] = useState<SyncReviewReport | null>(null)
  const [fileIndex, setFileIndex] = useState(0)
  const [actionId, setActionId] = useState('')
  const [decisions, setDecisions] = useState<Record<string, Record<string, ReviewedAction>>>({})
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [changeFilter, setChangeFilter] = useState<ChangeFilter>('all')

  const currentFile = report?.files[fileIndex] ?? null
  const changeActions = useMemo(
    () => currentFile?.actions.filter((action) => action.type !== 'unchanged') ?? [],
    [currentFile],
  )
  const visibleActions = changeActions.filter((action) => changeFilter === 'all' || changeCategory(action) === changeFilter)
  const selectedAction =
    visibleActions.find((action) => action.id === actionId) ?? visibleActions[0] ?? null
  const totalActions = report?.files.reduce((sum, file) => sum + file.actions.filter((action) => action.type !== 'unchanged').length, 0) ?? 0
  const checkedActions = report?.files.reduce(
    (sum, file) =>
      sum + file.actions.filter((action) => action.type !== 'unchanged' && reviewed(decisions[file.reviewId]?.[action.id])).length,
    0,
  ) ?? 0
  const hasBlockers = Boolean(report?.files.some((file) => file.blockers.length))
  const dependencies = report?.files.flatMap((file) => dependencyErrors(file, decisions[file.reviewId])) ?? []
  const currentDependencies = currentFile ? dependencyErrors(currentFile, decisions[currentFile.reviewId]) : []
  const canExport = Boolean(report && checkedActions === totalActions && !hasBlockers && !dependencies.length)
  const currentDecision = currentFile && selectedAction ? decisions[currentFile.reviewId]?.[selectedAction.id] : undefined

  async function loadFile(file: File | undefined) {
    if (!file) return

    try {
      const loaded = parseReviewReport(await file.text())
      setReport(loaded)
      setFileName(file.name)
      setFileIndex(0)
      setActionId('')
      setDecisions({})
      setChangeFilter('all')
      setError('')
    } catch (reason) {
      setReport(null)
      setError(reason instanceof Error ? reason.message : 'Unable to read review report.')
    }
  }

  function updateDecision(action: ReviewAction, update: Partial<ReviewedAction>) {
    if (!currentFile) return

    setDecisions((current) => {
      const fileDecisions = current[currentFile.reviewId] ?? {}
      const previous = fileDecisions[action.id] ?? { choice: 'keep' as const, checked: false }

      return {
        ...current,
        [currentFile.reviewId]: {
          ...fileDecisions,
          [action.id]: { ...previous, ...update },
        },
      }
    })
  }

  function exportApprovals() {
    if (!report || !canExport) return

    downloadApprovalFile({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      files: report.files.map((file) => ({
        reviewId: file.reviewId,
        actions: decisions[file.reviewId] ?? {},
      })),
    })
  }

  return (
    <section className="review-page" hidden={hidden} aria-label="Review Jira changes">
      <TicketWorkflow stage="review" />
      <header className="review-intro">
        <div>
          <p className="eyebrow">Your decision, every change</p>
          <h2>Review before anything changes</h2>
          <p>Load a Jira dry-run report. For every proposed change, accept it, keep the current ticket, or edit a merge. Confirm each decision before downloading approvals.</p>
        </div>
        <label className="review-upload">
          <span>{fileName || 'Load review report'}</span>
          <input
            type="file"
            accept=".json,application/json"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              void loadFile(event.target.files?.[0])
              event.target.value = ''
            }}
          />
        </label>
      </header>

      {error ? <p className="review-error" role="alert">{error}</p> : null}
      {!report ? (
        <section className="empty-state" aria-label="Waiting for a review report">
          <div>
            <span className="empty-state__mark">REVIEW</span>
            <h2>Start with a Jira review report</h2>
            <p>The XML preview alone is not a Jira comparison. Generate a report, then load it here.</p>
            <details className="review-instructions">
              <summary>How to generate a report</summary>
              <code>npm run jira:sync -- path/to/IB1.xml --parent PRDFSI-150 --report review.json</code>
            </details>
          </div>
        </section>
      ) : (
        <>
          <section className="review-summary">
            <label>
              <span>IB1 file</span>
              <select value={fileIndex} onChange={(event) => { setFileIndex(Number(event.target.value)); setActionId(''); setChangeFilter('all') }}>
                {report.files.map((file, index) => (
                  <option key={file.reviewId} value={index}>{file.ibName} v{file.version} · ECU {file.ecuId}</option>
                ))}
              </select>
            </label>
            <div><span>Checked off</span><strong>{checkedActions} / {totalActions}</strong></div>
            <progress aria-label="Review completion" value={checkedActions} max={Math.max(totalActions, 1)} />
            <div><span>ECU in Jira</span><strong>{currentFile?.ecuKey ?? 'No match'}</strong></div>
            <details className="review-summary__id"><summary>Snapshot details</summary><code>{currentFile?.reviewId}</code></details>
            <button type="button" className="export-button" disabled={!canExport} onClick={exportApprovals}>Export approvals</button>
          </section>

          {hasBlockers ? (
            <div className="review-blockers" role="alert">
              <strong>Blocked review — no approval file can be exported</strong>
              {report.files.filter((file) => file.blockers.length).map((file) => (
                <div key={file.reviewId}>
                  <span>{file.ibName}:</span>
                  <ul>{file.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
                </div>
              ))}
            </div>
          ) : null}

          {currentFile?.notes.length ? (
            <ul className="review-notes">{currentFile.notes.map((note) => <li key={note}>{note}</li>)}</ul>
          ) : null}
          {currentDependencies.length ? (
            <ul className="review-blockers" role="alert">
              {currentDependencies.map((message) => <li key={message}>{message}</li>)}
            </ul>
          ) : null}

          <div className="change-filters" role="group" aria-label="Filter proposed changes">
            {([
              ['all', 'All changes'],
              ['added', 'Added'],
              ['changed', 'Changed'],
              ['removed', 'Removed'],
            ] as const).map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={`change-filter change-filter--${value}`}
                aria-pressed={changeFilter === value}
                onClick={() => { setChangeFilter(value); setActionId('') }}
              >
                {label} <strong>{value === 'all' ? changeActions.length : changeActions.filter((action) => changeCategory(action) === value).length}</strong>
              </button>
            ))}
          </div>

          <div className="review-workspace">
            <aside className="review-list" aria-label="Proposed changes">
              <h3>Proposed changes · {visibleActions.length}</h3>
              {visibleActions.map((action) => {
                const decision = decisions[currentFile!.reviewId]?.[action.id]
                return (
                  <button
                    type="button"
                    key={action.id}
                    className={`review-list__item ${selectedAction?.id === action.id ? 'is-selected' : ''}`}
                    onClick={() => setActionId(action.id)}
                  >
                    <span className={`review-kind review-kind--${action.type}`}>{actionLabel(action)}</span>
                    <strong>{action.summary}</strong>
                    <span>{action.issueKey ?? action.ibKey ?? action.type}</span>
                    <span>{reviewed(decision) ? `Checked · ${decision?.choice}` : 'Needs review'}</span>
                  </button>
                )
              })}
              {!visibleActions.length ? <p>No {changeFilter === 'all' ? '' : `${changeFilter} `}changes to review.</p> : null}
            </aside>

            {selectedAction ? (
              <article className="review-detail">
                <header>
                  <div>
                    <span className={`review-kind review-kind--${selectedAction.type}`}>{actionLabel(selectedAction)}</span>
                    <h3>{selectedAction.summary}</h3>
                    <p>{selectedAction.reason || selectedAction.held || selectedAction.type}</p>
                  </div>
                  {selectedAction.issueKey ? (
                    <a href={`https://scoutmotors.atlassian.net/browse/${selectedAction.issueKey}`} target="_blank" rel="noreferrer">
                      Open {selectedAction.issueKey} ↗
                    </a>
                  ) : null}
                </header>

                {selectedAction.held ? <p className="review-held">Held by sync safety: {selectedAction.held}</p> : null}

                <div className="review-content-pair">
                  <section>
                    <h4>Current Jira</h4>
                    {selectedAction.current ? (
                      <>
                        <strong>{selectedAction.current.summary}</strong>
                        {selectedAction.current.status ? <span className="review-status">{selectedAction.current.status}</span> : null}
                        <pre>{selectedAction.current.description || '(No description)'}</pre>
                      </>
                    ) : <p>No existing ticket.</p>}
                  </section>
                  <section>
                    <h4>Proposed from IB1</h4>
                    {selectedAction.proposed ? (
                      <>
                        <strong>{selectedAction.proposed.summary}</strong>
                        {selectedAction.proposed.issueType ? (
                          <span className="review-status">
                            {selectedAction.proposed.issueType} · parent: {selectedAction.proposed.parent}
                          </span>
                        ) : null}
                        <pre>{selectedAction.proposed.description || '(No description)'}</pre>
                      </>
                    ) : <p>The block or step is no longer in the incoming IB1.</p>}
                  </section>
                </div>

                <fieldset className="review-choices">
                  <legend>Decision</legend>
                  {choicesFor(selectedAction).map((choice) => (
                    <label key={choice.value}>
                      <input
                        type="radio"
                        name={`decision-${selectedAction.id}`}
                        value={choice.value}
                        checked={currentDecision?.choice === choice.value}
                        onChange={() =>
                          updateDecision(selectedAction, {
                            choice: choice.value,
                            checked: false,
                            ...(choice.value === 'merge'
                              ? {
                                  summary: selectedAction.proposed?.summary ?? '',
                                  description: selectedAction.proposed?.description ?? '',
                                }
                              : {}),
                          })
                        }
                      />
                      {choice.label}
                    </label>
                  ))}
                </fieldset>

                {currentDecision?.choice === 'merge' ? (
                  <div className="review-merge">
                    <label>
                      Merged summary
                      <input
                        value={currentDecision.summary ?? selectedAction.proposed?.summary ?? ''}
                        onChange={(event) => updateDecision(selectedAction, { summary: event.target.value, checked: false })}
                      />
                    </label>
                    <label>
                      Merged Jira description (wiki markup)
                      <textarea
                        rows={14}
                        value={currentDecision.description ?? selectedAction.proposed?.description ?? ''}
                        onChange={(event) => updateDecision(selectedAction, { description: event.target.value, checked: false })}
                      />
                    </label>
                  </div>
                ) : null}

                <label className="review-checkoff">
                  <input
                    type="checkbox"
                    checked={Boolean(currentDecision?.checked && (currentDecision.choice !== 'merge' || (currentDecision.summary?.trim() && currentDecision.description?.trim())))}
                    disabled={!currentDecision?.choice}
                    onChange={(event) => updateDecision(selectedAction, { checked: event.target.checked })}
                  />
                  I reviewed this change and confirm my decision
                </label>
              </article>
            ) : null}
          </div>

          <p className="review-safety-note">The report is tied to the Jira snapshot used to create it. The CLI rechecks that snapshot before writing and refuses stale approvals. This report does not yet compare Git branches.</p>
        </>
      )}
    </section>
  )
}
