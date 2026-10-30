import { useDeferredValue, useEffect, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import './App.css'
import { JiraPreview } from './jira/JiraPreview.tsx'

type AppMode = 'compare' | 'jira'

// The Jira planner is the home page; the version comparison lives at #/compare.
const COMPARE_HASH = '#/compare'
const modeFromHash = (): AppMode => (window.location.hash === COMPARE_HASH ? 'compare' : 'jira')

type SpecSide = 'baseline' | 'candidate'
type DiffStatus = 'added' | 'removed' | 'changed'
type StatusFilter = 'all' | DiffStatus
type TypeFilter = 'all' | RecordType
type SourceFormat = 'html' | 'xml'
type ComparisonMode = 'native' | 'mixed'

type RecordType =
  | 'metadata'
  | 'variant'
  | 'objective'
  | 'contact'
  | 'revision'
  | 'diagnostic'
  | 'procedure'
  | 'switch'
  | 'case'
  | 'block'
  | 'step'
  | 'parameter'
  | 'api'
  | 'security'
  | 'adjustment'
  | 'validity'
  | 'condition'
  | 'access'
  | 'mode'
  | 'document'
  | 'reference'

type ComparableRecord = {
  key: string
  type: RecordType
  title: string
  path: string[]
  fields: Record<string, string>
  anchor?: string
  order: number
}

type ParsedSpec = {
  fileName: string
  title: string
  version: string
  releaseDate: string
  recordCount: number
  sourceFormat: SourceFormat
  sourceHtml?: string
  records: ComparableRecord[]
}

type RecordDraft = Omit<ComparableRecord, 'order'> & {
  anchorElement?: Element
}

type DocumentSide = 'baseline' | 'candidate'

type DiffEntry = {
  id: string
  status: DiffStatus
  type: RecordType
  title: string
  path: string[]
  before?: ComparableRecord
  after?: ComparableRecord
  changedFields: string[]
}

type DiffResult = {
  entries: DiffEntry[]
  added: number
  removed: number
  changed: number
  unchanged: number
  total: number
  typeCounts: Partial<Record<RecordType, number>>
  comparisonMode: ComparisonMode
  omittedRecordCount: number
}

const TYPE_LABELS: Record<RecordType, string> = {
  metadata: 'Metadata',
  variant: 'Variant',
  objective: 'Objective',
  contact: 'Contact',
  revision: 'Revision',
  diagnostic: 'Diagnostic',
  procedure: 'Procedure',
  switch: 'Switch',
  case: 'Case',
  block: 'Block',
  step: 'Step',
  parameter: 'Parameter',
  api: 'REST request',
  security: 'Security',
  adjustment: 'Adjustment',
  validity: 'Validity',
  condition: 'Condition',
  access: 'Access',
  mode: 'Mode',
  document: 'Document',
  reference: 'Reference',
}

const STATUS_LABELS: Record<StatusFilter, string> = {
  all: 'All',
  added: 'Added',
  removed: 'Removed',
  changed: 'Changed',
}

const FORMAT_LABELS: Record<SourceFormat, string> = {
  html: 'HTML',
  xml: 'XML',
}

const MIXED_COMPARABLE_TYPES = new Set<RecordType>([
  'metadata',
  'contact',
  'revision',
  'variant',
  'objective',
  'diagnostic',
  'condition',
  'mode',
  'procedure',
  'case',
  'block',
  'step',
])

const MIXED_FIELD_ALIASES: Record<string, string> = {
  abteilung: 'Department',
  arbeitsgang: 'Name',
  autor: 'Author',
  beschreibung: 'Description',
  datum: 'Date',
  'diagnose-adresse': 'ECU ID',
  diagnoseinformationen: 'Diagnostic infos',
  'diagnose-protokoll': 'Diagnostic protocol',
  firma: 'Company',
  funktion: 'Name',
  information: 'Description',
  item: 'Objective',
  kd: 'KD relevant',
  mobil: 'Mobile phone',
  odx: 'ODXS',
  p: 'P relevant',
  'produkt-id': 'Product ID',
  rolle: 'Role',
  telefon: 'Phone',
  'teile-nr.': 'Part number',
  'transport-protokoll': 'Transport protocol',
  typ: 'Kind',
  veranderung: 'Change',
  veraenderung: 'Change',
  'work item': 'Name',
}

const MIXED_BOOLEAN_FIELDS = new Set([
  'KD relevant',
  'P relevant',
  'Optional',
  'Standard IBNB',
])

const WORKFLOW_ELEMENT_TAGS = new Set([
  'STEP',
  'HMI-STEP',
  'LOOP',
  'BRANCH',
  'IF',
  'ELSEIF',
  'ELSE',
])

const IGNORED_ATTRIBUTES = new Set(['id'])

function App() {
  const [mode, setMode] = useState<AppMode>(modeFromHash)

  useEffect(() => {
    const syncMode = () => {
      setMode(modeFromHash())
      window.scrollTo(0, 0)
    }

    window.addEventListener('hashchange', syncMode)

    return () => window.removeEventListener('hashchange', syncMode)
  }, [])

  useEffect(() => {
    document.title = mode === 'compare' ? 'Compare IB1 Versions · IB1 Jira Tickets' : 'IB1 Jira Tickets'
  }, [mode])
  const [baselineSpec, setBaselineSpec] = useState<ParsedSpec | null>(null)
  const [candidateSpec, setCandidateSpec] = useState<ParsedSpec | null>(null)
  const [baselineError, setBaselineError] = useState('')
  const [candidateError, setCandidateError] = useState('')
  const [dragSide, setDragSide] = useState<SpecSide | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedDiffId, setSelectedDiffId] = useState('')

  const deferredSearch = useDeferredValue(searchQuery)
  const diffResult =
    baselineSpec && candidateSpec
      ? compareSpecs(baselineSpec, candidateSpec)
      : null
  const filteredEntries = diffResult
    ? filterDiffEntries(
        diffResult.entries,
        statusFilter,
        typeFilter,
        deferredSearch,
      )
    : []
  const selectedEntry =
    filteredEntries.find((entry) => entry.id === selectedDiffId) ??
    filteredEntries[0]
  const typeOptions = diffResult
    ? Array.from(new Set(diffResult.entries.map((entry) => entry.type))).sort(
        (firstType, secondType) =>
          TYPE_LABELS[firstType].localeCompare(TYPE_LABELS[secondType]),
      )
    : []

  async function handleFile(side: SpecSide, fileList: FileList | null) {
    const file = fileList?.[0]

    if (!file) {
      return
    }

    try {
      const parsedSpec = await parseSpecFile(file)

      if (side === 'baseline') {
        setBaselineSpec(parsedSpec)
        setBaselineError('')
      } else {
        setCandidateSpec(parsedSpec)
        setCandidateError('')
      }

      setSelectedDiffId('')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to parse IB1 document'

      if (side === 'baseline') {
        setBaselineSpec(null)
        setBaselineError(message)
      } else {
        setCandidateSpec(null)
        setCandidateError(message)
      }
    }
  }

  function handleDrop(event: DragEvent<HTMLLabelElement>, side: SpecSide) {
    event.preventDefault()
    setDragSide(null)
    void handleFile(side, event.dataTransfer.files)
  }

  function exportReport() {
    if (!diffResult || !baselineSpec || !candidateSpec) {
      return
    }

    const report = {
      generatedAt: new Date().toISOString(),
      baseline: describeSpec(baselineSpec),
      candidate: describeSpec(candidateSpec),
      comparisonMode: diffResult.comparisonMode,
      totals: {
        added: diffResult.added,
        removed: diffResult.removed,
        changed: diffResult.changed,
        unchanged: diffResult.unchanged,
        omittedFromMixedComparison: diffResult.omittedRecordCount,
      },
      changes: diffResult.entries,
    }
    const blob = new Blob([JSON.stringify(report, null, 2)], {
      type: 'application/json',
    })
    const reportUrl = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = reportUrl
    link.download = 'ib1-diff-report.json'
    link.click()
    URL.revokeObjectURL(reportUrl)
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          {mode === 'jira' ? (
            <p className="eyebrow">IB1 to Jira ticket planner</p>
          ) : (
            <nav className="breadcrumb" aria-label="Breadcrumb">
              <a href="#/">IB1 Jira Tickets</a>
              <span aria-hidden="true">/</span>
              <span aria-current="page">Compare versions</span>
            </nav>
          )}
          <h1>{mode === 'jira' ? 'IB1 Jira Tickets' : 'Compare IB1 Versions'}</h1>
        </div>
        <div className="topbar__actions">
          {mode === 'jira' ? (
            <a className="subpage-link" href={COMPARE_HASH}>
              Compare IB1 versions
              <span aria-hidden="true">→</span>
            </a>
          ) : (
            <>
              <a className="subpage-link" href="#/">
                <span aria-hidden="true">←</span>
                Back to Jira tickets
              </a>
              <button
                className="export-button"
                type="button"
                disabled={!diffResult?.entries.length}
                onClick={exportReport}
              >
                Export report
              </button>
            </>
          )}
        </div>
      </header>

      <JiraPreview hidden={mode !== 'jira'} />

      <div className="compare-view" hidden={mode !== 'compare'}>
      <section className="file-grid" aria-label="Specification files">
        <FileSlot
          title="Baseline spec"
          side="baseline"
          spec={baselineSpec}
          error={baselineError}
          active={dragSide === 'baseline'}
          onPick={handleFile}
          onDrop={handleDrop}
          onDragState={setDragSide}
        />
        <FileSlot
          title="New version"
          side="candidate"
          spec={candidateSpec}
          error={candidateError}
          active={dragSide === 'candidate'}
          onPick={handleFile}
          onDrop={handleDrop}
          onDragState={setDragSide}
        />
      </section>

      {diffResult && baselineSpec && candidateSpec ? (
        <>
          <SummaryStrip
            baselineSpec={baselineSpec}
            candidateSpec={candidateSpec}
            diffResult={diffResult}
          />

          <section className="diff-workspace" aria-label="Differences">
            <aside className="diff-browser">
              <DiffToolbar
                searchQuery={searchQuery}
                statusFilter={statusFilter}
                typeFilter={typeFilter}
                typeOptions={typeOptions}
                resultCount={filteredEntries.length}
                onSearch={setSearchQuery}
                onStatus={setStatusFilter}
                onType={setTypeFilter}
              />
              <DiffList
                entries={filteredEntries}
                selectedId={selectedEntry?.id ?? ''}
                onSelect={setSelectedDiffId}
              />
            </aside>

            <SideBySideDiff
              baselineSpec={baselineSpec}
              candidateSpec={candidateSpec}
              entries={filteredEntries}
              selectedId={selectedEntry?.id ?? ''}
            />
          </section>
        </>
      ) : (
        <section className="empty-state" aria-label="Waiting for files">
          <div>
            <span className="empty-state__mark">IB1</span>
            <h2>Load two IB1 specifications</h2>
          </div>
        </section>
      )}
      </div>
    </main>
  )
}

