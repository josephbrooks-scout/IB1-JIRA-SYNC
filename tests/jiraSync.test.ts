import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { buildJiraTicketPlan, type JiraPlanOptions, type XmlNode } from '../src/jira/ib1JiraPlan.ts'
import {
  createJiraRestClient,
  type JiraApi,
  type JiraField,
  type JiraIssueProperty,
  type JiraIssueRef,
  type JiraTransition,
} from '../src/jira/jiraClient.ts'
import {
  applySync,
  compareVersions,
  DEFAULT_SYNC_OPTIONS,
  planSync,
  readJiraState,
  SPEC_CHANGED_LABEL,
  SYNC_PROPERTY,
  type SyncOptions,
  type SyncProperty,
} from '../src/jira/jiraSync.ts'

const fixture = readFileSync(new URL('./fixtures/ib1-jira-sample.xml', import.meta.url), 'utf8')

type FakeIssue = {
  key: string
  summary: string
  status: string
  issueType: string
  parent: string
  labels: string[]
  description: string
  fields: Record<string, unknown>
  properties: Record<string, unknown>
  comments: string[]
}

// In-memory Jira with the PRDFSI workflow: no way back to OPEN unless `reopenable` is set.
class FakeJira implements JiraApi {
  issues = new Map<string, FakeIssue>()
  writes = 0
  reopenable = true
  private nextId = 100

  add(issue: Partial<FakeIssue> & { key: string; summary: string }): FakeIssue {
    const full: FakeIssue = {
      status: 'Open',
      issueType: 'Sub-task',
      parent: '',
      labels: [],
      description: '',
      fields: {},
      properties: {},
      comments: [],
      ...issue,
    }

    this.issues.set(full.key, full)

    return full
  }

  children(parent: string) {
    return Array.from(this.issues.values()).filter((issue) => issue.parent === parent)
  }

  private ref(issue: FakeIssue, properties: string[]): JiraIssueRef {
    return {
      key: issue.key,
      fields: { summary: issue.summary, status: { name: issue.status }, labels: issue.labels },
      properties: Object.fromEntries(properties.filter((name) => name in issue.properties).map((name) => [name, issue.properties[name]])),
    }
  }

  async searchIssues(jql: string, properties: string[] = []) {
    const parent = /^parent = (\S+)/.exec(jql)?.[1]

    if (parent) {
      return this.children(parent).map((issue) => this.ref(issue, properties))
    }

    const diag = /"Diag Address" ~ "(\w+)"/.exec(jql)?.[1]

    return Array.from(this.issues.values())
      .filter((issue) => issue.issueType === 'Electronic Control Unit' && issue.fields['Diag Address'] === diag)
      .map((issue) => this.ref(issue, properties))
  }

  async getIssue(key: string, properties: string[] = []) {
    const issue = this.issues.get(key)

    return issue ? this.ref(issue, properties) : null
  }

  async createIssue(fields: Record<string, unknown>, properties: JiraIssueProperty[] = []) {
    this.writes += 1

    const key = `PRDFSI-${this.nextId++}`
    const custom = Object.fromEntries(Object.entries(fields).filter(([id]) => id.startsWith('customfield_')))

    this.add({
      key,
      summary: fields.summary as string,
      issueType: (fields.issuetype as { name: string }).name,
      parent: (fields.parent as { key: string } | undefined)?.key ?? '',
      labels: (fields.labels as string[]) ?? [],
      description: fields.description as string,
      fields: { 'Diag Address': custom.customfield_1 },
      properties: Object.fromEntries(properties.map((property) => [property.key, property.value])),
    })

    return key
  }

  async editIssue(key: string, fields: Record<string, unknown>, labelsToAdd: string[] = []) {
    this.writes += 1

    const issue = this.issues.get(key)!

    Object.assign(issue, fields)
    issue.labels = Array.from(new Set([...issue.labels, ...labelsToAdd]))
  }

  async setProperty(key: string, propertyKey: string, value: unknown) {
    this.writes += 1
    this.issues.get(key)!.properties[propertyKey] = value
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const issue = this.issues.get(key)!
    const transitions: JiraTransition[] = [
      { id: '91', name: 'Not Relevant', to: { name: 'NOT RELEVANT' } },
      { id: '92', name: 'Blocked', to: { name: 'BLOCKED' } },
    ]

    if (this.reopenable && issue.status !== 'Open') {
      transitions.push({ id: '11', name: 'Spec Changed', to: { name: 'OPEN' } })
    }

    return transitions
  }

