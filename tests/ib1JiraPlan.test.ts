import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DOMParser } from '@xmldom/xmldom'
import { buildJiraTicketPlan, type XmlNode } from '../src/jira/ib1JiraPlan.ts'
import { escapeWiki, ticketWikiDescription, toJiraCsv, toPlanJson } from '../src/jira/exporters.ts'

const fixture = readFileSync(new URL('./fixtures/ib1-jira-sample.xml', import.meta.url), 'utf8')

function parse(xml: string): XmlNode {
  return new DOMParser().parseFromString(xml, 'text/xml') as unknown as XmlNode
}

function plan(options = {}) {
  return buildJiraTicketPlan(parse(fixture), 'ib1-jira-sample.xml', options)
}

describe('buildJiraTicketPlan', () => {
  it('reads document and ECU metadata', () => {
    const result = plan()

    expect(result.source).toMatchObject({ ibName: '0099_Test_ECU', version: '2.0', releaseDate: '2026-01-15' })
    expect(result.ecu.ecuId).toBe('0099')
    expect(result.ecu.fields['Diagnostic Address']).toBe('0x0099')
    expect(result.ecu.slaves).toEqual([{ name: 'Test Sensor', ecuId: '00A1' }])
    expect(result.ecu.lookupJql).toBe(
      'project = PRDFSI AND issuetype = "Electronic Control Unit" AND "Diag Address" ~ "0099"',
    )
  })

  it('creates one ticket per step and a single ticket for blocks without steps', () => {
    const result = plan()

    expect(result.stats).toMatchObject({ procedures: 1, blocks: 4, standardBlocks: 1, blocksWithSteps: 3, steps: 6 })
    expect(result.tickets.map((ticket) => ticket.summary)).toEqual([
      'SFD unlock',
      '[ECU Reset] ECU Reset [1101]',
      '[ECU Reset] Wartezeit',
      '[button_worker_check] Press button',
      '[button_worker_check] read_data: Button [0x1841]',
      '[button_worker_check] read_data: Button [0x1841] (2)',
      '[coding (LHD)] write coding',
    ])
    expect(result.warnings.some((warning) => warning.includes('repeated'))).toBe(true)
  })

  it('uses ECU-scoped UUID sync keys', () => {
    const keys = plan().tickets.map((ticket) => ticket.ibKey)

    expect(keys[0]).toBe('ib1:0099:block-std')
    expect(keys[1]).toBe('ib1:0099:step-reset')
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('folds loops into step context and branches into notes, not tickets', () => {
    const result = plan()
    const loopStep = result.tickets.find((ticket) => ticket.sourceId === 'step-read')!

    expect(loopStep.fields['Runs inside']).toBe('Request result (poll 100 ms, timeout 5000 ms)')
    expect(loopStep.fields.Action).toBe('REST POST /api/v1/tasks/buds/read_data')
    expect(result.tickets.some((ticket) => ticket.sourceId === 'hmi-abort')).toBe(false)

    const notes = loopStep.sections.find((section) => section.title === 'Conditional handling')

    expect(notes).toMatchObject({ kind: 'list' })
    expect(JSON.stringify(notes)).toContain('Abort button actuated')
  })

  it('resolves VALUE-REF wait times and describes UDS services', () => {
    const result = plan()
    const reset = result.tickets.find((ticket) => ticket.sourceId === 'step-reset')!
    const wait = result.tickets.find((ticket) => ticket.sourceId === 'step-wait')!

    expect(reset.fields.Action).toBe('UDS 0x11 ECU Reset')
    expect(reset.labels).toEqual(['ib1', 'ecu-0099', 'optional', 'ib1-step'])
    expect(JSON.stringify(wait.sections)).toContain('2500 (block parameter \\"wait_after_reset\\")')
  })

  it('labels HMI steps and standard blocks', () => {
    const result = plan({ extraLabels: ['Mule', 'VFF'] })

    expect(result.tickets[0].labels).toEqual(['ib1', 'ecu-0099', 'standard-block', 'Mule', 'VFF', 'ib1-block'])
    expect(result.tickets[3]).toMatchObject({ kind: 'hmi-step' })
    expect(result.tickets[3].labels).toContain('hmi')
    expect(result.tickets[3].fields.Action).toBe('HMI: Press the window button')
  })

  it('supports one ticket per block', () => {
    const result = plan({ granularity: 'block' })

    expect(result.tickets.map((ticket) => ticket.summary)).toEqual([
      'SFD unlock',
      'ECU Reset',
      'button_worker_check',
      'coding (LHD)',
    ])
    expect(result.tickets[2].fields.Steps).toBe('3')
    expect(result.tickets.every((ticket) => ticket.kind === 'block')).toBe(true)
  })

  it('falls back to the name prefix and position keys when ids are missing', () => {
    const result = buildJiraTicketPlan(
      parse(
        '<IB-1><NAME>0123_No_Diag</NAME><PROCEDURES><PROCEDURE><NAME>P</NAME><BLOCK><NAME>B</NAME></BLOCK></PROCEDURE></PROCEDURES></IB-1>',
      ),
      'x.xml',
    )

    expect(result.ecu.ecuId).toBe('0123')
    expect(result.tickets[0].ibKey).toBe('ib1:0123:path:p/block-b')
    expect(result.warnings).toHaveLength(2)
  })

  it('rejects documents without an IB-1 root', () => {
    expect(() => buildJiraTicketPlan(parse('<html><body/></html>'), 'x.html')).toThrow(/IB-1 root/)
  })
})

describe('exporters', () => {
  it('escapes Jira wiki markup but keeps URLs and snake_case readable', () => {
    expect(escapeWiki('read_data *bold* [x] {y} a|b')).toBe('read_data \\*bold\\* \\[x\\] \\{y\\} a\\|b')
    expect(escapeWiki('see http://host/api/read_data now')).toBe('see http://host/api/read_data now')
    expect(escapeWiki('- item\n# heading')).toBe('\\- item\n\\# heading')
  })

  it('renders descriptions with tables, code and the sync key', () => {
    const ticket = plan().tickets.find((item) => item.sourceId === 'step-read')!
    const wiki = ticketWikiDescription(ticket)

    expect(wiki).toContain('h4. REST request')
    expect(wiki).toContain('{code:json}\n{\n  "data": {')
    expect(wiki).toContain('{{ib1:0099:step-read}}')
  })

  it('writes a Jira CSV with a new ECU parent row', () => {
    const csv = toJiraCsv(plan())
    const lines = csv.split('\r\n')

    expect(lines[0]).toMatch(/^"Issue Id","Parent Id","Parent","Summary","Issue Type","Description","IB1 Key","Labels"/)
    expect(lines[1]).toMatch(/^"1","","","0099_Test_ECU","Electronic Control Unit"/)
    expect(csv).toContain('"2","1","","SFD unlock","Commissioning Step"')
  })

  it('links CSV rows to an existing ECU ticket when given', () => {
    const csv = toJiraCsv(plan({ ecuIssueKey: 'PRDFSI-150', childIssueType: 'Task' }))

    expect(csv).not.toContain('"Electronic Control Unit"')
    expect(csv).toContain('"2","","PRDFSI-150","SFD unlock","Task"')
  })

  it('exports JSON with wiki descriptions', () => {
    const json = JSON.parse(toPlanJson(plan()))

    expect(json.mode).toBe('dry-run')
    expect(json.tickets).toHaveLength(7)
    expect(json.tickets[0].descriptionWiki).toContain('h4. Block parameters')
  })
})