type FileSlotProps = {
  title: string
  side: SpecSide
  spec: ParsedSpec | null
  error: string
  active: boolean
  onPick: (side: SpecSide, fileList: FileList | null) => void
  onDrop: (event: DragEvent<HTMLLabelElement>, side: SpecSide) => void
  onDragState: (side: SpecSide | null) => void
}

function FileSlot({
  title,
  side,
  spec,
  error,
  active,
  onPick,
  onDrop,
  onDragState,
}: FileSlotProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    onPick(side, event.target.files)
    event.target.value = ''
  }

  return (
    <label
      className={`file-slot ${active ? 'is-dragging' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault()
        onDragState(side)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => onDragState(null)}
      onDrop={(event) => onDrop(event, side)}
    >
      <span className="file-slot__label">{title}</span>
      <strong>{spec?.title || 'Select document'}</strong>
      <span>
        {spec
          ? `${spec.fileName} | ${FORMAT_LABELS[spec.sourceFormat]} | ${spec.recordCount} comparable records`
          : 'XML or HTML document'}
      </span>
      {error ? <span className="file-slot__error">{error}</span> : null}
      <input
        type="file"
        accept=".xml,.html,.htm,text/xml,application/xml,text/html"
        onChange={handleChange}
      />
    </label>
  )
}

type SummaryStripProps = {
  baselineSpec: ParsedSpec
  candidateSpec: ParsedSpec
  diffResult: DiffResult
}

function SummaryStrip({
  baselineSpec,
  candidateSpec,
  diffResult,
}: SummaryStripProps) {
  return (
    <section className="summary-strip" aria-label="Diff summary">
      <div className="spec-pair">
        <span>{specSummaryLabel(baselineSpec, 'Baseline')}</span>
        <strong>{baselineSpec.title}</strong>
      </div>
      <div className="summary-metrics">
        <Metric label="Changed" value={diffResult.changed} tone="changed" />
        <Metric label="Added" value={diffResult.added} tone="added" />
        <Metric label="Removed" value={diffResult.removed} tone="removed" />
        <Metric label="Unchanged" value={diffResult.unchanged} tone="neutral" />
      </div>
      <div className="spec-pair spec-pair--right">
        <span>{specSummaryLabel(candidateSpec, 'New version')}</span>
        <strong>{candidateSpec.title}</strong>
      </div>
    </section>
  )
}

function specSummaryLabel(spec: ParsedSpec, fallback: string) {
  return `${FORMAT_LABELS[spec.sourceFormat]} | ${spec.version || spec.releaseDate || fallback}`
}

type MetricProps = {
  label: string
  value: number
  tone: 'added' | 'removed' | 'changed' | 'neutral'
}

function Metric({ label, value, tone }: MetricProps) {
  return (
    <div className={`metric metric--${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

type DiffToolbarProps = {
  searchQuery: string
  statusFilter: StatusFilter
  typeFilter: TypeFilter
  typeOptions: RecordType[]
  resultCount: number
  onSearch: (value: string) => void
  onStatus: (value: StatusFilter) => void
  onType: (value: TypeFilter) => void
}

function DiffToolbar({
  searchQuery,
  statusFilter,
  typeFilter,
  typeOptions,
  resultCount,
  onSearch,
  onStatus,
  onType,
}: DiffToolbarProps) {
  return (
    <div className="diff-toolbar">
      <div className="result-count">
        <strong>{resultCount}</strong>
        <span>visible changes</span>
      </div>
      <input
        type="search"
        value={searchQuery}
        placeholder="Search changes"
        onChange={(event) => onSearch(event.target.value)}
      />
      <select
        value={typeFilter}
        onChange={(event) => onType(event.target.value as TypeFilter)}
        aria-label="Filter by record type"
      >
        <option value="all">All record types</option>
        {typeOptions.map((typeOption) => (
          <option key={typeOption} value={typeOption}>
            {TYPE_LABELS[typeOption]}
          </option>
        ))}
      </select>
      <div className="status-segment" aria-label="Filter by change status">
        {(['all', 'changed', 'added', 'removed'] as StatusFilter[]).map(
          (statusOption) => (
            <button
              key={statusOption}
              type="button"
              aria-pressed={statusFilter === statusOption}
              onClick={() => onStatus(statusOption)}
            >
              {STATUS_LABELS[statusOption]}
            </button>
          ),
        )}
      </div>
    </div>
  )
}

type DiffListProps = {
  entries: DiffEntry[]
  selectedId: string
  onSelect: (id: string) => void
}

function DiffList({ entries, selectedId, onSelect }: DiffListProps) {
  if (!entries.length) {
    return <div className="no-results">No differences match the active filters.</div>
  }

  return (
    <div className="diff-list">
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className={`diff-entry diff-entry--${entry.status} ${
            selectedId === entry.id ? 'is-selected' : ''
          }`}
          onClick={() => onSelect(entry.id)}
        >
          <span className="diff-entry__meta">
            <span>{STATUS_LABELS[entry.status]}</span>
            <span>{TYPE_LABELS[entry.type]}</span>
          </span>
          <strong>{entry.title}</strong>
          <span className="diff-entry__path">{entry.path.join(' / ')}</span>
        </button>
      ))}
    </div>
  )
}

type DiffDetailProps = {
  baselineSpec: ParsedSpec
  candidateSpec: ParsedSpec
  entries: DiffEntry[]
  selectedId: string
}

function SideBySideDiff({
  baselineSpec,
  candidateSpec,
  entries,
  selectedId,
}: DiffDetailProps) {
  const baselineFrameRef = useRef<HTMLIFrameElement>(null)
  const candidateFrameRef = useRef<HTMLIFrameElement>(null)
  const baselineHtml = buildDocumentViewHtml(
    baselineSpec,
    entries,
    'baseline',
    selectedId,
  )
  const candidateHtml = buildDocumentViewHtml(
    candidateSpec,
    entries,
    'candidate',
    selectedId,
  )

  if (!entries.length) {
    return (
      <section className="document-comparison empty-detail">
        <h2>No matching differences</h2>
      </section>
    )
  }

  return (
    <section className="document-comparison" aria-label="Side-by-side comparison">
      <div className="document-comparison__header">
        <div>
          <span>Side-by-side review</span>
          <h2>Document differences</h2>
        </div>
        <strong>{entries.length} pinpointed changes</strong>
      </div>
      <div className="document-columns" aria-hidden="true">
        <span>Baseline document</span>
        <span>New version document</span>
      </div>
      <div className="document-frame-grid">
        <iframe
          ref={baselineFrameRef}
          className="document-frame"
          title={`${baselineSpec.title} baseline document`}
          sandbox="allow-same-origin"
          srcDoc={baselineHtml}
          onLoad={() => scrollSelectedDiffIntoView(baselineFrameRef.current)}
        />
        <iframe
          ref={candidateFrameRef}
          className="document-frame"
          title={`${candidateSpec.title} new version document`}
          sandbox="allow-same-origin"
          srcDoc={candidateHtml}
          onLoad={() => scrollSelectedDiffIntoView(candidateFrameRef.current)}
        />
      </div>
    </section>
  )
}