  async transitionIssue(key: string, transitionId: string) {
    this.writes += 1

    const names: Record<string, string> = { '91': 'NOT RELEVANT', '92': 'BLOCKED', '11': 'OPEN' }

    this.issues.get(key)!.status = names[transitionId]
  }

  async addComment(key: string, body: string) {
    this.writes += 1
    this.issues.get(key)!.comments.push(body)
  }

  async getFields(): Promise<JiraField[]> {
    return [
      { id: 'customfield_1', name: 'Diag Address' },
      { id: 'customfield_2', name: 'Diagnostic Address' },
    ]
  }
}

function makePlan(xml = fixture, options: Partial<JiraPlanOptions> = {}) {
  return buildJiraTicketPlan(
    new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlNode,
    'sample.xml',
    options,
  )
}

const withVersion = (xml: string, version: string) => xml.replace('<IB-1 id="doc-1" version="2.0">', `<IB-1 id="doc-1" version="${version}">`)

async function sync(jira: FakeJira, xml = fixture, syncOptions: Partial<SyncOptions> = {}, planOptions: Partial<JiraPlanOptions> = {}) {
  const options = { ...DEFAULT_SYNC_OPTIONS, ...syncOptions }
  const plan = makePlan(xml, planOptions)
  const syncPlan = planSync(plan, await readJiraState(jira, plan, options), options)
  const result = await applySync(jira, syncPlan, options, () => new Date('2026-10-30T12:00:00Z'))

  return { syncPlan, result }
}

const typesOf = (actions: Array<{ type: string; held?: string }>) =>
  actions.reduce<Record<string, number>>((counts, action) => {
    const name = action.held ? `${action.type} (held)` : action.type

    counts[name] = (counts[name] ?? 0) + 1

    return counts
  }, {})

let jira: FakeJira

beforeEach(() => {
  jira = new FakeJira()
})

