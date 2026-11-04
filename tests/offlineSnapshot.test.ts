import { readFileSync } from 'node:fs'
import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { buildJiraTicketPlan, type XmlNode } from '../src/jira/ib1JiraPlan.ts'
import { ticketWikiDescription } from '../src/jira/exporters.ts'
import { compareOffline, importJiraCsv, mergeSnapshots, nextExportJql, parseCsv, travellerIssues, type SnapshotIssue } from '../src/jira/offlineSnapshot.ts'

const root: SnapshotIssue = { key: 'PRDFSI-35', id: '1', parentKey: '', summary: 'Traveller', description: '', labels: [], issueType: 'Initiative', status: 'To Do' }
const ecu: SnapshotIssue = { ...root, key: 'PRDFSI-90', id: '2', parentKey: root.key, issueType: 'Electronic Control Unit' }
const fixture = readFileSync(new URL('./fixtures/ib1-jira-sample.xml', import.meta.url), 'utf8')
const plan = buildJiraTicketPlan(new DOMParser().parseFromString(fixture, 'text/xml') as unknown as XmlNode, 'test.xml')

describe('offline Jira CSV snapshots', () => {
  it('handles BOM, duplicate labels, commas, multiline descriptions, escaped quotes and trailing empty cells', () => {
    const csv = '\uFEFFIssue key,Issue id,Summary,Description,Issue Type,Status,Parent key,Labels,Labels\r\nPRDFSI-35,1,"Traveller, test","line 1\n""quoted""",Initiative,To Do,,ib1,\r\n'
    expect(importJiraCsv(csv)).toEqual([{ ...root, summary: 'Traveller, test', description: 'line 1\n"quoted"', labels: ['ib1'] }])
    expect(parseCsv('a,b\n"x",')).toEqual([['a', 'b'], ['x', '']])
  })

  it('rejects malformed or incomplete exports explicitly', () => {
    expect(() => parseCsv('a\n"unfinished')).toThrow('quoted field')
    expect(() => parseCsv('a\n"x"junk')).toThrow('quoting')
    expect(() => importJiraCsv('Summary,Issue key\nx,PRDFSI-35')).toThrow('issue id')
    const csv = 'Issue key,Issue id,Summary,Description,Issue Type,Status,Parent key\n'
    expect(() => importJiraCsv(csv + 'PRDFSI-35,1,x,,Initiative,To Do')).toThrow('columns')
    expect(() => importJiraCsv(csv + 'bad,1,x,,Initiative,To Do,')).toThrow('invalid')
    expect(() => importJiraCsv(csv + 'PRDFSI-35,1,x,,Initiative,To Do,\nPRDFSI-35,1,x,,Initiative,To Do,')).toThrow('Duplicate')
  })

  it('merges identical records but rejects conflicting captures', () => {
    expect(mergeSnapshots([[root], [root, ecu]])).toEqual([root, ecu])
    expect(() => mergeSnapshots([[root], [{ ...root, summary: 'Changed' }]])).toThrow('Exports disagree')
  })

  it('scopes to Traveller using parent keys and generates the next-level query', () => {
    const unrelated = { ...ecu, key: 'PRDFSI-999', parentKey: 'PRDFSI-1' }
    expect(travellerIssues([ecu, unrelated, root])).toEqual([ecu, root])
    expect(nextExportJql([root, ecu])).toBe('project = PRDFSI AND parent in (PRDFSI-35, PRDFSI-90) ORDER BY key')
    expect(() => travellerIssues([ecu])).toThrow('root ticket')
  })

  it('never classifies missing blocks as confirmed additions or removals', () => {
    const result = compareOffline(plan, [root, ecu], ecu.key)
    expect(result).toHaveLength(plan.tickets.length)
    expect(result.every(row => row.status === 'Not found in snapshot - coverage unknown')).toBe(true)
    expect(() => compareOffline(plan, [root, ecu], 'PRDFSI-999')).toThrow('Select')
  })

  it('matches stable footer identity under the correct parent and compares content', () => {
    const block = plan.tickets.find(ticket => ticket.kind === 'block' && plan.tickets.some(child => child.parentIbKey === ticket.ibKey))!
    const step = plan.tickets.find(ticket => ticket.parentIbKey === block.ibKey)!
    const blockIssue = { ...ecu, key: 'PRDFSI-100', parentKey: ecu.key, issueType: block.issueType, summary: block.summary, description: ticketWikiDescription(block) }
    const stepIssue = { ...ecu, key: 'PRDFSI-101', parentKey: blockIssue.key, issueType: step.issueType, summary: 'Old name', description: ticketWikiDescription(step) }
    const result = compareOffline(plan, [root, ecu, blockIssue, stepIssue], ecu.key)
    expect(result.find(row => row.ticket.ibKey === block.ibKey)?.status).toBe('Exact snapshot match')
    expect(result.find(row => row.ticket.ibKey === step.ibKey)?.status).toBe('Content differs - review')
    const candidate = compareOffline(plan, [root, ecu, { ...blockIssue, description: '' }, stepIssue], ecu.key)
    expect(candidate.find(row => row.ticket.ibKey === block.ibKey)?.status).toBe('Candidate match - confirm identity')
    expect(candidate.find(row => row.ticket.ibKey === step.ibKey)?.match).toBeUndefined()
    const ambiguous = compareOffline(plan, [root, ecu, blockIssue, { ...blockIssue, key: 'PRDFSI-102' }], ecu.key)
    expect(ambiguous.find(row => row.ticket.ibKey === block.ibKey)?.status).toBe('Ambiguous match')
  })
})
