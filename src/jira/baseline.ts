import type { SnapshotIssue } from './offlineSnapshot.ts'

export type JiraBaseline = {
  version: string
  snapshotDate: string
  coverage: string
  issues: SnapshotIssue[]
}

export function validateBaseline(value: unknown): JiraBaseline {
  if (typeof value !== 'object' || value === null
    || !('version' in value) || typeof value.version !== 'string' || !value.version.trim()
    || !('snapshotDate' in value) || typeof value.snapshotDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/.test(value.snapshotDate)
    || !Number.isFinite(Date.parse(`${value.snapshotDate}T00:00:00Z`))
    || new Date(`${value.snapshotDate}T00:00:00Z`).toISOString().slice(0, 10) !== value.snapshotDate
    || !('coverage' in value) || typeof value.coverage !== 'string' || !value.coverage.trim()
    || !('issues' in value) || !Array.isArray(value.issues)) {
    throw new Error('Invalid local baseline metadata.')
  }
  const keys = new Set<string>()
  const issues: SnapshotIssue[] = value.issues.map((issue: unknown) => {
    if (typeof issue !== 'object' || issue === null) throw new Error('Invalid local baseline issue.')
    const get = (key: string) => {
      if (!(key in issue)) throw new Error(`Missing baseline issue field: ${key}`)
      const field = Reflect.get(issue, key)
      if (typeof field !== 'string') throw new Error(`Invalid baseline issue field: ${key}`)
      return field
    }
    const key = get('key')
    const parentKey = get('parentKey')
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || keys.has(key)
      || (parentKey && !/^[A-Z][A-Z0-9_]*-\d+$/.test(parentKey))) throw new Error('Invalid or duplicate baseline issue key.')
    keys.add(key)
    if (!('labels' in issue) || !Array.isArray(issue.labels) || !issue.labels.every(label => typeof label === 'string')) {
      throw new Error('Invalid baseline labels.')
    }
    return {
      key, parentKey, id: get('id'), summary: get('summary'), description: get('description'),
      issueType: get('issueType'), status: get('status'), labels: issue.labels,
    }
  })
  if (!keys.has('PRDFSI-35')) throw new Error('Local baseline must contain PRDFSI-35.')
  return { version: value.version, snapshotDate: value.snapshotDate, coverage: value.coverage, issues }
}