function buildDocumentViewHtml(
  spec: ParsedSpec,
  entries: DiffEntry[],
  side: DocumentSide,
  selectedId: string,
) {
  const sourceHtml = spec.sourceHtml ?? buildGeneratedDocumentHtml(spec)
  const htmlDocument = new DOMParser().parseFromString(sourceHtml, 'text/html')
  const statusByAnchor = new Map<string, DiffStatus>()
  let selectedAnchor = ''

  entries.forEach((entry) => {
    const record = side === 'baseline' ? entry.before : entry.after

    if (!record?.anchor) {
      return
    }

    statusByAnchor.set(record.anchor, entry.status)

    if (entry.id === selectedId) {
      selectedAnchor = record.anchor
    }
  })

  htmlDocument.querySelectorAll('[data-diff-anchor]').forEach((element) => {
    const anchor = element.getAttribute('data-diff-anchor') ?? ''
    const status = statusByAnchor.get(anchor)

    if (!status) {
      return
    }

    element.classList.add('ib1-diff-marker', `ib1-diff-${status}`)

    if (anchor === selectedAnchor) {
      element.classList.add('ib1-diff-selected')
      element.setAttribute('data-diff-selected', 'true')
    }
  })

  injectDocumentHighlightStyles(htmlDocument)
  return serializeHtmlDocument(htmlDocument)
}

function injectDocumentHighlightStyles(htmlDocument: Document) {
  const style = htmlDocument.createElement('style')
  style.textContent = `
    html { scroll-behavior: smooth; }
    body { padding: 12px; }
    [data-diff-anchor] { scroll-margin: 72px; }
    tr.ib1-diff-added > td,
    tr.ib1-diff-added > th { background: #ddf7e8 !important; }
    tr.ib1-diff-removed > td,
    tr.ib1-diff-removed > th { background: #ffe0dd !important; }
    tr.ib1-diff-changed > td,
    tr.ib1-diff-changed > th { background: #fff0bd !important; }
    .ib1-diff-marker:not(tr) {
      border-left: 6px solid #b7791f !important;
      margin-left: 0 !important;
      background: #fff0bd !important;
    }
    .ib1-diff-added:not(tr) {
      border-left-color: #16815f !important;
      background: #ddf7e8 !important;
    }
    .ib1-diff-removed:not(tr) {
      border-left-color: #b64343 !important;
      background: #ffe0dd !important;
    }
    .ib1-diff-selected {
      outline: 4px solid #235789 !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 0 5px rgba(35, 87, 137, 0.2) !important;
      position: relative;
      z-index: 1;
    }
  `
  htmlDocument.head.append(style)
}

function buildGeneratedDocumentHtml(spec: ParsedSpec) {
  const records = spec.records
    .map(
      (record) => `
        <section data-diff-anchor="${escapeHtml(record.anchor ?? record.key)}">
          <h2>${escapeHtml(record.title)}</h2>
          <p>${escapeHtml(record.path.join(' / '))}</p>
          <table>
            <tbody>
              ${Object.entries(record.fields)
                .map(
                  ([fieldName, value]) => `
                    <tr>
                      <th>${escapeHtml(fieldName)}</th>
                      <td>${escapeHtml(value)}</td>
                    </tr>
                  `,
                )
                .join('')}
            </tbody>
          </table>
        </section>
      `,
    )
    .join('')

  return `<!doctype html>
    <html>
      <head>
        <title>${escapeHtml(spec.title)}</title>
        <style>
          body { margin: 0; font-family: Helvetica, Arial, sans-serif; font-size: 13px; }
          h1 { margin: 0 0 12px; }
          h2 { margin: 0 0 4px; font-size: 18px; }
          p { margin: 0 0 10px; color: #64726c; }
          section { padding: 14px; border-bottom: 1px solid #d9d1bd; }
          table { width: 100%; border-collapse: collapse; background: #fff; }
          th, td { padding: 6px 8px; border: 1px solid #ccc; text-align: left; vertical-align: top; }
          th { width: 190px; background: #f7f2e6; }
        </style>
      </head>
      <body>
        <h1>${escapeHtml(spec.title)}</h1>
        ${records}
      </body>
    </html>`
}

function scrollSelectedDiffIntoView(frame: HTMLIFrameElement | null) {
  const selectedElement = frame?.contentDocument?.querySelector(
    '[data-diff-selected="true"]',
  )
  selectedElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
}

type HtmlSection = {
  title: string
  headingElement: Element
  nodes: ChildNode[]
}

const PROCEDURE_COLUMNS = [
  'Number',
  'Kind',
  'KD',
  'P',
  'Optional',
  'Standard IBNB',
  'Name',
  'Description',
  'Service',
  'Parameter',
  'Target value',
  'PID',
  'Logical link',
  'IBNZ',
  'Variants',
] as const

async function parseSpecFile(file: File): Promise<ParsedSpec> {
  const text = await file.text()

  if (isHtmlSpec(text, file.name)) {
    return parseIb1HtmlSpec(text, file.name)
  }

  return parseIb1Spec(text, file.name)
}

function isHtmlSpec(text: string, fileName: string) {
  return (
    /\.html?$/i.test(fileName) ||
    /^\s*<!doctype\s+html/i.test(text) ||
    /^\s*<html[\s>]/i.test(text)
  )
}

function parseIb1HtmlSpec(htmlText: string, fileName: string): ParsedSpec {
  const htmlDocument = new DOMParser().parseFromString(htmlText, 'text/html')
  const body = htmlDocument.body

  if (!body || !normalizeText(body.textContent ?? '')) {
    throw new Error('Expected an IB1 HTML document')
  }

  const records: ComparableRecord[] = []
  const usedKeys = new Map<string, number>()
  let order = 0

  function addRecord(record: RecordDraft) {
    const { anchorElement, ...recordInput } = record
    const fields = normalizeFields(recordInput.fields)

    if (!Object.keys(fields).length) {
      return
    }

    const usedCount = usedKeys.get(recordInput.key) ?? 0
    const uniqueKey = usedCount
      ? `${recordInput.key}#${usedCount + 1}`
      : recordInput.key
    const anchor = recordInput.anchor ?? `ib1-record-${order}`
    usedKeys.set(recordInput.key, usedCount + 1)
    anchorElement?.setAttribute('data-diff-anchor', anchor)
    records.push({ ...recordInput, key: uniqueKey, fields, anchor, order })
    order += 1
  }

  const specTitle =
    htmlLabelValue(body, 'Name') || normalizeText(htmlDocument.title) || fileName
  const releaseDate =
    htmlLabelValue(body, 'Release-Datum') || htmlLabelValue(body, 'Release date')
  const version = extractHtmlFileVersion(fileName) || htmlLatestRevision(htmlDocument)

  addRecord({
    key: recordKey('metadata', 'spec'),
    type: 'metadata',
    title: 'Specification identity',
    path: ['Specification'],
    anchorElement: body.querySelector('b') ?? body,
    fields: {
      Name: specTitle,
      'Release date': releaseDate,
      Version: version,
      Format: 'Generated HTML',
    },
  })

  collectHtmlSections(body).forEach((section) =>
    processHtmlSection(section, addRecord),
  )
  processHtmlProcedureTables(htmlDocument, addRecord)

  if (records.length <= 1) {
    throw new Error('No comparable records were found in this HTML document')
  }

  return {
    fileName,
    title: specTitle,
    version,
    releaseDate,
    recordCount: records.length,
    sourceFormat: 'html',
    sourceHtml: serializeHtmlDocument(htmlDocument),
    records,
  }
}

function htmlLabelValue(body: HTMLElement, label: string) {
  const targetLabel = normalizeHtmlLabel(label)
  const labelElement = Array.from(body.children).find(
    (element) =>
      element.tagName === 'B' &&
      normalizeHtmlLabel(element.textContent ?? '') === targetLabel,
  )

  if (!labelElement) {
    return ''
  }

  let value = ''
  let sibling = labelElement.nextSibling

  while (sibling) {
    if (sibling.nodeType === Node.ELEMENT_NODE) {
      const siblingElement = sibling as Element

      if (siblingElement.tagName === 'BR') {
        break
      }
    }

    value += sibling.textContent ?? ''
    sibling = sibling.nextSibling
  }

  return normalizeText(value)
}

