#!/usr/bin/env node
// IB1 -> Jira sync. Dry run by default; --apply writes. Exit codes: 0 done, 1 error, 2 something blocked/held for review.
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { buildJiraTicketPlan, type TicketGranularity } from '../src/jira/ib1JiraPlan.ts'
import { createJiraRestClient } from '../src/jira/jiraClient.ts'
import {
  applySync,
  DEFAULT_SYNC_OPTIONS,
  formatSyncReport,
  planSync,
  readJiraState,
  type ApplyDecision,
  type SyncOptions,
} from '../src/jira/jiraSync.ts'
import {
  buildReviewFile,
  reviewActionId,
  validateReviewApproval,
  type ReviewApprovalFile,
} from '../src/jira/review.ts'
import { expandInputPaths, isNotIb1Error, loadIb1Xml } from './loadIb1Xml.ts'

const USAGE = `Usage: npm run jira:sync -- <IB1.xml | folder>... [options]

  --apply                 Apply only changes checked off in a matching browser approval file
  --approval-file FILE    Reviewed approvals JSON exported by the browser review page (required with --apply)
  --parent KEY            Existing ECU ticket, e.g. PRDFSI-150 (single file only; default: find by Diag Address)
  --create-ecu            Create the ECU ticket when none is found
  --vehicle KEY           Vehicle/Traveller parent for a newly created ECU ticket, e.g. PRDFSI-35
  --granularity nested|block|step  Nested block and step tickets by default; optional flat layouts
  --adopt                 Link existing hand-made tickets whose names match instead of creating duplicates
  --allow-removals        Move tickets no longer in the IB1 to the "removed" status
  --ignore-unmanaged      Do not stop when the ECU has hand-made tickets resembling IB1 blocks/steps
  --max-updates N         Stop if more than N tickets would be reopened (default ${DEFAULT_SYNC_OPTIONS.maxUpdates})
  --child-type NAME       Issue type for step/block tickets (default env JIRA_CHILD_ISSUE_TYPE or "Commissioning Step")
  --step-type NAME        Sub-task issue type for nested steps (default env JIRA_STEP_ISSUE_TYPE or "Workaround")
  --label NAME            Extra label, repeatable
  --report FILE           Write a JSON review report for the browser page

Environment (or .env): JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, optional JIRA_PROJECT,
JIRA_CHILD_ISSUE_TYPE, JIRA_STEP_ISSUE_TYPE, JIRA_REOPEN_STATUS, JIRA_REMOVED_STATUS.`

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    apply: { type: 'boolean', default: false },
    parent: { type: 'string' },
    'create-ecu': { type: 'boolean', default: false },
    vehicle: { type: 'string' },
    granularity: { type: 'string', default: 'nested' },
    adopt: { type: 'boolean', default: false },
    'allow-removals': { type: 'boolean', default: false },
    'ignore-unmanaged': { type: 'boolean', default: false },
    'max-updates': { type: 'string' },
    'child-type': { type: 'string' },
    'step-type': { type: 'string' },
    label: { type: 'string', multiple: true },
    report: { type: 'string' },
    'approval-file': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
})

if (values.help || !positionals.length) {
  console.log(USAGE)
  process.exit(values.help ? 0 : 1)
}

if (values.apply && !values['approval-file']) {
  console.error('--apply requires --approval-file exported from the browser review page. No Jira changes were made.')
  process.exit(2)
}

if (values.apply && values.report) {
  console.error('--report is for dry-run reviews; generate the report before applying approvals.')
  process.exit(1)
}

