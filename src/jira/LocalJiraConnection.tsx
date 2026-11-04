import { useState } from 'react'
import type { JiraIssueRef } from './jiraClient'

type Hierarchy = { rootKey: string; issues: JiraIssueRef[]; fetchedAt: string }

async function localRequest(path: string, method = 'GET'): Promise<unknown> {
  const response = await fetch(path, { method, credentials: 'same-origin', cache: 'no-store' })
  const body: unknown = await response.json()
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string'
      ? body.error : `Local Jira request failed (${response.status}).`
    throw new Error(message)
  }
  return body
}

function isHierarchy(value: unknown): value is Hierarchy {
  return typeof value === 'object' && value !== null && 'rootKey' in value && value.rootKey === 'PRDFSI-35'
    && 'fetchedAt' in value && typeof value.fetchedAt === 'string'
    && 'issues' in value && Array.isArray(value.issues) && value.issues.every((issue: unknown) =>
      typeof issue === 'object' && issue !== null && 'key' in issue && typeof issue.key === 'string'
      && 'fields' in issue && typeof issue.fields === 'object' && issue.fields !== null)
}

export function LocalJiraConnection() {
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const local = window.location.origin === 'http://localhost:5184'
  if (!local) return null

  async function load() {
    setBusy(true)
    setError('')
    setNotice('')
    setHierarchy(null)
    try {
      const result = await localRequest('/api/jira/hierarchy')
      if (!isHierarchy(result)) throw new Error('The local backend returned an invalid hierarchy.')
      setHierarchy(result)
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to load the Jira hierarchy.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setError('')
    try {
      await localRequest('/api/jira/logout', 'POST')
      setHierarchy(null)
      setNotice('Disconnected. The local server discarded your session token.')
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Unable to disconnect from Jira.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="local-jira-connection" aria-label="Local Jira connection">
      <h2>Live Jira — local read-only prototype</h2>
      <p>Connect your own Scout Jira account to read Traveller PRDFSI-35 and its descendants. This does not yet compare an XML or generate approvals. No Jira writes are available.</p>
      <p>
        <a href="/auth/login">Connect Jira</a>{' · '}
        <button type="button" onClick={() => void load()} disabled={busy}>{busy ? 'Please wait…' : 'Load / refresh PRDFSI-35'}</button>{' '}
        <button type="button" onClick={() => void disconnect()} disabled={busy}>Disconnect</button>
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {hierarchy && (
        <details open>
          <summary>{hierarchy.issues.length} accessible issues — fetched {new Date(hierarchy.fetchedAt).toLocaleString()}</summary>
          <p>Only issues visible to your Jira account are included. Parent links show the hierarchy returned by Jira.</p>
          <ul>
            {hierarchy.issues.map(issue => (
              <li key={issue.key}>
                <a href={`https://scoutmotors.atlassian.net/browse/${encodeURIComponent(issue.key)}`} target="_blank" rel="noreferrer">{issue.key}</a>
                {' — '}{issue.fields.summary} ({issue.fields.issuetype?.name}; {issue.fields.status?.name})
                {issue.fields.parent && <> — parent: {issue.fields.parent.key}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