function collectHtmlSections(body: HTMLElement): HtmlSection[] {
  const sections: HtmlSection[] = []
  let currentSection: HtmlSection | null = null

  Array.from(body.childNodes).forEach((node) => {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as Element

      if (element.tagName === 'B') {
        const title = cleanHtmlSectionTitle(element.textContent ?? '')

        if (isHtmlMetadataSection(title)) {
          currentSection = null
          return
        }

        const nextSection = { title, headingElement: element, nodes: [] }
        currentSection = nextSection
        sections.push(nextSection)
        return
      }
    }

    currentSection?.nodes.push(node)
  })

  return sections
}

function processHtmlSection(
  section: HtmlSection,
  addRecord: (record: RecordDraft) => void,
) {
  const sectionTitle = cleanHtmlSectionTitle(section.title)
  const sectionType = htmlRecordTypeForSection(sectionTitle)
  const elements = section.nodes.filter(isElementNode)

  elements
    .filter((element): element is HTMLTableElement => element.tagName === 'TABLE')
    .forEach((table, tableIndex) => {
      if (!isHtmlProcedureTable(table)) {
        processHtmlTable(sectionTitle, sectionType, table, tableIndex, addRecord)
      }
    })

  elements
    .filter((element) => element.tagName === 'UL' || element.tagName === 'OL')
    .forEach((listElement) =>
      processHtmlList(sectionTitle, sectionType, listElement, addRecord),
    )

  const looseText = htmlLooseSectionText(section.nodes)

  if (looseText) {
    addRecord({
      key: recordKey(sectionType, sectionTitle),
      type: sectionType,
      title: sectionTitle,
      path: [sectionTitle],
      anchorElement: section.headingElement,
      fields: {
        Text: looseText,
      },
    })
  }
}

function processHtmlTable(
  sectionTitle: string,
  sectionType: RecordType,
  table: HTMLTableElement,
  tableIndex: number,
  addRecord: (record: RecordDraft) => void,
) {
  const headers = htmlTableHeaders(table)
  const rows = htmlTableDataRows(table)

  if (!rows.length) {
    return
  }

  if (!headers.length) {
    addRecord({
      key: recordKey(sectionType, sectionTitle, `table ${tableIndex + 1}`),
      type: sectionType,
      title: sectionTitle,
      path: [sectionTitle],
      anchorElement: table,
      fields: htmlKeyValueTableFields(rows),
    })
    return
  }

  rows.forEach((row, rowIndex) => {
    const fields = htmlTableRowFields(headers, htmlCellTexts(row))
    const title = htmlTableRecordTitle(sectionType, fields, rowIndex)

    addRecord({
      key: recordKey(sectionType, sectionTitle, title),
      type: sectionType,
      title,
      path: [sectionTitle, title],
      anchorElement: row,
      fields,
    })
  })
}

function processHtmlList(
  sectionTitle: string,
  sectionType: RecordType,
  listElement: Element,
  addRecord: (record: RecordDraft) => void,
) {
  Array.from(listElement.querySelectorAll('li')).forEach((item, itemIndex) => {
    const value = normalizeText(item.textContent ?? '')

    if (!value) {
      return
    }

    const title = value.length > 90 ? `${value.slice(0, 87)}...` : value

    addRecord({
      key: recordKey(sectionType, sectionTitle, value),
      type: sectionType,
      title: title || `Item ${itemIndex + 1}`,
      path: [sectionTitle],
      anchorElement: item,
      fields: {
        Item: value,
      },
    })
  })
}

function processHtmlProcedureTables(
  htmlDocument: Document,
  addRecord: (record: RecordDraft) => void,
) {
  Array.from(htmlDocument.querySelectorAll('table')).forEach((table, tableIndex) => {
    if (!isHtmlProcedureTable(table)) {
      return
    }

    const procedureTitle = htmlProcedureTitle(table) || `Procedure ${tableIndex + 1}`
    const procedurePath = ['Procedures', procedureTitle]
    const procedureElement = table.querySelector('.rowPROCEDURE') ?? table

    addRecord({
      key: recordKey('procedure', procedureTitle),
      type: 'procedure',
      title: procedureTitle,
      path: procedurePath,
      anchorElement: procedureElement,
      fields: {
        Name: procedureTitle,
      },
    })

    Array.from(table.rows).forEach((row) =>
      processHtmlProcedureRow(procedureTitle, row, addRecord),
    )
  })
}

function processHtmlProcedureRow(
  procedureTitle: string,
  row: HTMLTableRowElement,
  addRecord: (record: RecordDraft) => void,
) {
  if (Array.from(row.cells).some((cell) => cell.tagName === 'TH')) {
    return
  }

  const cells = htmlCellTexts(row)
  const kind = normalizeProcedureKind(cells[1] ?? '')

  if (!kind || kind === 'PROCEDURE') {
    return
  }

  const recordType = htmlProcedureRecordType(kind)
  const number = cells[0] ?? ''
  const title = htmlProcedureRowTitle(kind, cells)
  const fields = htmlProcedureRowFields(kind, cells)

  addRecord({
    key: recordKey(recordType, procedureTitle, title, cells[11] ?? ''),
    type: recordType,
    title,
    path: ['Procedures', procedureTitle, `${formatProcedureKind(kind)}: ${title}`],
    anchorElement: row,
    fields: {
      Number: number,
      ...fields,
    },
  })
}

function htmlProcedureRowFields(kind: string, cells: string[]) {
  if (kind === 'CASE') {
    const details = cells[2] ?? ''

    return {
      Kind: formatProcedureKind(kind),
      Switch: htmlProcedureLabelValue(details, 'SWITCH'),
      Name: htmlProcedureLabelValue(details, 'CASE') || details,
      Details: details,
    }
  }

  if (cells.length >= PROCEDURE_COLUMNS.length) {
    return htmlTableRowFields([...PROCEDURE_COLUMNS], cells)
  }

  const fallbackName = cells[6] || cells[2] || cells[1] || `${formatProcedureKind(kind)} ${cells[0] ?? ''}`

  return {
    Kind: formatProcedureKind(kind),
    Name: fallbackName,
    Details: cells.slice(2).join('\n'),
  }
}

function htmlProcedureRowTitle(kind: string, cells: string[]) {
  if (kind === 'CASE') {
    return htmlProcedureLabelValue(cells[2] ?? '', 'CASE') || cells[2] || 'Case'
  }

  return (
    cells[6] ||
    cells[2] ||
    cells[1] ||
    `${formatProcedureKind(kind)} ${cells[0] ?? ''}`
  )
}

function htmlProcedureRecordType(kind: string): RecordType {
  if (kind === 'BLOCK') {
    return 'block'
  }

  if (kind === 'CASE') {
    return 'case'
  }

  return 'step'
}

function htmlProcedureLabelValue(value: string, label: string) {
  const normalized = normalizeText(value)
  const match = normalized.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, 'i'))
  return normalizeText(match?.[1]?.replace(/-\s*$/, '') ?? '')
}

function htmlProcedureTitle(table: HTMLTableElement) {
  return normalizeText(
    table.querySelector('.rowPROCEDURE h1')?.textContent ??
      table.querySelector('.rowPROCEDURE')?.textContent ??
      '',
  )
}

function isHtmlProcedureTable(table: HTMLTableElement) {
  const normalizedHeaders = htmlTableHeaders(table).map(normalizeHtmlHeading)
  return (
    normalizedHeaders.includes('nr') &&
    normalizedHeaders.includes('typ') &&
    normalizedHeaders.includes('arbeitsgang') &&
    normalizedHeaders.includes('ibnz')
  )
}

function htmlTableHeaders(table: HTMLTableElement) {
  const headerRow = Array.from(table.rows).find((row) =>
    Array.from(row.cells).some((cell) => cell.tagName === 'TH'),
  )

  if (!headerRow) {
    return []
  }

  return htmlCellTexts(headerRow).map(
    (header, headerIndex) => header || `Column ${headerIndex + 1}`,
  )
}

function htmlTableDataRows(table: HTMLTableElement) {
  return Array.from(table.rows).filter(
    (row) =>
      !Array.from(row.cells).some((cell) => cell.tagName === 'TH') &&
      htmlCellTexts(row).some(Boolean),
  )
}

function htmlKeyValueTableFields(rows: HTMLTableRowElement[]) {
  return Object.fromEntries(
    rows.map((row, rowIndex) => {
      const cells = htmlCellTexts(row)
      const fieldName = canonicalHtmlFieldName(cells[0] || `Row ${rowIndex + 1}`)
      const value = cells.slice(1).join(' | ') || cells[0]
      return [fieldName, value]
    }),
  )
}