if (values['approval-file'] && !values.apply) {
  console.error('--approval-file is only valid with --apply.')
  process.exit(1)
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

if (!['step', 'block', 'nested'].includes(values.granularity ?? '')) {
  console.error(`Unknown --granularity "${values.granularity}". Use nested, block or step.`)
  process.exit(1)
}

const maxUpdates = values['max-updates'] === undefined ? DEFAULT_SYNC_OPTIONS.maxUpdates : Number(values['max-updates'])

if (!Number.isInteger(maxUpdates) || maxUpdates < 0) {
  console.error('--max-updates must be a whole number.')
  process.exit(1)
}

const inputs = await expandInputPaths(positionals)

let approvals: ReviewApprovalFile | undefined

if (values['approval-file']) {
  try {
    approvals = JSON.parse(await readFile(values['approval-file'], 'utf8')) as ReviewApprovalFile

    if (
      approvals.schemaVersion !== 1 ||
      !Array.isArray(approvals.files) ||
      approvals.files.some(
        (item) => !item || typeof item.reviewId !== 'string' || !item.actions || typeof item.actions !== 'object',
      )
    ) {
      throw new Error('Unsupported approval file format.')
    }
  } catch (error) {
    console.error(`Could not read approval file: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}

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

const preparedRuns: Array<{
  input: (typeof inputs)[number]
  plan: ReturnType<typeof buildJiraTicketPlan>
  syncPlan: ReturnType<typeof planSync>
  review: ReturnType<typeof buildReviewFile>
  error?: string
}> = []

for (const input of inputs) {
  try {
    const loaded = await loadIb1Xml(input.path)
    const plan = buildJiraTicketPlan(loaded.document, loaded.fileName, {
      projectKey: env.JIRA_PROJECT || 'PRDFSI',
      childIssueType: values['child-type'] || env.JIRA_CHILD_ISSUE_TYPE || 'Commissioning Step',
      stepIssueType: values['step-type'] || env.JIRA_STEP_ISSUE_TYPE || 'Workaround',
      ecuIssueKey: syncOptions.parentKey,
      granularity: values.granularity as TicketGranularity,
      extraLabels: values.label ?? [],
    })
    const state = await readJiraState(api, plan, syncOptions)
    const syncPlan = planSync(plan, state, syncOptions)
    const unsignedReview = buildReviewFile(syncPlan, input.path, '')
    const reviewId = createHash('sha256').update(JSON.stringify({ ...unsignedReview, reviewId: '' })).digest('hex')

    preparedRuns.push({
      input,
      plan,
      syncPlan,
      review: { ...unsignedReview, reviewId },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)

    if (input.fromFolder && isNotIb1Error(error)) {
      console.log(`Skipped ${input.path}: not an IB1 XML file.\n`)
      continue
    }

    exitCode = 1
    preparedRuns.push({
      input,
      plan: undefined as never,
      syncPlan: undefined as never,
      review: undefined as never,
      error: message,
    })
  }
}

const approvalDecisions = new Map<string, Record<string, ApplyDecision>>()

if (values.apply) {
  const errors: string[] = []
  const seenApprovalIds = new Set<string>()

  for (const run of preparedRuns) {
    if (run.error) {
      errors.push(`${run.input.path}: ${run.error}`)
      continue
    }

    const approval = approvals!.files.find((item) => item.reviewId === run.review.reviewId)

    if (approval && seenApprovalIds.has(approval.reviewId)) {
      errors.push(`${run.input.path}: approval file contains duplicate review ID ${approval.reviewId}.`)
      continue
    }

    if (approval) {
      seenApprovalIds.add(approval.reviewId)
    }

    const checked = validateReviewApproval(run.review, approval)
    errors.push(...checked.errors.map((error) => `${run.input.path}: ${error}`))

    if (run.syncPlan.blockers.length) {
      errors.push(`${run.input.path}: plan is blocked: ${run.syncPlan.blockers.join('; ')}`)
    }

    if (checked.decisions) {
      approvalDecisions.set(run.review.reviewId, checked.decisions)
    }
  }

  const reviewedIds = new Set(preparedRuns.filter((run) => !run.error).map((run) => run.review.reviewId))

  for (const approval of approvals!.files) {
    if (!reviewedIds.has(approval.reviewId)) {
      errors.push(`Approval file contains an unknown or stale review ${approval.reviewId}.`)
    }
  }

  if (errors.length) {
    console.error(`Approval check failed; nothing was written to Jira:\n- ${errors.join('\n- ')}`)
    exitCode = 2
  }
}

if (exitCode !== 2) {
  for (const run of preparedRuns) {
    if (run.error) {
      summaries.push(`## ${run.input.path}\n\n**Error:** ${run.error}`)
      console.error(`Error in ${run.input.path}: ${run.error}\n`)
      runReport.push({ file: run.input.path, error: run.error })
      continue
    }

    const decisions = approvalDecisions.get(run.review.reviewId)
    const result = values.apply
      ? await applySync(api, run.syncPlan, syncOptions, () => new Date(), decisions)
      : undefined
    const summary = formatSyncReport(run.syncPlan, result)
    const held = run.syncPlan.actions.filter((action) => action.held).length

    summaries.push(summary)
    console.log(`${summary}\nReview ID: ${run.review.reviewId}\n`)

    if (result?.errors) {
      exitCode = 1
    } else if ((run.syncPlan.blockers.length || held) && exitCode === 0) {
      exitCode = 2
    }

    runReport.push({
      file: run.input.path,
      ibName: run.plan.source.ibName,
      version: run.plan.source.version,
      ecuId: run.plan.ecu.ecuId,
      ecuKey: result?.ecuKey ?? run.syncPlan.ecuKey,
      mode: values.apply ? 'apply' : 'dry-run',
      blockers: run.syncPlan.blockers,
      notes: run.syncPlan.notes,
      review: run.review,
      actions: run.syncPlan.actions.map((action, index) => ({
        id: reviewActionId(action, index),
        type: action.type,
        summary: action.summary,
        issueKey: action.issueKey,
        reason: action.reason,
        held: action.held,
      })),
      result,
    })
  }
}

if (values.report) {
  await writeFile(
    values.report,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        files: runReport.flatMap((run) => (run.review ? [run.review] : [])),
      },
      null,
      2,
    ),
  )
}

// Shows the run summary on the GitHub Actions job page when running in CI.
if (env.GITHUB_STEP_SUMMARY) {
  await appendFile(env.GITHUB_STEP_SUMMARY, `# IB1 → Jira sync${values.apply ? '' : ' (dry run)'}\n\n${summaries.join('\n\n')}\n`)
}

process.exit(exitCode)
