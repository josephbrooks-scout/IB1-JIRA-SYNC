#!/usr/bin/env node
// IB1 -> Jira sync. Dry run by default; --apply writes. Exit codes: 0 done, 1 error, 2 something blocked/held for review.
import { appendFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { buildJiraTicketPlan, type TicketGranularity } from '../src/jira/ib1JiraPlan.ts'
import { createJiraRestClient } from '../src/jira/jiraClient.ts'
import {
  applySync,
  DEFAULT_SYNC_OPTIONS,
  formatSyncReport,
  planSync,
  readJiraState,
  type SyncOptions,
  type SyncResult,
} from '../src/jira/jiraSync.ts'
import { expandInputPaths, isNotIb1Error, loadIb1Xml } from './loadIb1Xml.ts'

const USAGE = `Usage: npm run jira:sync -- <IB1.xml | folder>... [options]

  --apply                 Write to Jira (default is a dry run that only reads)
  --parent KEY            Existing ECU ticket, e.g. PRDFSI-150 (single file only; default: find by Diag Address)
  --create-ecu            Create the ECU ticket when none is found
  --vehicle KEY           Vehicle/Traveller parent for a newly created ECU ticket, e.g. PRDFSI-35
  --granularity step|block  One ticket per step (default) or per block
  --adopt                 Link existing hand-made tickets whose names match instead of creating duplicates
  --allow-removals        Move tickets no longer in the IB1 to the "removed" status
  --ignore-unmanaged      Do not stop when the ECU has hand-made tickets resembling IB1 blocks/steps
  --max-updates N         Stop if more than N tickets would be reopened (default ${DEFAULT_SYNC_OPTIONS.maxUpdates})
  --child-type NAME       Issue type for step/block tickets (default env JIRA_CHILD_ISSUE_TYPE or "Commissioning Step")
  --label NAME            Extra label, repeatable
  --report FILE           Write a JSON run report

Environment (or .env): JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, optional JIRA_PROJECT,
JIRA_CHILD_ISSUE_TYPE, JIRA_REOPEN_STATUS, JIRA_REMOVED_STATUS.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: 'boolean', default: false },
    parent: { type: 'string' },
    'create-ecu': { type: 'boolean', default: false },
    vehicle: { type: 'string' },
    granularity: { type: 'string', default: 'step' },
    adopt: { type: 'boolean', default: false },
    'allow-removals': { type: 'boolean', default: false },
    'ignore-unmanaged': { type: 'boolean', default: false },
    'max-updates': { type: 'string' },
    'child-type': { type: 'string' },
    label: { type: 'string', multiple: true },
    report: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || !positionals.length) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

if (existsSync('.env')) {
  process.loadEnvFile('.env')
}

const env = process.env
const missing = ['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'].filter((name) => !env[name])

if (missing.length) {
  console.error(`Missing ${missing.join(', ')}. Set them in the environment or in a .env file (see .env.example).`)
  process.exit(1)
}

if (values.granularity !== 'step' && values.granularity !== 'block') {
  console.error(`Unknown --granularity "${values.granularity}". Use step or block.`)
  process.exit(1)
}

const maxUpdates = values['max-updates'] === undefined ? DEFAULT_SYNC_OPTIONS.maxUpdates : Number(values['max-updates'])

if (!Number.isInteger(maxUpdates) || maxUpdates < 0) {
  console.error('--max-updates must be a whole number.')
  process.exit(1)
}

const inputs = await expandInputPaths(positionals)

if (values.parent && inputs.length > 1) {
  console.error('--parent can only be used with a single IB1 file.')
  process.exit(1)
}

const api = createJiraRestClient({
  baseUrl: env.JIRA_BASE_URL!,
  email: env.JIRA_EMAIL!,
  apiToken: env.JIRA_API_TOKEN!,
})
const syncOptions: SyncOptions = {
  ...DEFAULT_SYNC_OPTIONS,
  parentKey: values.parent ?? '',
  createEcu: values['create-ecu'] ?? false,
  vehicleKey: values.vehicle ?? '',
  adopt: values.adopt ?? false,
  allowRemovals: values['allow-removals'] ?? false,
  ignoreUnmanaged: values['ignore-unmanaged'] ?? false,
  maxUpdates,
  ...(env.JIRA_REOPEN_STATUS ? { reopenStatus: env.JIRA_REOPEN_STATUS } : {}),
  ...(env.JIRA_REMOVED_STATUS ? { removedStatus: env.JIRA_REMOVED_STATUS } : {}),
}
const runReport: Array<Record<string, unknown>> = []
const summaries: string[] = []
let exitCode = 0

for (const input of inputs) {
  try {
    const loaded = await loadIb1Xml(input.path)
    const plan = buildJiraTicketPlan(loaded.document, loaded.fileName, {
      projectKey: env.JIRA_PROJECT || 'PRDFSI',
      childIssueType: values['child-type'] || env.JIRA_CHILD_ISSUE_TYPE || 'Commissioning Step',
      ecuIssueKey: syncOptions.parentKey,
      granularity: values.granularity as TicketGranularity,
      extraLabels: values.label ?? [],
    })
    const state = await readJiraState(api, plan, syncOptions)
    const syncPlan = planSync(plan, state, syncOptions)
    let result: SyncResult | undefined

    if (values.apply) {
      result = await applySync(api, syncPlan, syncOptions)
    }

    const summary = formatSyncReport(syncPlan, result)
    const held = syncPlan.actions.filter((action) => action.held).length

    summaries.push(summary)
    console.log(`${summary}\n`)

    if (result?.errors) {
      exitCode = 1
    } else if ((syncPlan.blockers.length || held) && exitCode === 0) {
      exitCode = 2
    }

    runReport.push({
      file: input.path,
      ibName: plan.source.ibName,
      version: plan.source.version,
      ecuId: plan.ecu.ecuId,
      ecuKey: result?.ecuKey ?? syncPlan.ecuKey,
      mode: values.apply ? 'apply' : 'dry-run',
      blockers: syncPlan.blockers,
      notes: syncPlan.notes,
      actions: syncPlan.actions.map(({ type, summary: title, issueKey, reason, held: heldReason }) => ({
        type,
        summary: title,
        issueKey,
        reason,
        held: heldReason,
      })),
      result,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (input.fromFolder && isNotIb1Error(error)) {
      console.log(`Skipped ${input.path}: not an IB1 XML file.\n`)
      continue
    }

    exitCode = 1
    summaries.push(`## ${input.path}\n\n**Error:** ${message}`)
    console.error(`Error in ${input.path}: ${message}\n`)
    runReport.push({ file: input.path, error: message })
  }
}

if (values.report) {
  await writeFile(values.report, JSON.stringify({ generatedAt: new Date().toISOString(), files: runReport }, null, 2))
}

// Shows the run summary on the GitHub Actions job page when running in CI.
if (env.GITHUB_STEP_SUMMARY) {
  await appendFile(env.GITHUB_STEP_SUMMARY, `# IB1 → Jira sync${values.apply ? '' : ' (dry run)'}\n\n${summaries.join('\n\n')}\n`)
}

process.exit(exitCode)