function htmlTableRowFields(headers: string[], cells: string[]) {
  return Object.fromEntries(
    headers.map((header, cellIndex) => [canonicalHtmlFieldName(header), cells[cellIndex] ?? '']),
  )
}

function canonicalHtmlFieldName(fieldName: string) {
  return MIXED_FIELD_ALIASES[normalizeHtmlHeading(fieldName)] ?? fieldName
}

function htmlTableRecordTitle(
  sectionType: RecordType,
  fields: Record<string, string>,
  rowIndex: number,
) {
  if (sectionType === 'validity') {
    const validityTitle = [
      fields['Produkt-ID'],
      fields.Fahrzeug,
      fields['Teile-Nr.'],
      fields.Beschreibung,
    ]
      .filter(Boolean)
      .join(' | ')

    if (validityTitle) {
      return validityTitle
    }
  }

  const preferredFields = [
    'Name',
    'Version',
    'Produkt-ID',
    'Funktion',
    'Arbeitsgang',
    'Beschreibung',
    'Datei-System',
  ]
  const title = preferredFields.map((fieldName) => fields[fieldName]).find(Boolean)
  return title || `Row ${rowIndex + 1}`
}

function htmlCellTexts(row: HTMLTableRowElement) {
  return Array.from(row.cells).map((cell) => normalizeText(cell.textContent ?? ''))
}

function htmlLooseSectionText(nodes: ChildNode[]) {
  return normalizeText(
    nodes
      .map((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return node.textContent ?? ''
        }

        if (node.nodeType !== Node.ELEMENT_NODE) {
          return ''
        }

        const element = node as Element

        if (['BR', 'TABLE', 'UL', 'OL'].includes(element.tagName)) {
          return ''
        }

        return element.textContent ?? ''
      })
      .join('\n'),
  )
}

function htmlRecordTypeForSection(title: string): RecordType {
  const normalizedTitle = normalizeHtmlHeading(title)

  if (normalizedTitle.includes('ansprechpartner')) {
    return 'contact'
  }

  if (normalizedTitle.includes('anderungsdokumentation')) {
    return 'revision'
  }

  if (normalizedTitle.includes('varianten')) {
    return 'variant'
  }

  if (normalizedTitle.includes('gultigkeiten')) {
    return 'validity'
  }

  if (normalizedTitle.includes('ziele')) {
    return 'objective'
  }

  if (normalizedTitle.includes('diagnose')) {
    return 'diagnostic'
  }

  if (
    normalizedTitle.includes('fahrzeugaufbauzustand') ||
    normalizedTitle.includes('abhangigkeiten')
  ) {
    return 'condition'
  }

  if (normalizedTitle.includes('zugriffs')) {
    return 'access'
  }

  if (normalizedTitle.includes('produktions') || normalizedTitle.includes('transport')) {
    return 'mode'
  }

  if (normalizedTitle.includes('security')) {
    return 'security'
  }

  if (normalizedTitle.includes('dokumente') || normalizedTitle.includes('bzd')) {
    return 'document'
  }

  if (normalizedTitle.includes('referenzen')) {
    return 'reference'
  }

  return 'reference'
}

function htmlLatestRevision(htmlDocument: Document) {
  const revisionTable = Array.from(htmlDocument.querySelectorAll('table')).find((table) => {
    const normalizedHeaders = htmlTableHeaders(table).map(normalizeHtmlHeading)
    return normalizedHeaders.includes('version') && normalizedHeaders.includes('datum')
  })

  if (!revisionTable) {
    return ''
  }

  const revisionRows = htmlTableDataRows(revisionTable)
  const latestRevision = revisionRows.at(-1)
  return latestRevision ? htmlCellTexts(latestRevision)[0] ?? '' : ''
}

function extractHtmlFileVersion(fileName: string) {
  return fileName.match(/(?:^|_)V?(\d+(?:_\d+)+)(?:\.[^.]+)?$/i)?.[1] ?? ''
}

function cleanHtmlSectionTitle(value: string) {
  return normalizeText(value).replace(/:\s*$/, '')
}

function isHtmlMetadataSection(title: string) {
  return ['name', 'release-datum', 'release date'].includes(normalizeHtmlHeading(title))
}

function normalizeProcedureKind(value: string) {
  return normalizeText(value).replace(/\s+/g, '').toUpperCase()
}

function formatProcedureKind(value: string) {
  return formatFieldName(value.toLowerCase())
}

function normalizeHtmlLabel(value: string) {
  return normalizeHtmlHeading(value).replace(/:.*/, '')
}

function normalizeHtmlHeading(value: string) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/:\s*$/, '')
    .toLowerCase()
}

function isElementNode(node: ChildNode): node is Element {
  return node.nodeType === Node.ELEMENT_NODE
}

function parseIb1Spec(xmlText: string, fileName: string): ParsedSpec {
  const xmlDocument = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parserError = xmlDocument.querySelector('parsererror')

  if (parserError) {
    throw new Error(normalizeText(parserError.textContent ?? 'Invalid XML'))
  }

  const root = xmlDocument.documentElement

  if (!root || root.tagName !== 'IB-1') {
    throw new Error('Expected an IB-1 XML document')
  }

  const records: ComparableRecord[] = []
  const usedKeys = new Map<string, number>()
  let order = 0

  function addRecord(record: Omit<ComparableRecord, 'order'>) {
    const fields = normalizeFields(record.fields)

    if (!Object.keys(fields).length) {
      return
    }

    const usedCount = usedKeys.get(record.key) ?? 0
    const uniqueKey = usedCount ? `${record.key}#${usedCount + 1}` : record.key
    usedKeys.set(record.key, usedCount + 1)
    records.push({ ...record, key: uniqueKey, fields, anchor: `ib1-record-${order}`, order })
    order += 1
  }

  const specTitle = textOf(root, 'NAME') || fileName
  const releaseDate = textOf(root, 'RELEASE-DATE')
  const formatVersion = root.getAttribute('version') ?? ''

  addRecord({
    key: recordKey('metadata', 'spec'),
    type: 'metadata',
    title: 'Specification identity',
    path: ['Specification'],
    fields: {
      Name: specTitle,
      'Release date': releaseDate,
      'IBN required': textOf(root, 'IBN-REQUIRED'),
      'Format version': formatVersion,
      Schema: root.getAttribute('xsi:noNamespaceSchemaLocation') ?? '',
    },
  })

  processDocumentInfo(child(root, 'DOC-INFO'), addRecord)
  processIbDescription(child(root, 'IB-DESCRIPTION'), addRecord)
  processAdjustments(root, addRecord)
  processDiagnosticInfos(child(root, 'DIAG-INFOS'), addRecord)
  processEnvironment(child(root, 'ENVIRONMENT'), addRecord)
  processProcedures(child(root, 'PROCEDURES'), addRecord)
  processSecurityProperties(child(root, 'SECURITY-PROPERTIES'), addRecord)
  processReferences(child(root, 'REFERENCES'), addRecord)

  return {
    fileName,
    title: specTitle,
    version: formatVersion,
    releaseDate,
    recordCount: records.length,
    sourceFormat: 'xml',
    records,
  }
}

function processDocumentInfo(
  docInfo: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  if (!docInfo) {
    return
  }

  childElements(child(docInfo, 'CONTACTS'), 'CONTACT').forEach((contact) => {
    const name = textOf(contact, 'NAME') || contact.getAttribute('id') || 'Unnamed contact'

    addRecord({
      key: recordKey('contact', name),
      type: 'contact',
      title: name,
      path: ['Document info', 'Contacts', name],
      fields: {
        Name: name,
        Company: textOf(contact, 'COMPANY'),
        Division: textOf(contact, 'DIVISION'),
        Department: textOf(contact, 'DEPARTMENT'),
        Role: textOf(contact, 'ROLE'),
        Phone: textOf(contact, 'PHONE'),
        'Mobile phone': textOf(contact, 'MOBILE-PHONE'),
        Mail: textOf(contact, 'MAIL'),
      },
    })
  })

  childElements(child(docInfo, 'DOC-REVISIONS'), 'DOC-REVISION').forEach(
    (revision) => {
      const version = textOf(revision, 'VERSION') || 'Unversioned revision'
      const authorRef = child(revision, 'AUTHOR-REF')?.getAttribute('ref') ?? ''

      addRecord({
        key: recordKey('revision', version),
        type: 'revision',
        title: version,
        path: ['Document info', 'Revisions', version],
        fields: {
          Version: version,
          Date: textOf(revision, 'DATE'),
          Author: authorRef,
          Change: textOf(revision, 'CHANGE'),
          Tool: textOf(revision, 'TOOL'),
        },
      })
    },
  )
}