describe('IB1 → Jira sync', () => {
  it('blocks when no ECU ticket exists, without writing anything', async () => {
    const { syncPlan, result } = await sync(jira)

    expect(syncPlan.blockers[0]).toMatch(/No ECU ticket found for ECU 0099/)
    expect(result.status).toBe('blocked')
    expect(jira.writes).toBe(0)
  })

  it('creates the ECU ticket and all children with sync properties when allowed', async () => {
    jira.add({ key: 'PRDFSI-35', summary: 'Traveller', issueType: 'Initiative' })
    const { result } = await sync(jira, fixture, { createEcu: true, vehicleKey: 'PRDFSI-35' })
    const ecu = jira.issues.get(result.ecuKey!)!

    expect(result.status).toBe('applied')
    expect(ecu).toMatchObject({ issueType: 'Electronic Control Unit', parent: 'PRDFSI-35', summary: '0099_Test_ECU' })
    expect(ecu.fields['Diag Address']).toBe('0099')
    expect(jira.children(ecu.key)).toHaveLength(7)
    expect(jira.children(ecu.key)[1].properties[SYNC_PROPERTY]).toMatchObject({
      key: 'ib1:0099:step-reset',
      ibVersion: '2.0',
      ibName: '0099_Test_ECU',
    })
    expect(ecu.comments.at(-1)).toContain('7 created')
  })

  it('blocks a mistyped --vehicle before writing anything', async () => {
    const { syncPlan, result } = await sync(jira, fixture, { createEcu: true, vehicleKey: 'TEST-KEY' })

    expect(syncPlan.blockers.join()).toMatch(/Vehicle ticket TEST-KEY \(--vehicle\) was not found/)
    expect(result.status).toBe('blocked')
    expect(jira.writes).toBe(0)
  })

  it('keeps a tool-created ECU description current, but never edits a hand-made ECU ticket', async () => {
    const { result } = await sync(jira, fixture, { createEcu: true })
    const ecu = jira.issues.get(result.ecuKey!)!

    expect((await sync(jira)).syncPlan.actions.some((action) => action.type === 'update-ecu')).toBe(false)

    const { syncPlan } = await sync(jira, withVersion(fixture, '2.1'))

    expect(typesOf(syncPlan.actions)).toEqual({ 'update-ecu': 1, refresh: 7 })
    expect(ecu.description).toContain('2.1')
    expect((ecu.properties[SYNC_PROPERTY] as SyncProperty).ibVersion).toBe('2.1')
    expect(ecu.comments).toHaveLength(1)

    const manual = jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', description: 'hand-made' })

    await sync(jira, withVersion(fixture, '2.2'), { parentKey: 'PRDFSI-150' })
    expect(manual.description).toBe('hand-made')
  })

  it('finds the existing ECU by Diag Address and is idempotent on re-run', async () => {
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    await sync(jira)

    const writesAfterFirstRun = jira.writes
    const { syncPlan, result } = await sync(jira)

    expect(typesOf(syncPlan.actions)).toEqual({ unchanged: 7 })
    expect(result.outcomes).toEqual([])
    expect(jira.writes).toBe(writesAfterFirstRun)
  })

  it('updates and reopens only changed tickets on a new version; others get a quiet version refresh', async () => {
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    await sync(jira)

    const resetTicket = jira.children('PRDFSI-150').find((issue) => issue.summary.includes('ECU Reset [1101]'))!

    resetTicket.status = 'TESTING COMPLETE'

    const changed = withVersion(fixture, '2.1').replace('<DESC>Hard reset</DESC>', '<DESC>Hard reset, wait for DoIP</DESC>')
    const { syncPlan, result } = await sync(jira, changed, { parentKey: 'PRDFSI-150' })

    expect(typesOf(syncPlan.actions)).toEqual({ update: 1, refresh: 6 })
    expect(result.status).toBe('applied')
    expect(resetTicket.status).toBe('OPEN')
    expect(resetTicket.description).toContain('wait for DoIP')
    expect(resetTicket.comments[0]).toContain('IB1 spec changed in *0099_Test_ECU v2.1*')
    expect((resetTicket.properties[SYNC_PROPERTY] as SyncProperty).ibVersion).toBe('2.1')
    expect(jira.children('PRDFSI-150').every((issue) => (issue.properties[SYNC_PROPERTY] as SyncProperty).ibVersion === '2.1')).toBe(true)
  })

  it('labels the ticket when the workflow has no transition back to OPEN', async () => {
    jira.reopenable = false
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    await sync(jira)

    const resetTicket = jira.children('PRDFSI-150').find((issue) => issue.summary.includes('ECU Reset [1101]'))!

    resetTicket.status = 'ACCEPTANCE'

    const { result } = await sync(jira, withVersion(fixture, '2.1').replace('Hard reset', 'Soft reset'))

    expect(resetTicket.status).toBe('ACCEPTANCE')
    expect(resetTicket.labels).toContain(SPEC_CHANGED_LABEL)
    expect(result.outcomes.find((outcome) => outcome.type === 'update')?.detail).toMatch(/no transition/)
  })

  it('holds removals for review, and moves them to NOT RELEVANT only when allowed', async () => {
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    await sync(jira)

    const withoutCoding = withVersion(fixture, '2.1').replace(/<SWITCH>[\s\S]*<\/SWITCH>/, '')
    const held = await sync(jira, withoutCoding)
    const codingTicket = jira.children('PRDFSI-150').find((issue) => issue.summary.includes('write coding'))!

    expect(typesOf(held.syncPlan.actions)).toMatchObject({ 'remove (held)': 1 })
    expect(held.result.status).toBe('partial')
    expect(codingTicket.status).toBe('Open')

    const allowed = await sync(jira, withoutCoding, { allowRemovals: true })

    expect(allowed.result.status).toBe('applied')
    expect(codingTicket.status).toBe('NOT RELEVANT')
    expect((codingTicket.properties[SYNC_PROPERTY] as SyncProperty).removedIn).toBe('2.1')

    const { syncPlan } = await sync(jira, withVersion(fixture, '2.2'))

    expect(syncPlan.actions.find((action) => action.issueKey === codingTicket.key)).toMatchObject({ type: 'update' })
  })

  it('does not duplicate hand-made tickets: holds them, or links them with --adopt', async () => {
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    const manual = jira.add({ key: 'PRDFSI-191', summary: 'button_worker_check', parent: 'PRDFSI-150', status: 'TESTING COMPLETE' })

    const stepMode = await sync(jira)

    expect(stepMode.syncPlan.blockers.join()).toMatch(/look like IB1 blocks\/steps.*--granularity block/)
    expect(jira.writes).toBe(0)

    const blockHeld = await sync(jira, fixture, {}, { granularity: 'block' })

    expect(typesOf(blockHeld.syncPlan.actions)).toEqual({ create: 3, 'create (held)': 1 })
    expect(jira.children('PRDFSI-150')).toHaveLength(4)

    const adopted = await sync(jira, fixture, { adopt: true }, { granularity: 'block' })

    expect(typesOf(adopted.syncPlan.actions)).toEqual({ unchanged: 3, adopt: 1 })
    expect(manual.status).toBe('TESTING COMPLETE')
    expect(manual.summary).toBe('button_worker_check')
    expect((manual.properties[SYNC_PROPERTY] as SyncProperty).key).toBe('ib1:0099:block-loop')
  })

  it('blocks ambiguous ECUs, older versions, risky plans and mass updates', async () => {
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    jira.add({ key: 'PRDFSI-151', summary: 'ECU copy', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    expect((await sync(jira)).syncPlan.blockers.join()).toMatch(/Several ECU tickets.*PRDFSI-150, PRDFSI-151/)

    jira.issues.delete('PRDFSI-151')
    await sync(jira, withVersion(fixture, '3.0'))
    expect((await sync(jira, withVersion(fixture, '2.9'))).syncPlan.blockers.join()).toMatch(/this file is older/)

    const missingIds = fixture.replace('<STEP id="step-code">', '<STEP>')

    expect((await sync(jira, withVersion(missingIds, '3.1'))).syncPlan.blockers.join()).toMatch(/no id attribute/)

    const everythingChanged = withVersion(fixture, '3.2').replace(/<NAME>(?!0099_Test_ECU)/g, '<NAME>New ')
    const mass = await sync(jira, everythingChanged, { maxUpdates: 2, ignoreUnmanaged: true })

    expect(mass.syncPlan.blockers.join()).toMatch(/above the limit of 2/)
    expect(mass.result.status).toBe('blocked')
  })

  it('leaves tickets from other IB1 documents for the same ECU untouched', async () => {
    jira.add({ key: 'PRDFSI-150', summary: 'ECU', issueType: 'Electronic Control Unit', fields: { 'Diag Address': '0099' } })
    jira.add({
      key: 'PRDFSI-300',
      summary: 'other doc step',
      parent: 'PRDFSI-150',
      properties: {
        [SYNC_PROPERTY]: { key: 'ib1:0099:step-reset', hash: 'x', ibName: '0099_Other_Doc', ibVersion: '9', ecuId: '0099', syncedAt: '' },
      },
    })

    const { syncPlan } = await sync(jira)

    expect(syncPlan.notes.join()).toMatch(/another IB1 document \("0099_Other_Doc"\)/)
    expect(typesOf(syncPlan.actions)).toEqual({ create: 7 })
  })

  it('compares versions numerically', () => {
    expect(compareVersions('9.10', '9.9')).toBe(1)
    expect(compareVersions('1.0', '1')).toBe(0)
    expect(compareVersions('2.0', '10.0')).toBe(-1)
  })
})

describe('Jira REST client', () => {
  it('authenticates, paginates search results and retries on rate limiting', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const responses = [
      new Response('', { status: 429, headers: { 'Retry-After': '0.001' } }),
      Response.json({ issues: [{ key: 'A-1', fields: {} }], nextPageToken: 'next' }),
      Response.json({ issues: [{ key: 'A-2', fields: {} }] }),
    ]
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })

      return responses.shift()!
    }) as unknown as typeof fetch
    const client = createJiraRestClient({ baseUrl: 'https://x.atlassian.net/', email: 'a@b.c', apiToken: 't' }, fakeFetch)

    const issues = await client.searchIssues('parent = A-0', [SYNC_PROPERTY])

    expect(issues.map((issue) => issue.key)).toEqual(['A-1', 'A-2'])
    expect(calls).toHaveLength(3)
    expect(calls[0].url).toBe('https://x.atlassian.net/rest/api/3/search/jql')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${btoa('a@b.c:t')}`)
    expect(JSON.parse(calls[2].init.body as string)).toMatchObject({ nextPageToken: 'next', properties: [SYNC_PROPERTY] })
  })

  it('returns null for missing issues and reports Jira error messages', async () => {
    const fakeFetch = (async (url: string) =>
      url.includes('/issue/MISSING')
        ? Response.json({ errorMessages: ['Issue does not exist'] }, { status: 404 })
        : Response.json({ errors: { summary: 'Field required' } }, { status: 400 })) as unknown as typeof fetch
    const client = createJiraRestClient({ baseUrl: 'https://x', email: 'e', apiToken: 't' }, fakeFetch)

    expect(await client.getIssue('MISSING')).toBeNull()
    await expect(client.createIssue({})).rejects.toThrow(/400.*summary: Field required/)
  })
})
