import { useDeferredValue, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import {
  buildJiraTicketPlan,
  DEFAULT_JIRA_PLAN_OPTIONS,
  type DescriptionSection,
  type JiraPlanOptions,
  type JiraTicketPlan,
  type PlannedTicket,
  type XmlNode,
} from './ib1JiraPlan.ts'
import { ticketWikiDescription, toJiraCsv, toJiraWikiMarkup, toPlanJson } from './exporters.ts'
import { TicketWorkflow } from './TicketWorkflow.tsx'
import { OfflineSnapshot } from './OfflineComparison.tsx'

type LoadedXml = {
  fileName: string
  document: XmlNode
}

type DescriptionView = 'preview' | 'wiki'

const KIND_LABELS: Record<PlannedTicket['kind'], string> = {
  step: 'Step',
  'hmi-step': 'HMI step',
  block: 'Block',
}

async function readIb1Xml(file: File): Promise<LoadedXml> {
  const text = await file.text()

  if (/^\s*(<!doctype html|<html)/i.test(text) || /\.html?$/i.test(file.name)) {
    throw new Error('HTML exports have no stable IB1 ids. Load the IB1 .xml file to plan Jira tickets.')
  }

  const xmlDocument = new DOMParser().parseFromString(text, 'application/xml')

  if (xmlDocument.getElementsByTagName('parsererror').length) {
    throw new Error('The file could not be parsed as XML.')
  }

  if (xmlDocument.documentElement.nodeName !== 'IB-1') {
    throw new Error('This XML has no IB-1 root element.')
  }

  return { fileName: file.name, document: xmlDocument as unknown as XmlNode }
}

function downloadText(fileName: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  link.click()
  URL.revokeObjectURL(url)
}

function exportBaseName(plan: JiraTicketPlan) {
  return `${plan.source.ibName}_v${plan.source.version || 'x'}_jira-${plan.options.granularity}`.replace(
    /[^\w.-]+/g,
    '_',
  )
}

export function JiraPreview({ hidden }: { hidden?: boolean }) {
  const setupRef = useRef<HTMLElement>(null)
  const previewRef = useRef<HTMLElement>(null)
  const [loaded, setLoaded] = useState<LoadedXml | null>(null)
  const [loadError, setLoadError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [options, setOptions] = useState<JiraPlanOptions>(DEFAULT_JIRA_PLAN_OPTIONS)
  const [labelText, setLabelText] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const [descriptionView, setDescriptionView] = useState<DescriptionView>('preview')
  const deferredSearch = useDeferredValue(searchQuery)

  const planResult = useMemo(() => {
    if (!loaded) {
      return null
    }

    try {
      return { plan: buildJiraTicketPlan(loaded.document, loaded.fileName, options), error: '' }
    } catch (error) {
      return { plan: null, error: error instanceof Error ? error.message : 'Unable to build ticket plan' }
    }
  }, [loaded, options])
  const plan = planResult?.plan ?? null
  const normalizedSearch = deferredSearch.trim().toLowerCase()
  const visibleTickets = plan
    ? plan.tickets.filter(
        (ticket) =>
          !normalizedSearch ||
          [ticket.summary, ticket.path.join(' '), ticket.fields.Action ?? '', ticket.labels.join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(normalizedSearch),
      )
    : []
  const selectedTicket = visibleTickets.find((ticket) => ticket.ibKey === selectedKey) ?? visibleTickets[0]

  async function handleFile(fileList: FileList | null) {
    const file = fileList?.[0]

    if (!file) {
      return
    }

    try {
      setLoaded(await readIb1Xml(file))
      setLoadError('')
      setSelectedKey('')
    } catch (error) {
      setLoaded(null)
      setLoadError(error instanceof Error ? error.message : 'Unable to read IB1 document')
    }
  }

  function updateOption<Key extends keyof JiraPlanOptions>(key: Key, value: JiraPlanOptions[Key]) {
    setOptions((current) => ({ ...current, [key]: value }))
  }

  function handleLabels(value: string) {
    setLabelText(value)
    updateOption(
      'extraLabels',
      value
        .split(/[,\s]+/)
        .map((label) => label.trim())
        .filter(Boolean),
    )
  }

  return (
    <div className="jira-view" hidden={hidden}>
      <TicketWorkflow
        stage={plan ? 'preview' : 'load'}
        onLoad={() => setupRef.current?.scrollIntoView({ block: 'start' })}
        onPreview={() => previewRef.current?.scrollIntoView({ block: 'start' })}
      />
      <OfflineSnapshot plan={plan} />
      <section ref={setupRef} className="jira-setup" aria-label="IB1 file and Jira settings">
        <label
          className={`file-slot ${dragging ? 'is-dragging' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent<HTMLLabelElement>) => {
            event.preventDefault()
            setDragging(false)
            void handleFile(event.dataTransfer.files)
          }}
        >
          <span className="file-slot__label">{plan ? 'Document loaded' : 'Start here'}</span>
          <strong>{plan?.source.ibName || 'Choose an IB1 document'}</strong>
          <span>
            {plan
              ? `${plan.source.fileName} | v${plan.source.version} | released ${plan.source.releaseDate}`
              : 'Drop an XML file here, or click to browse.'}
          </span>
          {loadError || planResult?.error ? (
            <span className="file-slot__error">{loadError || planResult?.error}</span>
          ) : null}
          <input
            type="file"
            accept=".xml,text/xml,application/xml"
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              void handleFile(event.target.files)
              event.target.value = ''
            }}
          />
        </label>

        <form className="jira-settings" onSubmit={(event) => event.preventDefault()}>
          <div className="jira-destination">
            <p className="eyebrow">Jira destination</p>
            <label>
              <span>Existing ECU ticket (optional)</span>
              <input
                placeholder="e.g. PRDFSI-150"
                value={options.ecuIssueKey}
                onChange={(event) => updateOption('ecuIssueKey', event.target.value.trim().toUpperCase())}
              />
            </label>
            <p>Leave blank to preview a new ECU. Nothing is sent to Jira from this page.</p>
          </div>
          <details className="advanced-settings">
            <summary>Advanced settings</summary>
            <div className="jira-options">
              <label>
                <span>Project key</span>
                <input
                  value={options.projectKey}
                  onChange={(event) => updateOption('projectKey', event.target.value.trim().toUpperCase())}
                />
              </label>
              <label>
                <span>ECU issue type</span>
                <input
                  value={options.ecuIssueType}
                  onChange={(event) => updateOption('ecuIssueType', event.target.value)}
                />
              </label>
              <label>
                <span>Block issue type</span>
                <input
                  value={options.childIssueType}
                  onChange={(event) => updateOption('childIssueType', event.target.value)}
                />
              </label>
              {options.granularity === 'nested' ? (
                <label>
                  <span>Step sub-task type</span>
                  <input
                    value={options.stepIssueType}
                    onChange={(event) => updateOption('stepIssueType', event.target.value)}
                  />
                </label>
              ) : null}
              <label>
                <span>Extra labels</span>
                <input
                  placeholder="e.g. Mule VFF"
                  value={labelText}
                  onChange={(event) => handleLabels(event.target.value)}
                />
              </label>
              <div className="jira-options__granularity">
                <span>Ticket structure</span>
                <div className="status-segment jira-segment" role="group" aria-label="Ticket granularity">
                  {(['nested', 'block', 'step'] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      aria-pressed={options.granularity === value}
                      onClick={() => updateOption('granularity', value)}
                    >
                      {value === 'nested' ? 'Block + steps' : value === 'step' ? 'Step only' : 'Block only'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </details>
        </form>
      </section>

      {plan ? (
        <>
          <section ref={previewRef} className="summary-strip jira-summary" aria-label="Ticket plan summary">
            <EcuCard plan={plan} />
            <div className="summary-metrics">
              <JiraMetric label="Blocks" value={plan.stats.blocks} />
              <JiraMetric label="Steps" value={plan.stats.steps} />
              <JiraMetric label="Tickets" value={plan.stats.tickets} tone="added" />
              <JiraMetric label="Warnings" value={plan.warnings.length} tone={plan.warnings.length ? 'changed' : undefined} />
            </div>
            <div className="spec-pair spec-pair--right jira-actions">
              <span>Preview ready</span>
              <a className="primary-link" href="#/review">Review Jira changes <span aria-hidden="true">→</span></a>
              <details className="plan-exports">
                <summary>Download ticket plan</summary>
                <div>
                  <button
                    className="export-button"
                    type="button"
                    onClick={() => downloadText(`${exportBaseName(plan)}.csv`, toJiraCsv(plan), 'text/csv')}
                  >
                    Export Jira CSV
                  </button>
                  <button
                    className="export-button"
                    type="button"
                    onClick={() =>
                      downloadText(`${exportBaseName(plan)}.json`, toPlanJson(plan), 'application/json')
                    }
                  >
                    Export JSON
                  </button>
                </div>
              </details>
            </div>
          </section>

          {plan.warnings.length ? (
            <ul className="jira-warnings" aria-label="Warnings">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          <section className="diff-workspace" aria-label="Planned tickets">
            <aside className="diff-browser">
              <div className="diff-toolbar">
                <div className="result-count">
                  <strong>{visibleTickets.length}</strong>
                  <span>planned tickets</span>
                </div>
                <input
                  type="search"
                  placeholder="Search tickets, blocks, actions"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                />
              </div>
              <TicketList
                tickets={visibleTickets}
                selectedKey={selectedTicket?.ibKey ?? ''}
                onSelect={setSelectedKey}
              />
            </aside>

            {selectedTicket ? (
              <TicketDetail
                plan={plan}
                ticket={selectedTicket}
                view={descriptionView}
                onView={setDescriptionView}
              />
            ) : (
              <article className="document-comparison empty-detail">No tickets match the search.</article>
            )}
          </section>
        </>
      ) : (
        <section className="empty-state" aria-label="Waiting for an IB1 file">
          <div>
            <span className="empty-state__mark">IB1</span>
            <h2>Load an IB1 XML to preview Jira tickets</h2>
            <p>We identify blocks and steps automatically. Review the plan before preparing Jira changes.</p>
          </div>
        </section>
      )}
    </div>
  )
}

function EcuCard({ plan }: { plan: JiraTicketPlan }) {
  const { ecu } = plan

  return (
    <div className="spec-pair jira-ecu">
      <span>
        {ecu.issueType} · ECU {ecu.ecuId}
      </span>
      <strong>{ecu.existingIssueKey ? `${ecu.existingIssueKey} (existing)` : `New: ${ecu.summary}`}</strong>
      <details className="lookup-details">
        <summary>Find this ECU in Jira</summary>
        <code>{ecu.lookupJql}</code>
      </details>
    </div>
  )
}

function JiraMetric({ label, value, tone }: { label: string; value: number; tone?: 'added' | 'changed' }) {
  return (
    <div className={`metric ${tone ? `metric--${tone}` : ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

type TicketListProps = {
  tickets: PlannedTicket[]
  selectedKey: string
  onSelect: (key: string) => void
}

function TicketList({ tickets, selectedKey, onSelect }: TicketListProps) {
  if (!tickets.length) {
    return <p className="no-results">No tickets match the search.</p>
  }

  return (
    <div className="diff-list">
      {tickets.map((ticket, index) => {
        const startsGroup = index === 0 || tickets[index - 1].blockKey !== ticket.blockKey
        const followsBlock = tickets[index - 1]?.kind === 'block'
        const showGroup = ticket.kind !== 'block' && (startsGroup || followsBlock)

        return (
          <div key={ticket.ibKey} className="jira-ticket-row">
            {showGroup ? <p className="jira-group">{ticket.blockName}</p> : null}
            <button
              type="button"
              className={`diff-entry jira-ticket jira-ticket--${ticket.kind} ${
                ticket.ibKey === selectedKey ? 'is-selected' : ''
              }`}
              onClick={() => onSelect(ticket.ibKey)}
            >
              <span className="diff-entry__meta">
                <span>{KIND_LABELS[ticket.kind]}</span>
                {ticket.labels.includes('standard-block') ? <span>Standard</span> : null}
                {ticket.fields['Runs inside'] ? <span>Loop</span> : null}
              </span>
              <strong>{ticket.summary}</strong>
              <span className="diff-entry__path">{ticket.fields.Action ?? `${ticket.fields.Steps ?? 0} steps`}</span>
            </button>
          </div>
        )
      })}
    </div>
  )
}

type TicketDetailProps = {
  plan: JiraTicketPlan
  ticket: PlannedTicket
  view: DescriptionView
  onView: (view: DescriptionView) => void
}

function TicketDetail({ plan, ticket, view, onView }: TicketDetailProps) {
  const [copied, setCopied] = useState(false)
  const wiki = ticketWikiDescription(ticket)
  const parentTicket = ticket.parentIbKey ? plan.tickets.find((candidate) => candidate.ibKey === ticket.parentIbKey) : null
  const parent = parentTicket
    ? `New ${parentTicket.issueType} "${parentTicket.summary}"`
    : plan.ecu.existingIssueKey || `New ${plan.ecu.issueType} "${plan.ecu.summary}"`

  async function copyWiki() {
    await navigator.clipboard.writeText(wiki)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1500)
  }

  return (
    <article className="document-comparison jira-detail">
      <header className="document-comparison__header">
        <div>
          <p className="eyebrow">{ticket.path.join(' › ')}</p>
          <h2>{ticket.summary}</h2>
        </div>
      </header>

      <dl className="jira-fields">
        <div>
          <dt>Issue type</dt>
          <dd>{ticket.issueType}</dd>
        </div>
        <div>
          <dt>Parent</dt>
          <dd>{parent}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>{plan.options.projectKey}</dd>
        </div>
        <div>
          <dt>Labels</dt>
          <dd>
            {ticket.labels.map((label) => (
              <span key={label} className="type-pill">
                {label}
              </span>
            ))}
          </dd>
        </div>
        <div>
          <dt>Sync key</dt>
          <dd>
            <code>{ticket.ibKey}</code>
          </dd>
        </div>
      </dl>

      <div className="jira-description__toolbar">
        <div className="status-segment jira-segment" role="group" aria-label="Description view">
          <button type="button" aria-pressed={view === 'preview'} onClick={() => onView('preview')}>
            Preview
          </button>
          <button type="button" aria-pressed={view === 'wiki'} onClick={() => onView('wiki')}>
            Jira markup
          </button>
        </div>
        <button className="export-button" type="button" onClick={() => void copyWiki()}>
          {copied ? 'Copied' : 'Copy markup'}
        </button>
      </div>

      {view === 'wiki' ? (
        <pre className="jira-wiki">{wiki}</pre>
      ) : (
        <div className="jira-description">
          {ticket.sections.map((section, index) => (
            <SectionView key={`${section.title}-${index}`} section={section} />
          ))}
        </div>
      )}

      <details className="jira-ecu-details">
        <summary>ECU ticket description</summary>
        <pre className="jira-wiki">{toJiraWikiMarkup(plan.ecu.sections)}</pre>
      </details>
    </article>
  )
}

function SectionView({ section }: { section: DescriptionSection }) {
  if (section.kind === 'heading') {
    return <h2 className="jira-step-heading">{section.title}</h2>
  }

  return (
    <section className="jira-section">
      {section.title ? <h3>{section.title}</h3> : null}
      {section.kind === 'fields' ? (
        <dl className="jira-fields jira-fields--compact">
          {section.rows.map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {section.kind === 'text' ? <p className="jira-text">{section.text}</p> : null}
      {section.kind === 'list' ? (
        <ul>
          {section.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      ) : null}
      {section.kind === 'table' ? (
        <div className="jira-table-wrap">
          <table>
            <thead>
              <tr>
                {section.headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {section.kind === 'code' ? <pre className="jira-code">{section.code}</pre> : null}
    </section>
  )
}