function processIbDescription(
  description: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  if (!description) {
    return
  }

  childElements(child(description, 'IB-VARIANTS'), 'IB-VARIANT').forEach(
    (variant) => {
      const name = textOf(variant, 'NAME') || 'Unnamed variant'
      const productId = textOf(variant, 'PRODUCT-ID')
      const identity = productId || name

      addRecord({
        key: recordKey('variant', identity),
        type: 'variant',
        title: name,
        path: ['IB description', 'Variants', name],
        fields: {
          Name: name,
          'Product ID': productId,
          Description: textOf(variant, 'DESC'),
        },
      })
    },
  )

  const validitiesRef = textOf(description, 'VALIDITIES-REF')

  addRecord({
    key: recordKey('metadata', 'validities-ref'),
    type: 'metadata',
    title: 'Validities reference',
    path: ['IB description'],
    fields: {
      'Validities reference': validitiesRef,
    },
  })

  childElements(child(description, 'OBJECTIVES'), 'OBJECTIVE').forEach(
    (objective) => {
      const objectiveText = normalizeText(objective.textContent ?? '')

      addRecord({
        key: recordKey('objective', objectiveText),
        type: 'objective',
        title: objectiveText,
        path: ['IB description', 'Objectives'],
        fields: {
          Objective: objectiveText,
        },
      })
    },
  )
}

function processAdjustments(
  root: Element,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  const sections = [
    ['CUSTOMER-ADJUSTMENTS', 'Customer adjustments'],
    ['PRODUCTION-ADJUSTMENTS', 'Production adjustments'],
  ] as const

  sections.forEach(([tagName, title]) => {
    childElements(child(root, tagName), '*').forEach((adjustment) => {
      addRecord({
        key: recordKey('adjustment', title, adjustment.tagName),
        type: 'adjustment',
        title: formatFieldName(adjustment.tagName),
        path: [title],
        fields: {
          Value: normalizeText(adjustment.textContent ?? ''),
        },
      })
    })
  })
}

function processDiagnosticInfos(
  diagnostics: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  childElements(diagnostics, 'DIAG-INFO').forEach((diagnostic) => {
    const ecuId = textOf(diagnostic, 'ECU-ID') || 'Unknown ECU'
    const protocol = textOf(diagnostic, 'DIAG-PROTOCOL')

    addRecord({
      key: recordKey('diagnostic', ecuId, protocol),
      type: 'diagnostic',
      title: `ECU ${ecuId}`,
      path: ['Diagnostic infos', ecuId],
      fields: {
        'Diagnostic protocol': protocol,
        'Transport protocol': textOf(diagnostic, 'TRANSPORT-PROTOCOL'),
        'ECU ID': ecuId,
        ODXS: normalizeText(child(diagnostic, 'PDX')?.textContent ?? ''),
      },
    })
  })
}

function processEnvironment(
  environment: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  if (!environment) {
    return
  }

  childElements(child(environment, 'DEPENDENCIES'), 'DEPENDENCY').forEach(
    (dependency) => {
      const value = normalizeText(dependency.textContent ?? '')

      addRecord({
        key: recordKey('condition', value),
        type: 'condition',
        title: value,
        path: ['Environment', 'Dependencies'],
        fields: {
          Text: value,
        },
      })
    },
  )

  childElements(child(environment, 'PRODUCTION-MODES'), 'PRODUCTION-MODE').forEach(
    (productionMode) => {
      const name = textOf(productionMode, 'NAME') || 'Unnamed production mode'
      const bytes = child(productionMode, 'BYTES')

      addRecord({
        key: recordKey('mode', name),
        type: 'mode',
        title: name,
        path: ['Environment', 'Production modes', name],
        fields: {
          Name: name,
          Description: textOf(productionMode, 'DESC'),
          'Byte 0': textOf(bytes, 'BYTE-0'),
          'Byte 1': textOf(bytes, 'BYTE-1'),
          'Byte 2': textOf(bytes, 'BYTE-2'),
        },
      })
    },
  )

  const transportMode = textOf(environment, 'TRANSPORT-MODE')

  addRecord({
    key: recordKey('mode', 'Transport mode'),
    type: 'mode',
    title: 'Transport mode',
    path: ['Environment', 'Transport mode'],
    fields: {
      Text: transportMode,
    },
  })
}

function processProcedures(
  procedures: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  childElements(procedures, 'PROCEDURE').forEach((procedure) => {
    const procedureName = textOf(procedure, 'NAME') || 'Unnamed procedure'
    const procedurePath = ['Procedures', procedureName]
    const procedureKey = recordKey('procedure', procedureName)

    addRecord({
      key: procedureKey,
      type: 'procedure',
      title: procedureName,
      path: procedurePath,
      fields: {
        Name: procedureName,
      },
    })

    childElements(procedure, 'BLOCK').forEach((block) =>
      processBlock(block, procedureKey, procedurePath, addRecord),
    )
    childElements(procedure, 'SWITCH').forEach((switchElement) =>
      processSwitch(switchElement, procedureKey, procedurePath, addRecord),
    )
  })
}

function processSwitch(
  switchElement: Element,
  ownerKey: string,
  parentPath: string[],
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  const switchName = textOf(switchElement, 'NAME') || 'Unnamed switch'
  const switchKey = recordKey('switch', ownerKey, switchName)
  const switchPath = [...parentPath, `Switch: ${switchName}`]

  addRecord({
    key: switchKey,
    type: 'switch',
    title: switchName,
    path: switchPath,
    fields: {
      ...attributeFields(switchElement),
      Name: switchName,
    },
  })

  childElements(switchElement, 'CASE').forEach((caseElement) => {
    const caseName = textOf(caseElement, 'NAME') || 'Unnamed case'
    const caseKey = recordKey('case', switchKey, caseName)
    const casePath = [...switchPath, `Case: ${caseName}`]

    addRecord({
      key: caseKey,
      type: 'case',
      title: caseName,
      path: casePath,
      fields: {
        ...attributeFields(caseElement),
        Name: caseName,
      },
    })

    childElements(child(caseElement, 'BLOCKS'), 'BLOCK').forEach((block) =>
      processBlock(block, caseKey, casePath, addRecord),
    )
  })
}

function processBlock(
  block: Element,
  ownerKey: string,
  parentPath: string[],
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  const blockName = textOf(block, 'NAME') || block.getAttribute('shortname') || 'Unnamed block'
  const blockIdentity = block.getAttribute('shortname') || blockName
  const blockKey = recordKey('block', ownerKey, blockIdentity)
  const blockPath = [...parentPath, `Block: ${blockName}`]
  const ibnz = child(block, 'IBNZ')

  addRecord({
    key: blockKey,
    type: 'block',
    title: blockName,
    path: blockPath,
    fields: {
      ...attributeFields(block, {
        standardIBNB: 'Standard IBNB',
        shortname: 'Short name',
        version: 'Block version',
        optional: 'Optional',
        'P-relevant': 'P relevant',
        'KD-relevant': 'KD relevant',
      }),
      Name: blockName,
      'English name': textOf(block, 'NAME_EN'),
      Description: textOf(block, 'DESC'),
      Category: textOf(block, 'CATEGORY'),
      'Logical link': textOf(block, 'LOGICAL-LINK'),
      'Diagnostic session': textOf(block, 'DIAGNOSTIC-SESSION'),
      'IBNZ VSI': textOf(ibnz, 'VSI'),
      Links: serializeLinks(block),
    },
  })

  processParameters(child(block, 'PARAMETERS'), blockKey, blockPath, addRecord)
  processSteps(child(block, 'STEPS'), blockKey, blockPath, addRecord)
}

function processParameters(
  parameters: Element | null,
  ownerKey: string,
  parentPath: string[],
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  childElements(parameters, 'PARAMETER').forEach((parameter) => {
    const key = textOf(parameter, 'KEY') || 'Unnamed parameter'
    const parameterPath = [...parentPath, `Parameter: ${key}`]

    addRecord({
      key: recordKey('parameter', ownerKey, key),
      type: 'parameter',
      title: key,
      path: parameterPath,
      fields: {
        ...attributeFields(parameter, {
          optional: 'Optional',
          type: 'Parameter type',
        }),
        Key: key,
        Description: textOf(parameter, 'DESC'),
        Datatype: textOf(parameter, 'DATATYPE'),
        Value: textOf(parameter, 'VALUE'),
        Default: textOf(parameter, 'DEFAULT'),
      },
    })
  })
}

function processSteps(
  steps: Element | null,
  ownerKey: string,
  parentPath: string[],
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  if (!steps) {
    return
  }

  processWorkflowElements(childElements(steps, '*'), ownerKey, parentPath, addRecord)
}

