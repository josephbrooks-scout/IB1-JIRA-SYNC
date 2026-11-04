import { useEffect, useMemo, useState } from 'react'
import type { JiraTicketPlan } from './ib1JiraPlan'
import { compareOffline, importJiraCsv, mergeSnapshots, nextExportJql, travellerIssues, type SnapshotIssue } from './offlineSnapshot.ts'
import { validateBaseline, type JiraBaseline } from './baseline.ts'

export function OfflineSnapshot({ plan }: { plan: JiraTicketPlan | null }) {
  const [issues, setIssues] = useState<SnapshotIssue[]>([])
  const [files, setFiles] = useState<string[]>([])
  const [ecuKey, setEcuKey] = useState('')
  const [ecuSearch, setEcuSearch] = useState('')
  const [error, setError] = useState('')
  const [loadedAt, setLoadedAt] = useState('')
  const [loading, setLoading] = useState(false)
  const [baseline, setBaseline] = useState<JiraBaseline | null>(null)
  const [baselineError, setBaselineError] = useState('')
  const [baselineLoading, setBaselineLoading] = useState(
    () => ['localhost', '127.0.0.1'].includes(window.location.hostname),
  )
  useEffect(() => {
    if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return
    const controller = new AbortController()
    void (async () => {
      try {
        const response = await fetch('/api/offline-baseline', { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(`Local baseline could not be loaded (${response.status}).`)
        const body: unknown = await response.json()
        if (typeof body !== 'object' || body === null || !('available' in body) || typeof body.available !== 'boolean') {
          throw new Error('Local baseline server returned an invalid response.')
        }
        if (body.available) {
          if (!('baseline' in body)) throw new Error('Local baseline data is missing.')
          const loaded = validateBaseline(body.baseline)
          if (!controller.signal.aborted) {
            setBaseline(loaded)
            setIssues(loaded.issues)
            setLoadedAt(new Date().toLocaleString())
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) setBaselineError(error instanceof Error ? error.message : 'Unable to load the local baseline.')
      } finally {
        if (!controller.signal.aborted) setBaselineLoading(false)
      }
    })()
    return () => controller.abort()
  }, [])
  const result = useMemo(() => {
    if (!issues.length) return null
    try {
      const scoped = travellerIssues(issues)
      let comparisons: ReturnType<typeof compareOffline> = []
      let comparisonError = ''
      try {
        comparisons = plan && ecuKey ? compareOffline(plan, issues, ecuKey) : []
      } catch (error) {
        comparisonError = error instanceof Error ? error.message : 'Unable to compare the selected ECU.'
      }
      return { scoped, jql: nextExportJql(issues), comparisons, comparisonError, error: '' }
    } catch (error) {
      return { scoped: [], jql: '', comparisons: [], comparisonError: '', error: error instanceof Error ? error.message : 'Unable to compare snapshot.' }
    }
  }, [issues, plan, ecuKey])
  const ecus = result?.scoped.filter(issue => issue.issueType === plan?.options.ecuIssueType) ?? []
  const searchTerms = ecuSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const filteredEcus = ecus.filter(issue =>
    searchTerms.every(term => `${issue.key} ${issue.summary}`.toLowerCase().includes(term)))
  const selectedEcu = ecus.find(issue => issue.key === ecuKey)
  const selectedOutsideSearch = selectedEcu && !filteredEcus.some(issue => issue.key === ecuKey)

  async function load(selected: FileList | null) {
    if (!selected?.length) return
    const selectedFiles = Array.from(selected)
    setLoading(true)
    setError('')
    try {
      const batches = await Promise.all(selectedFiles.map(async file => importJiraCsv(await file.text())))
      const merged = mergeSnapshots([issues, ...batches])
      travellerIssues(merged)
      setIssues(merged)
      setFiles(previous => [...previous, ...selectedFiles.map(file => file.name)])
      setLoadedAt(new Date().toLocaleString())
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to read Jira CSV.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <section className="offline-snapshot jira-account-guide" aria-label="Offline Jira comparison">
      {baselineLoading && <p role="status">Loading private local Jira baseline...</p>}
      {baselineError && <p role="alert">{baselineError} No baseline was loaded; CSV import remains available.</p>}
      {baseline && <div role="status">
        <strong>Baseline in use: {baseline.version}</strong>
        <p>Snapshot date: <time dateTime={baseline.snapshotDate}>{baseline.snapshotDate}</time> (user-supplied export date, not an IB1 version). Local only; not live Jira.</p>
        <p>{baseline.coverage}</p>
        {files.length > 0 && <p>Additional CSV overlays are active; this is no longer the baseline alone.</p>}
      </div>}
      <details>
        <summary>Compare with a Jira CSV export (offline)</summary>
        <p>Load authorized Jira CSV (all fields) exports. Files stay in this browser; nothing is sent to Jira. This is a snapshot, not live data or an approval report.</p>
        <label>
          Jira CSV exports
          <input type="file" accept=".csv,text/csv" multiple disabled={loading || baselineLoading} onChange={event => {
            void load(event.target.files)
            event.target.value = ''
          }} />
        </label>
        {result?.comparisonError && <p role="alert">{result.comparisonError}</p>}
        <button type="button" disabled={loading || baselineLoading} onClick={() => {
          setIssues(baseline?.issues ?? []); setFiles([]); setEcuKey(''); setEcuSearch(''); setError('')
          setLoadedAt(baseline ? new Date().toLocaleString() : '')
        }}>{baseline ? 'Reset to baseline' : 'Clear snapshot'}</button>
        {error && <p role="alert">{error} The previous snapshot, if any, is unchanged.</p>}
        {result?.error && <p role="alert">{result.error}</p>}
        {result && !result.error && (
          <>
            <p>{result.scoped.length} Traveller issues out of {issues.length} exported issues. Loaded locally {loadedAt}; export capture time is not verified.</p>
            <p>Files: {files.join(', ')}</p>
            <p>Coverage is unverified. Missing rows are never classified as confirmed additions or removals. CSVs do not include Jira sync properties.</p>
            <details>
              <summary>Export the next hierarchy levels</summary>
              <p>Run this JQL in Jira and export CSV (all fields). Add that CSV here alongside the first one. Repeat until no new keys appear; Jira permissions and export limits can still hide issues.</p>
              <textarea aria-label="Next hierarchy export JQL" readOnly value={result.jql} rows={5} />
            </details>
            {!plan && <p>Load an IB1 XML above to compare its proposed ticket content.</p>}
            {plan && (
              <>
                <label>Search snapshot ECUs
                  <input
                    type="search"
                    value={ecuSearch}
                    onChange={event => setEcuSearch(event.target.value)}
                    placeholder="Jira key, ECU name, or diagnostic identifier"
                    aria-describedby="snapshot-ecu-search-results"
                  />
                </label>
                <p id="snapshot-ecu-search-results" role="status">
                  {filteredEcus.length} of {ecus.length} ECUs match.
                  {filteredEcus.length === 0 && ' No matching ECUs. Clear or change your search.'}
                  {selectedOutsideSearch && ' Your current selection is retained below.'}
                </p>
                <label>Snapshot ECU (manually confirm it matches your XML)
                  <select value={ecuKey} onChange={event => setEcuKey(event.target.value)}>
                    <option value="">Select an exported ECU</option>
                    {selectedOutsideSearch && <option value={selectedEcu.key}>{selectedEcu.key} — {selectedEcu.summary} (selected; outside search)</option>}
                    {filteredEcus.map(issue =>
                      <option key={issue.key} value={issue.key}>{issue.key} — {issue.summary}</option>)}
                  </select>
                </label>
                <p>Matching uses parent relationships and an IB1 sync-key description footer when present. Summary-only matches are candidates, not verified identities. Formatting differences can produce content differences.</p>
                {result.comparisons.map(item => (
                  <details key={item.ticket.ibKey}>
                    <summary>{item.status}: {item.ticket.summary}</summary>
                    <div className="offline-content">
                      <div><h3>Exported Jira snapshot {item.match?.key}</h3>
                        <pre>{item.match ? `${item.match.summary}\n\n${item.match.description}` : 'No unique verified match. Export the remaining levels and confirm the ticket identity.'}</pre></div>
                      <div><h3>Incoming IB1 proposal</h3><pre>{item.ticket.summary}{'\n\n'}{item.incoming}</pre></div>
                    </div>
                  </details>
                ))}
              </>
            )}
            <p>No live write approvals can be exported from this view. Re-read Jira and complete the normal review before applying any changes.</p>
          </>
        )}
      </details>
    </section>
  )
}
