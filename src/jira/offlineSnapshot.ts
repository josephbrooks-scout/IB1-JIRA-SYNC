import type { JiraTicketPlan } from './ib1JiraPlan.ts'
import { ticketWikiDescription } from './exporters.ts'

export type SnapshotIssue = {
  key: string
  id: string
  summary: string
  description: string
  issueType: string
  status: string
  parentKey: string
  labels: string[]
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let closed = false
  const source = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { cell += '"'; i++ }
        else { quoted = false; closed = true }
      } else cell += c
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell)
      cell = ''
      closed = false
      if (c !== ',') {
        if (c === '\r' && source[i + 1] === '\n') i++
        if (row.some(value => value !== '')) rows.push(row)
        row = []
      }
    } else if (c === '"' && cell === '' && !closed) {
      quoted = true
    } else {
      if (closed || c === '"') throw new Error('Invalid CSV quoting. Export CSV (all fields) directly from Jira.')
      cell += c
    }
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.')
  if (cell || row.length || closed) { row.push(cell); rows.push(row) }
  return rows
}

export function importJiraCsv(text: string): SnapshotIssue[] {
  const [header, ...rows] = parseCsv(text)
  if (!header || !rows.length) throw new Error('The CSV has no issue rows.')
  const normalized = header.map(name => name.trim().toLowerCase())
  for (const required of ['issue key', 'issue id', 'summary', 'description', 'issue type', 'status', 'parent key']) {
    if (normalized.filter(name => name === required).length !== 1) {
      throw new Error(`CSV requires exactly one "${required}" column. Use Jira CSV (all fields).`)
    }
  }
  const keys = new Set<string>()
  return rows.map((row, index) => {
    if (row.length !== header.length) throw new Error(`CSV row ${index + 2} has an unexpected number of columns.`)
    const get = (name: string) => row[normalized.indexOf(name)].trim()
    const key = get('issue key')
    const parentKey = get('parent key')
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || (parentKey && !/^[A-Z][A-Z0-9_]*-\d+$/.test(parentKey))) {
      throw new Error(`CSV row ${index + 2} has an invalid issue or parent key.`)
    }
    if (keys.has(key)) throw new Error(`Duplicate issue key ${key} in CSV.`)
    keys.add(key)
    return {
      key, parentKey, id: get('issue id'), summary: get('summary'),
      description: row[normalized.indexOf('description')],
      issueType: get('issue type'), status: get('status'),
      labels: normalized.flatMap((name, i) => name === 'labels' && row[i].trim() ? [row[i].trim()] : []),
    }
  })
}

export function mergeSnapshots(batches: SnapshotIssue[][]): SnapshotIssue[] {
  const issues = new Map<string, SnapshotIssue>()
  for (const batch of batches) {
    for (const issue of batch) {
      const previous = issues.get(issue.key)
      if (previous && JSON.stringify(previous) !== JSON.stringify(issue)) {
        throw new Error(`Exports disagree about ${issue.key}. Use fresh exports from the same capture instead of silently overwriting a snapshot.`)
      }
      issues.set(issue.key, issue)
    }
  }
  return [...issues.values()]
}

export function travellerIssues(issues: SnapshotIssue[]): SnapshotIssue[] {
  if (!issues.some(issue => issue.key === 'PRDFSI-35')) throw new Error('Include the PRDFSI-35 root ticket in your exports.')
  const included = new Set(['PRDFSI-35'])
  let changed = true
  while (changed) {
    changed = false
    for (const issue of issues) {
      if (!included.has(issue.key) && included.has(issue.parentKey)) {
        included.add(issue.key)
        changed = true
      }
    }
  }
  return issues.filter(issue => included.has(issue.key))
}

export function nextExportJql(issues: SnapshotIssue[]): string {
  const keys = travellerIssues(issues).map(issue => issue.key).sort()
  return `project = PRDFSI AND parent in (${keys.join(', ')}) ORDER BY key`
}

export function compareOffline(plan: JiraTicketPlan, issues: SnapshotIssue[], ecuKey: string) {
  const scoped = travellerIssues(issues)
  const ecu = scoped.find(issue => issue.key === ecuKey && issue.issueType === plan.options.ecuIssueType)
  if (!ecu) throw new Error('Select an exported Traveller ECU before comparing.')
  if (plan.ecu.existingIssueKey && plan.ecu.existingIssueKey !== ecuKey) {
    throw new Error('The selected snapshot ECU differs from the Existing ECU ticket in the XML preview.')
  }
  const matches = new Map<string, string>()
  return plan.tickets.map(ticket => {
    const parentKey = ticket.parentIbKey ? matches.get(ticket.parentIbKey) : ecu.key
    const children = parentKey ? scoped.filter(issue => issue.parentKey === parentKey) : []
    const identity = children.filter(issue => {
      const footer = /Sync key:_\s*\{\{([^}\r\n]+)\}\}/.exec(issue.description)
      return footer?.[1] === ticket.ibKey
    })
    const candidates = identity.length ? identity : children.filter(issue =>
      issue.summary === ticket.summary && issue.issueType === ticket.issueType)
    const match = candidates.length === 1 ? candidates[0] : undefined
    const stable = identity.length === 1 && match?.issueType === ticket.issueType
    if (stable && match) matches.set(ticket.ibKey, match.key)
    const incoming = ticketWikiDescription(ticket)
    return {
      ticket, match, incoming,
      status: candidates.length > 1 ? 'Ambiguous match'
        : match && !stable ? 'Candidate match - confirm identity'
        : match ? (match.summary === ticket.summary && match.description === incoming ? 'Exact snapshot match' : 'Content differs - review')
        : 'Not found in snapshot - coverage unknown',
    }
  })
}