function processWorkflowElements(
  elements: Element[],
  ownerKey: string,
  parentPath: string[],
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  elements.filter(isWorkflowElement).forEach((element, index) => {
    processWorkflowElement(element, ownerKey, parentPath, index, addRecord)
  })
}

function processWorkflowElement(
  element: Element,
  ownerKey: string,
  parentPath: string[],
  index: number,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  if (element.tagName === 'STEP' || element.tagName === 'HMI-STEP') {
    processDiagnosticWorkflowStep(element, ownerKey, parentPath, index, addRecord)
    return
  }

  const controlKind = formatFieldName(element.tagName)
  const controlName = textOf(element, 'NAME') || `${controlKind} ${index + 1}`
  const controlKey = recordKey('step', ownerKey, controlKind, controlName)
  const controlPath = [...parentPath, `${controlKind}: ${controlName}`]

  addRecord({
    key: controlKey,
    type: 'step',
    title: controlName,
    path: controlPath,
    fields: {
      ...attributeFields(element),
      Kind: controlKind,
      Name: controlName,
      Description: textOf(element, 'DESC'),
      Timeout: textOf(element, 'TIMEOUT'),
    },
  })

  const nestedSteps = child(element, 'STEPS')
  const nestedElements = nestedSteps
    ? childElements(nestedSteps, '*')
    : childElements(element, '*').filter(isWorkflowElement)

  processWorkflowElements(nestedElements, controlKey, controlPath, addRecord)
}

function processDiagnosticWorkflowStep(
  step: Element,
  ownerKey: string,
  parentPath: string[],
  index: number,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  const stepKind = step.tagName === 'HMI-STEP' ? 'HMI step' : 'Diagnostic step'
  const stepName = textOf(step, 'NAME') || `${stepKind} ${index + 1}`
  const stepKey = recordKey('step', ownerKey, stepKind, stepName)
  const stepPath = [...parentPath, `${stepKind}: ${stepName}`]
  const timeParameter = child(step, 'TIME-PARAMETER')
  const valueProxy = child(timeParameter, 'VALUE-PROXY')
  const valueReference = child(valueProxy, 'VALUE-REF')?.getAttribute('ref') ?? ''

  addRecord({
    key: stepKey,
    type: 'step',
    title: stepName,
    path: stepPath,
    fields: {
      ...attributeFields(step, { cyclic: 'Cyclic' }),
      Kind: stepKind,
      Name: stepName,
      Description: textOf(step, 'DESC'),
      'Time description': textOf(timeParameter, 'DESC'),
      'Time value': textOf(timeParameter, 'VALUE'),
      'Time value reference': valueReference,
    },
  })

  const request = child(step, 'RESTFUL-API-REQUEST')

  if (request) {
    const method = textOf(request, 'METHOD')
    const uri = textOf(request, 'URI')

    addRecord({
      key: recordKey('api', stepKey),
      type: 'api',
      title: `${method || 'REST'} ${uri || 'request'}`,
      path: [...stepPath, 'REST request'],
      fields: {
        Method: method,
        URI: uri,
        Input: normalizePayload(textOf(request, 'INPUT')),
        Output: normalizePayload(textOf(request, 'OUTPUT')),
      },
    })
  }
}

function isWorkflowElement(element: Element) {
  return WORKFLOW_ELEMENT_TAGS.has(element.tagName)
}

function processSecurityProperties(
  securityProperties: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  childElements(securityProperties, 'ECU').forEach((ecu) => {
    const ecuName = textOf(ecu, 'NAME') || textOf(ecu, 'ECU-ID') || 'Unnamed ECU'
    const ecuId = textOf(ecu, 'ECU-ID')

    childElements(ecu, 'SECURITY-PROPERTY').forEach((securityProperty) => {
      const securityKey = textOf(securityProperty, 'KEY') || 'Security property'

      addRecord({
        key: recordKey('security', ecuName, securityKey),
        type: 'security',
        title: securityKey,
        path: ['Security properties', ecuName],
        fields: {
          ECU: ecuName,
          'ECU ID': ecuId,
          Key: securityKey,
        },
      })
    })
  })
}

function processReferences(
  references: Element | null,
  addRecord: (record: Omit<ComparableRecord, 'order'>) => void,
) {
  if (!references || !normalizeText(references.textContent ?? '')) {
    return
  }

  addRecord({
    key: recordKey('reference', 'references'),
    type: 'reference',
    title: 'References',
    path: ['References'],
    fields: {
      References: normalizeText(references.textContent ?? ''),
    },
  })
}

function compareSpecs(baselineSpec: ParsedSpec, candidateSpec: ParsedSpec): DiffResult {
  const comparisonMode: ComparisonMode =
    baselineSpec.sourceFormat === candidateSpec.sourceFormat ? 'native' : 'mixed'
  const baselineRecords = recordsForComparison(baselineSpec, comparisonMode)
  const candidateRecords = recordsForComparison(candidateSpec, comparisonMode)
  const baselineMap = new Map(
    baselineRecords.map((record) => [record.key, record] as const),
  )
  const candidateMap = new Map(
    candidateRecords.map((record) => [record.key, record] as const),
  )
  const entries: DiffEntry[] = []
  let unchanged = 0

  baselineRecords.forEach((beforeRecord) => {
    const afterRecord = candidateMap.get(beforeRecord.key)

    if (!afterRecord) {
      entries.push({
        id: beforeRecord.key,
        status: 'removed',
        type: beforeRecord.type,
        title: beforeRecord.title,
        path: beforeRecord.path,
        before: beforeRecord,
        changedFields: Object.keys(beforeRecord.fields),
      })
      return
    }

    const changedFields = getChangedFields(beforeRecord, afterRecord, comparisonMode)

    if (changedFields.length) {
      entries.push({
        id: beforeRecord.key,
        status: 'changed',
        type: afterRecord.type,
        title: afterRecord.title,
        path: afterRecord.path,
        before: beforeRecord,
        after: afterRecord,
        changedFields,
      })
    } else {
      unchanged += 1
    }
  })

  candidateRecords.forEach((afterRecord) => {
    if (baselineMap.has(afterRecord.key)) {
      return
    }

    entries.push({
      id: afterRecord.key,
      status: 'added',
      type: afterRecord.type,
      title: afterRecord.title,
      path: afterRecord.path,
      after: afterRecord,
      changedFields: Object.keys(afterRecord.fields),
    })
  })

  entries.sort((firstEntry, secondEntry) => {
    const firstOrder = firstEntry.after?.order ?? firstEntry.before?.order ?? 0
    const secondOrder = secondEntry.after?.order ?? secondEntry.before?.order ?? 0
    return firstOrder - secondOrder
  })

  const typeCounts: Partial<Record<RecordType, number>> = {}

  entries.forEach((entry) => {
    typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1
  })

  return {
    entries,
    added: entries.filter((entry) => entry.status === 'added').length,
    removed: entries.filter((entry) => entry.status === 'removed').length,
    changed: entries.filter((entry) => entry.status === 'changed').length,
    unchanged,
    total: entries.length + unchanged,
    typeCounts,
    comparisonMode,
    omittedRecordCount:
      comparisonMode === 'mixed'
        ? baselineSpec.records.length + candidateSpec.records.length - baselineRecords.length - candidateRecords.length
        : 0,
  }
}

function recordsForComparison(spec: ParsedSpec, comparisonMode: ComparisonMode) {
  if (comparisonMode === 'native') {
    return spec.records
  }

  const usedKeys = new Map<string, number>()
  const records: ComparableRecord[] = []

  spec.records.forEach((record) => {
    const mixedRecord = toMixedComparableRecord(record)

    if (!mixedRecord) {
      return
    }

    const usedCount = usedKeys.get(mixedRecord.key) ?? 0
    const uniqueKey = usedCount ? `${mixedRecord.key}#${usedCount + 1}` : mixedRecord.key
    usedKeys.set(mixedRecord.key, usedCount + 1)
    records.push({ ...mixedRecord, key: uniqueKey })
  })

  return records
}

function toMixedComparableRecord(record: ComparableRecord): ComparableRecord | null {
  if (!MIXED_COMPARABLE_TYPES.has(record.type)) {
    return null
  }

  if (record.type === 'metadata' && !isSpecificationIdentityRecord(record)) {
    return null
  }

  const fields = mixedComparableFields(record)

  if (!Object.keys(fields).length) {
    return null
  }

  return {
    ...record,
    key: mixedRecordKey(record, fields),
    title: mixedRecordTitle(record, fields),
    fields,
  }
}

