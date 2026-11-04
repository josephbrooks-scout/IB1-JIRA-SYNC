#!/usr/bin/env node
// Dry-run: converts an IB1 XML into a Jira ticket plan (JSON or Jira CSV import file). Nothing is sent to Jira.
// Usage: npm run jira:plan -- <IB1.xml> [--format summary|json|csv] [--out file] [--project PRDFSI]
//        [--parent PRDFSI-150] [--granularity nested|block|step] [--child-type "Commissioning Step"] [--step-type Workaround] [--label extra]
import { writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { buildJiraTicketPlan, type TicketGranularity } from '../src/jira/ib1JiraPlan.ts'
import { toJiraCsv, toPlanJson } from '../src/jira/exporters.ts'
import { loadIb1Xml } from './loadIb1Xml.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    format: { type: 'string', default: 'summary' },
    out: { type: 'string' },
    project: { type: 'string' },
    parent: { type: 'string' },
    granularity: { type: 'string', default: 'nested' },
    'child-type': { type: 'string' },
    'step-type': { type: 'string' },
    'ecu-type': { type: 'string' },
    label: { type: 'string', multiple: true },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || positionals.length !== 1) {
  console.log(
    'Usage: npm run jira:plan -- <IB1.xml> [--format summary|json|csv] [--out file] [--project PRDFSI]\n' +
      '       [--parent PRDFSI-150] [--granularity nested|block|step] [--child-type "Commissioning Step"] [--step-type Workaround] [--ecu-type "Electronic Control Unit"] [--label extra]',
  )
  process.exit(values.help ? 0 : 1)
}

if (!['summary', 'json', 'csv'].includes(values.format ?? '')) {
  console.error(`Unknown --format "${values.format}". Use summary, json or csv.`)
  process.exit(1)
}

if (!['step', 'block', 'nested'].includes(values.granularity ?? '')) {
  console.error(`Unknown --granularity "${values.granularity}". Use nested, block or step.`)
  process.exit(1)
}

const filePath = positionals[0]
let loaded: Awaited<ReturnType<typeof loadIb1Xml>>

try {
  loaded = await loadIb1Xml(filePath)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}

const plan = buildJiraTicketPlan(loaded.document, loaded.fileName, {
  ...(values.project ? { projectKey: values.project } : {}),
  ...(values.parent ? { ecuIssueKey: values.parent } : {}),
  ...(values['child-type'] ? { childIssueType: values['child-type'] } : {}),
  ...(values['step-type'] ? { stepIssueType: values['step-type'] } : {}),
  ...(values['ecu-type'] ? { ecuIssueType: values['ecu-type'] } : {}),
  granularity: values.granularity as TicketGranularity,
  extraLabels: values.label ?? [],
})

let output: string

if (values.format === 'json') {
  output = toPlanJson(plan)
} else if (values.format === 'csv') {
  output = toJiraCsv(plan)
} else {
  const lines = [
    `${plan.source.ibName} v${plan.source.version} (${plan.source.releaseDate})`,
    `ECU ${plan.ecu.ecuId} -> ${plan.ecu.existingIssueKey || `new "${plan.ecu.issueType}" ticket`}`,
    `Blocks: ${plan.stats.blocks} (${plan.stats.standardBlocks} standard, ${plan.stats.blocksWithSteps} with steps), steps: ${plan.stats.steps}`,
    `Tickets (${plan.options.granularity} mode): ${plan.stats.tickets}`,
    '',
    ...plan.tickets.map((ticket, index) => `${String(index + 1).padStart(3)}. [${ticket.kind}] ${ticket.summary}`),
  ]

  if (plan.warnings.length) {
    lines.push('', 'Warnings:', ...plan.warnings.map((warning) => `  - ${warning}`))
  }

  output = lines.join('\n')
}

if (values.out) {
  await writeFile(values.out, output, 'utf8')
  console.error(`Wrote ${plan.stats.tickets} planned tickets to ${values.out}`)
} else {
  console.log(output)
}