function mixedComparableFields(record: ComparableRecord) {
  const fields = Object.fromEntries(
    Object.entries(record.fields)
      .map(([fieldName, value]) => {
        const canonicalFieldName = comparisonFieldName(record.type, fieldName)
        const canonicalValue = comparisonFieldValue(canonicalFieldName, value)
        return [canonicalFieldName, canonicalValue] as const
      })
      .filter(([, value]) => value.length > 0),
  )

  if (record.type === 'metadata') {
    return pickFields(fields, ['Name', 'Release date'])
  }

  if (record.type === 'revision') {
    return pickFields(fields, ['Version', 'Date', 'Change', 'Tool'])
  }

  if (record.type === 'block' || record.type === 'step' || record.type === 'case') {
    return omitFields(fields, [
      'Kind',
      'Number',
      'Details',
      'Service',
      'Parameter',
      'Target value',
      'PID',
      'IBNZ',
      'Variants',
    ])
  }

  return fields
}

function mixedRecordKey(record: ComparableRecord, fields: Record<string, string>) {
  switch (record.type) {
    case 'metadata':
      return recordKey('metadata', 'spec')
    case 'contact':
      return recordKey('contact', fields.Name || record.title)
    case 'revision':
      return recordKey('revision', fields.Version || record.title)
    case 'variant':
      return recordKey('variant', fields['Product ID'] || fields.Name || record.title)
    case 'objective':
      return recordKey('objective', fields.Objective || record.title)
    case 'diagnostic':
      return recordKey('diagnostic', fields['ECU ID'] || record.title, fields['Diagnostic protocol'] || '')
    case 'condition':
      return recordKey('condition', fields.Text || fields.Condition || fields.Objective || record.title)
    case 'mode':
      return recordKey('mode', fields.Name || fields.Text || record.title)
    case 'procedure':
      return recordKey('procedure', fields.Name || record.title)
    case 'case':
      return recordKey('case', procedureTitleForRecord(record), fields.Name || record.title)
    case 'block':
      return recordKey('block', procedureTitleForRecord(record), fields.Name || record.title)
    case 'step':
      return recordKey('step', procedureTitleForRecord(record), fields.Name || record.title)
    default:
      return record.key
  }
}

function mixedRecordTitle(record: ComparableRecord, fields: Record<string, string>) {
  return fields.Name || fields.Version || fields.Objective || fields.Text || record.title
}

function isSpecificationIdentityRecord(record: ComparableRecord) {
  return record.type === 'metadata' && record.title === 'Specification identity'
}

function comparisonFieldName(recordType: RecordType, fieldName: string) {
  const canonicalFieldName = MIXED_FIELD_ALIASES[normalizeHtmlHeading(fieldName)] ?? fieldName

  if (recordType === 'objective' && canonicalFieldName === 'Item') {
    return 'Objective'
  }

  if (recordType === 'condition' && canonicalFieldName === 'Objective') {
    return 'Text'
  }

  return canonicalFieldName
}

function comparisonFieldValue(fieldName: string, value: string) {
  let normalized = normalizeText(value)
    .replace(/^S-IBNB-Description:\s*/i, '')
    .replace(/\s*\n\s*/g, ' ')

  if (fieldName === 'ODXS') {
    return normalized.match(/\S+\.(?:ya?ml|odx|pdx|xml)/i)?.[0] ?? normalized
  }

  if (isMixedProseField(fieldName)) {
    normalized = normalized
      .replace(/([.!?;)])(?=[A-Z])/g, '$1 ')
      .replace(/([a-z])(?=[A-Z])/g, '$1 ')
      .replace(/\s+/g, ' ')
      .trim()
  }

  if (!MIXED_BOOLEAN_FIELDS.has(fieldName)) {
    return normalized
  }

  if (/^(x|true|yes|1)$/i.test(normalized)) {
    return 'true'
  }

  return ''
}

function isMixedProseField(fieldName: string) {
  return fieldName === 'Description' || fieldName === 'Objective' || fieldName === 'Text'
}

function procedureTitleForRecord(record: ComparableRecord) {
  const procedureIndex = record.path.findIndex(
    (pathPart) => normalizeIdentity(pathPart) === normalizeIdentity('Procedures'),
  )
  return procedureIndex >= 0 ? record.path[procedureIndex + 1] ?? '' : ''
}

function pickFields(fields: Record<string, string>, fieldNames: string[]) {
  return Object.fromEntries(
    fieldNames
      .map((fieldName) => [fieldName, fields[fieldName]] as const)
      .filter(([, value]) => value),
  )
}

function omitFields(fields: Record<string, string>, fieldNames: string[]) {
  const omittedFields = new Set(fieldNames)

  return Object.fromEntries(
    Object.entries(fields).filter(([fieldName]) => !omittedFields.has(fieldName)),
  )
}

function getChangedFields(
  beforeRecord: ComparableRecord,
  afterRecord: ComparableRecord,
  comparisonMode: ComparisonMode,
) {
  const fieldNames =
    comparisonMode === 'mixed'
      ? Object.keys(beforeRecord.fields).filter((fieldName) => fieldName in afterRecord.fields)
      : Array.from(
          new Set([
            ...Object.keys(beforeRecord.fields),
            ...Object.keys(afterRecord.fields),
          ]),
        )

  return fieldNames.filter(
    (fieldName) => beforeRecord.fields[fieldName] !== afterRecord.fields[fieldName],
  )
}

function filterDiffEntries(
  entries: DiffEntry[],
  statusFilter: StatusFilter,
  typeFilter: TypeFilter,
  searchQuery: string,
) {
  const normalizedSearch = searchQuery.trim().toLowerCase()

  return entries.filter((entry) => {
    if (statusFilter !== 'all' && entry.status !== statusFilter) {
      return false
    }

    if (typeFilter !== 'all' && entry.type !== typeFilter) {
      return false
    }

    if (!normalizedSearch) {
      return true
    }

    const searchableText = [
      entry.title,
      TYPE_LABELS[entry.type],
      STATUS_LABELS[entry.status],
      entry.path.join(' '),
      entry.changedFields.join(' '),
      ...Object.values(entry.before?.fields ?? {}),
      ...Object.values(entry.after?.fields ?? {}),
    ]
      .join(' ')
      .toLowerCase()

    return searchableText.includes(normalizedSearch)
  })
}

function describeSpec(spec: ParsedSpec) {
  return {
    fileName: spec.fileName,
    title: spec.title,
    version: spec.version,
    releaseDate: spec.releaseDate,
    recordCount: spec.recordCount,
    sourceFormat: spec.sourceFormat,
  }
}

function normalizeFields(fields: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(fields)
      .map(([fieldName, value]) => [fieldName, normalizeText(value)] as const)
      .filter(([, value]) => value.length > 0),
  )
}

function attributeFields(element: Element, labels: Record<string, string> = {}) {
  return Object.fromEntries(
    Array.from(element.attributes)
      .filter(
        (attribute) =>
          !IGNORED_ATTRIBUTES.has(attribute.name) &&
          !attribute.name.startsWith('xmlns') &&
          !attribute.name.includes('schemaLocation'),
      )
      .map((attribute) => [
        labels[attribute.name] ?? formatFieldName(attribute.name),
        attribute.value,
      ]),
  )
}

function serializeLinks(element: Element) {
  return childElements(child(element, 'LINKS'), 'LINK')
    .map((link) => {
      const name = textOf(link, 'NAME')
      const url = textOf(link, 'URL')
      return [name, url].filter(Boolean).join(': ')
    })
    .filter(Boolean)
    .join('\n')
}

function child(element: Element | null | undefined, tagName: string) {
  if (!element) {
    return null
  }

  return Array.from(element.children).find((candidate) => candidate.tagName === tagName) ?? null
}

function childElements(element: Element | null | undefined, tagName: string) {
  if (!element) {
    return []
  }

  return Array.from(element.children).filter(
    (candidate) => tagName === '*' || candidate.tagName === tagName,
  )
}

function textOf(element: Element | null | undefined, tagName: string) {
  return normalizeText(child(element, tagName)?.textContent ?? '')
}

function normalizePayload(value: string) {
  const normalized = normalizeText(value)

  if (!normalized) {
    return ''
  }

  try {
    return JSON.stringify(JSON.parse(normalized), null, 2)
  } catch {
    return normalized
  }
}

function normalizeText(value: string) {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function recordKey(...parts: string[]) {
  return parts.map((part) => normalizeIdentity(part)).join('/')
}

function normalizeIdentity(value: string) {
  return normalizeText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2010-\u2015]/g, '-')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '')
}

function formatFieldName(value: string) {
  const normalized = value.replace(/[-_]/g, ' ').toLowerCase()
  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function serializeHtmlDocument(htmlDocument: Document) {
  return `<!doctype html>\n${htmlDocument.documentElement.outerHTML}`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export default App
