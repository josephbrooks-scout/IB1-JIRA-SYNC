// Turns an IB1 ticket plan plus the current Jira state into sync actions, then applies them.
// Routine changes are applied automatically; anything that could lose work or create duplicates is held for a person.
import type { DescriptionSection, JiraTicketPlan, PlannedTicket } from './ib1JiraPlan.ts'
import { ticketWikiDescription, toJiraWikiMarkup } from './exporters.ts'
import type { JiraApi, JiraIssueRef } from './jiraClient.ts'

export const SYNC_PROPERTY = 'ib1.sync'
export const SPEC_CHANGED_LABEL = 'ib1-spec-changed'
export const REMOVED_LABEL = 'ib1-removed'

export type SyncProperty = {
  key: string
  hash: string
  ibName: string
  ibVersion: string
  ecuId: string
  syncedAt: string
  removedIn?: string
}

export type SyncOptions = {
  parentKey: string
  createEcu: boolean
  vehicleKey: string
  allowRemovals: boolean
  adopt: boolean
  ignoreUnmanaged: boolean
  maxUpdates: number
  reopenStatus: string
  removedStatus: string
  diagAddressField: string
  diagnosticAddressField: string
}

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  parentKey: '',
  createEcu: false,
  vehicleKey: '',
  allowRemovals: false,
  adopt: false,
  ignoreUnmanaged: false,
  maxUpdates: 25,
  reopenStatus: 'Open',
  removedStatus: 'Not Relevant',
  diagAddressField: 'Diag Address',
  diagnosticAddressField: 'Diagnostic Address',
}

export type ExistingChild = {
  key: string
  summary: string
  status: string
  labels: string[]
  property: SyncProperty | null
}

export type JiraState = {
  ecuKey: string | null
  ecuCandidates: Array<{ key: string; summary: string; property: SyncProperty | null }>
  ecuError: string
  children: ExistingChild[]
}

export type SyncActionType = 'create-ecu' | 'update-ecu' | 'create' | 'update' | 'refresh' | 'unchanged' | 'adopt' | 'remove'

export type SyncAction = {
  type: SyncActionType
  summary: string
  issueKey?: string
  ticket?: PlannedTicket
  hash?: string
  status?: string
  property?: SyncProperty
  reason?: string
  held?: string
}

export type SyncPlan = {
  plan: JiraTicketPlan
  ecuKey: string | null
  blockers: string[]
  notes: string[]
  actions: SyncAction[]
}

export type SyncOutcome = {
  type: SyncActionType
  summary: string
  issueKey?: string
  ok: boolean
  detail?: string
  error?: string
}

export type SyncResult = {
  status: 'applied' | 'partial' | 'blocked'
  ecuKey: string | null
  outcomes: SyncOutcome[]
  held: number
  errors: number
}

const CHANGE_TYPES: SyncActionType[] = ['create-ecu', 'create', 'update', 'adopt', 'remove']
// Listed in reports, but not counted as a change worth an ECU summary comment.
const LISTED_TYPES: SyncActionType[] = [...CHANGE_TYPES, 'update-ecu']

export async function readJiraState(api: JiraApi, plan: JiraTicketPlan, options: SyncOptions): Promise<JiraState> {
  const state: JiraState = { ecuKey: null, ecuCandidates: [], ecuError: '', children: [] }

  try {
    if (options.parentKey) {
      const parent = await api.getIssue(options.parentKey, [SYNC_PROPERTY])

      if (parent) {
        state.ecuCandidates = [toCandidate(parent)]
      } else {
        state.ecuError = `ECU ticket ${options.parentKey} was not found or is not visible to the sync account.`
      }
    } else {
      state.ecuCandidates = (await api.searchIssues(plan.ecu.lookupJql, [SYNC_PROPERTY])).map(toCandidate)
    }
  } catch (error) {
    state.ecuError = `Could not look up the ECU ticket: ${errorMessage(error)}`
  }

  if (state.ecuCandidates.length === 1) {
    state.ecuKey = state.ecuCandidates[0].key
    state.children = (await api.searchIssues(`parent = ${state.ecuKey} ORDER BY key ASC`, [SYNC_PROPERTY])).map(
      toExistingChild,
    )
  } else if (!state.ecuError && !state.ecuCandidates.length && options.createEcu && options.vehicleKey) {
    // Catch a mistyped --vehicle before anything is written; Jira would otherwise reject the ECU and every child.
    try {
      if (!(await api.getIssue(options.vehicleKey))) {
        state.ecuError = `Vehicle ticket ${options.vehicleKey} (--vehicle) was not found or is not visible to the sync account.`
      }
    } catch (error) {
      state.ecuError = `Could not look up the vehicle ticket ${options.vehicleKey}: ${errorMessage(error)}`
    }
  }

  return state
}

export function planSync(plan: JiraTicketPlan, state: JiraState, options: SyncOptions): SyncPlan {
  const blockers = [...plan.reviewReasons]
  const notes: string[] = []
  const actions: SyncAction[] = []
  const { source } = plan

  if (state.ecuError) {
    blockers.push(state.ecuError)
  } else if (state.ecuCandidates.length > 1) {
    blockers.push(
      `Several ECU tickets match ECU ${plan.ecu.ecuId} (${state.ecuCandidates.map((candidate) => candidate.key).join(', ')}). Pass the right one with --parent.`,
    )
  } else if (!state.ecuKey) {
    if (options.createEcu) {
      actions.push({ type: 'create-ecu', summary: plan.ecu.summary })
    } else {
      blockers.push(
        `No ECU ticket found for ECU ${plan.ecu.ecuId} (${plan.ecu.lookupJql}). Pass --parent KEY, or --create-ecu to create one.`,
      )
    }
  } else {
    // Only ECU tickets this tool created from the same IB1 document are kept in sync; hand-made ones are never edited.
    const ecuProperty = state.ecuCandidates[0]?.property
    const ecuHash = ecuContentHash(plan)

    if (
      ecuProperty?.key === `ib1:${plan.ecu.ecuId}:ecu` &&
      ecuProperty.ibName === source.ibName &&
      (ecuProperty.hash !== ecuHash || ecuProperty.ibVersion !== source.version)
    ) {
      actions.push({
        type: 'update-ecu',
        summary: plan.ecu.summary,
        issueKey: state.ecuKey,
        hash: ecuHash,
        property: ecuProperty,
        reason: `ECU description refreshed from v${ecuProperty.ibVersion}`,
      })
    }
  }

  const managed = new Map<string, ExistingChild>()
  const unmanaged: ExistingChild[] = []
  const otherDocuments = new Map<string, number>()

  state.children.forEach((child) => {
    if (!child.property) {
      unmanaged.push(child)
    } else if (child.property.ibName === source.ibName) {
      managed.set(child.property.key, child)
    } else {
      otherDocuments.set(child.property.ibName, (otherDocuments.get(child.property.ibName) ?? 0) + 1)
    }
  })

  otherDocuments.forEach((count, ibName) => {
    notes.push(`${count} ticket(s) under this ECU come from another IB1 document ("${ibName}") and are left untouched.`)
  })

  const newerVersion = Array.from(managed.values()).find(
    (child) => compareVersions(child.property!.ibVersion, source.version) > 0,
  )

  if (newerVersion) {
    blockers.push(
      `Jira was already synced from ${source.ibName} v${newerVersion.property!.ibVersion} (e.g. ${newerVersion.key}); this file is older (v${source.version}).`,
    )
  }

  const claimed = new Set<string>()

  plan.tickets.forEach((ticket) => {
    const hash = ticketContentHash(ticket)
    const existing = managed.get(ticket.ibKey)

    if (existing) {
      const property = existing.property!

      if (property.removedIn || property.hash !== hash) {
        actions.push({
          type: 'update',
          summary: ticket.summary,
          issueKey: existing.key,
          ticket,
          hash,
          status: existing.status,
          property,
          reason: property.removedIn ? `back in the IB1 after removal in v${property.removedIn}` : 'IB1 content changed',
        })
      } else if (property.ibVersion !== source.version) {
        actions.push({ type: 'refresh', summary: ticket.summary, issueKey: existing.key, ticket, hash })
      } else {
        actions.push({ type: 'unchanged', summary: ticket.summary, issueKey: existing.key, ticket, hash })
      }

      return
    }

    const match = unmanaged.find((child) => !claimed.has(child.key) && looksLikeTicket(child.summary, ticket))

    if (match) {
      claimed.add(match.key)
      actions.push(
        options.adopt
          ? { type: 'adopt', summary: ticket.summary, issueKey: match.key, ticket, hash, reason: `existing "${match.summary}"` }
          : {
              type: 'create',
              summary: ticket.summary,
              ticket,
              hash,
              held: `possible duplicate of ${match.key} "${match.summary}" — rerun with --adopt to link it instead`,
            },
      )
    } else {
      actions.push({ type: 'create', summary: ticket.summary, ticket, hash })
    }
  })

  const plannedKeys = new Set(plan.tickets.map((ticket) => ticket.ibKey))

  managed.forEach((child, key) => {
    if (!plannedKeys.has(key) && !child.property!.removedIn) {
      actions.push({
        type: 'remove',
        summary: child.summary,
        issueKey: child.key,
        status: child.status,
        property: child.property!,
        reason: `no longer in ${source.ibName} v${source.version}`,
        held: options.allowRemovals ? undefined : 'removals need review — rerun with --allow-removals',
      })
    }
  })

  const leftovers = unmanaged.filter((child) => !claimed.has(child.key))

  if (leftovers.length && !options.ignoreUnmanaged) {
    const similar = leftovers.filter((child) => plan.tickets.some((ticket) => looksLikeBlockOrStep(child.summary, ticket)))

    if (similar.length) {
      blockers.push(
        `${similar.length} existing ticket(s) under the ECU look like IB1 blocks/steps but do not match the planned tickets one-to-one (${similar
          .slice(0, 5)
          .map((child) => child.key)
          .join(', ')}${similar.length > 5 ? ', …' : ''}). Try --granularity ${plan.options.granularity === 'step' ? 'block' : 'step'} with --adopt, or pass --ignore-unmanaged.`,
      )
    } else {
      notes.push(`${leftovers.length} ticket(s) under the ECU were not created by this tool and are left untouched.`)
    }
  }

  const updates = actions.filter((action) => action.type === 'update').length

  if (updates > options.maxUpdates) {
    blockers.push(`${updates} tickets would be updated and reopened, above the limit of ${options.maxUpdates}. Rerun with --max-updates ${updates} if expected.`)
  }

  return { plan, ecuKey: state.ecuKey, blockers, notes, actions }
}

export async function applySync(
  api: JiraApi,
  syncPlan: SyncPlan,
  options: SyncOptions,
  now: () => Date = () => new Date(),
): Promise<SyncResult> {
  const held = syncPlan.actions.filter((action) => action.held).length

  if (syncPlan.blockers.length) {
    return { status: 'blocked', ecuKey: syncPlan.ecuKey, outcomes: [], held, errors: 0 }
  }

  const { plan } = syncPlan
  const outcomes: SyncOutcome[] = []
  let ecuKey = syncPlan.ecuKey
  const propertyFor = (ticket: PlannedTicket, hash: string): SyncProperty => ({
    key: ticket.ibKey,
    hash,
    ibName: plan.source.ibName,
    ibVersion: plan.source.version,
    ecuId: plan.ecu.ecuId,
    syncedAt: now().toISOString(),
  })
  const versionLabel = `${plan.source.ibName} v${plan.source.version}`

  for (const action of syncPlan.actions) {
    if (action.held || action.type === 'unchanged') {
      continue
    }

    const outcome: SyncOutcome = { type: action.type, summary: action.summary, issueKey: action.issueKey, ok: true }

    try {
      if (action.type === 'create-ecu') {
        ecuKey = await createEcuTicket(api, plan, options, now)
        outcome.issueKey = ecuKey
      } else if (action.type === 'update-ecu') {
        await api.editIssue(action.issueKey!, { description: ecuWikiDescription(plan) })
        await api.setProperty(action.issueKey!, SYNC_PROPERTY, {
          ...action.property!,
          hash: action.hash!,
          ibVersion: plan.source.version,
          syncedAt: now().toISOString(),
        })
      } else if (!ecuKey) {
        throw new Error('No ECU ticket available to attach to.')
      } else if (action.type === 'create') {
        const ticket = action.ticket!

        outcome.issueKey = await api.createIssue(
          {
            project: { key: plan.options.projectKey },
            issuetype: { name: ticket.issueType },
            parent: { key: ecuKey },
            summary: ticket.summary,
            description: ticketWikiDescription(ticket),
            labels: ticket.labels,
          },
          [{ key: SYNC_PROPERTY, value: propertyFor(ticket, action.hash!) }],
        )
      } else if (action.type === 'update') {
        const ticket = action.ticket!
        const key = action.issueKey!

        await api.editIssue(key, { summary: ticket.summary, description: ticketWikiDescription(ticket) }, ticket.labels)
        await api.setProperty(key, SYNC_PROPERTY, propertyFor(ticket, action.hash!))
        outcome.detail = await moveToStatus(api, key, action.status ?? '', options.reopenStatus, SPEC_CHANGED_LABEL)
        await api.addComment(
          key,
          `IB1 spec changed in *${versionLabel}* (${action.reason}). Summary and description were updated by the IB1 sync; please re-test.`,
        )
      } else if (action.type === 'refresh') {
        await api.setProperty(action.issueKey!, SYNC_PROPERTY, propertyFor(action.ticket!, action.hash!))
      } else if (action.type === 'adopt') {
        const ticket = action.ticket!

        await api.editIssue(action.issueKey!, {}, ticket.labels)
        await api.setProperty(action.issueKey!, SYNC_PROPERTY, propertyFor(ticket, action.hash!))
        await api.addComment(
          action.issueKey!,
          `Linked to IB1 ${ticket.kind === 'block' ? 'block' : 'step'} "${ticket.summary}" from *${versionLabel}*. Future IB1 changes will update this ticket.`,
        )
      } else if (action.type === 'remove') {
        const key = action.issueKey!

        outcome.detail = await moveToStatus(api, key, action.status ?? '', options.removedStatus, REMOVED_LABEL)
        await api.setProperty(key, SYNC_PROPERTY, { ...action.property!, removedIn: plan.source.version, syncedAt: now().toISOString() })
        await api.addComment(key, `This item is no longer in *${versionLabel}*. Moved by the IB1 sync; nothing was deleted.`)
      }
    } catch (error) {
      outcome.ok = false
      outcome.error = errorMessage(error)
    }

    outcomes.push(outcome)
  }

  const changes = outcomes.filter((outcome) => outcome.ok && CHANGE_TYPES.includes(outcome.type))

  if (ecuKey && changes.length) {
    const count = (type: SyncActionType) => changes.filter((outcome) => outcome.type === type).length

    try {
      await api.addComment(
        ecuKey,
        `IB1 sync from *${versionLabel}*: ${count('create')} created, ${count('update')} updated/reopened, ${count('adopt')} linked, ${count('remove')} marked not relevant${held ? `, ${held} held for review` : ''}.`,
      )
    } catch (error) {
      outcomes.push({ type: 'unchanged', summary: 'ECU summary comment', issueKey: ecuKey, ok: false, error: errorMessage(error) })
    }
  }

  const errors = outcomes.filter((outcome) => !outcome.ok).length

  return { status: errors || held ? 'partial' : 'applied', ecuKey, outcomes, held, errors }
}

function ecuWikiDescription(plan: JiraTicketPlan) {
  return toJiraWikiMarkup(plan.ecu.sections, `ib1:${plan.ecu.ecuId}:ecu`)
}

async function createEcuTicket(api: JiraApi, plan: JiraTicketPlan, options: SyncOptions, now: () => Date) {
  const fields: Record<string, unknown> = {
    project: { key: plan.options.projectKey },
    issuetype: { name: plan.ecu.issueType },
    summary: plan.ecu.summary,
    description: ecuWikiDescription(plan),
    labels: ['ib1', `ecu-${plan.ecu.ecuId}`, ...plan.options.extraLabels],
  }

  if (options.vehicleKey) {
    fields.parent = { key: options.vehicleKey }
  }

  const jiraFields = await api.getFields()
  const fieldId = (name: string) =>
    jiraFields.find((field) => field.name.toLowerCase() === name.toLowerCase())?.id

  const diagAddressId = fieldId(options.diagAddressField)
  const diagnosticAddressId = fieldId(options.diagnosticAddressField)

  if (diagAddressId && plan.ecu.fields['Diag Address']) {
    fields[diagAddressId] = plan.ecu.fields['Diag Address']
  }

  if (diagnosticAddressId && plan.ecu.fields['Diagnostic Address']) {
    fields[diagnosticAddressId] = plan.ecu.fields['Diagnostic Address']
  }

  return api.createIssue(fields, [
    {
      key: SYNC_PROPERTY,
      value: {
        key: `ib1:${plan.ecu.ecuId}:ecu`,
        hash: ecuContentHash(plan),
        ibName: plan.source.ibName,
        ibVersion: plan.source.version,
        ecuId: plan.ecu.ecuId,
        syncedAt: now().toISOString(),
      } satisfies SyncProperty,
    },
  ])
}

// Uses a workflow transition into the target status when one exists; otherwise labels the ticket so it can be found.
async function moveToStatus(api: JiraApi, key: string, currentStatus: string, target: string, fallbackLabel: string) {
  if (sameName(currentStatus, target)) {
    return `already ${currentStatus}`
  }

  const transition = (await api.getTransitions(key)).find(
    (candidate) => sameName(candidate.to.name, target) || sameName(candidate.name, target),
  )

  if (transition) {
    await api.transitionIssue(key, transition.id)

    return `${currentStatus || '?'} → ${transition.to.name}`
  }

  await api.editIssue(key, {}, [fallbackLabel])

  return `no transition from ${currentStatus || '?'} to ${target}; labeled ${fallbackLabel}`
}

// Content hash over everything the tool owns, minus the document version/date so unchanged steps are not reopened.
export function ticketContentHash(ticket: PlannedTicket): string {
  const stableSections: DescriptionSection[] = ticket.sections.map((section) =>
    section.kind === 'fields' && section.title === 'IB1 source'
      ? { ...section, rows: section.rows.filter(([key]) => key !== 'IB1 document' && key !== 'Release date') }
      : section,
  )

  return cyrb53(
    JSON.stringify({
      summary: ticket.summary,
      issueType: ticket.issueType,
      labels: [...ticket.labels].sort(),
      sections: stableSections,
    }),
  )
}

export function compareVersions(first: string, second: string): number {
  const firstParts = first.split(/[._-]/).map((part) => Number.parseInt(part, 10) || 0)
  const secondParts = second.split(/[._-]/).map((part) => Number.parseInt(part, 10) || 0)

  for (let index = 0; index < Math.max(firstParts.length, secondParts.length); index += 1) {
    const difference = (firstParts[index] ?? 0) - (secondParts[index] ?? 0)

    if (difference) {
      return Math.sign(difference)
    }
  }

  return 0
}

export function formatSyncReport(syncPlan: SyncPlan, result?: SyncResult): string {
  const { plan } = syncPlan
  const count = (type: SyncActionType, held = false) =>
    syncPlan.actions.filter((action) => action.type === type && Boolean(action.held) === held).length
  const lines = [
    `## ${plan.source.ibName} v${plan.source.version} (${plan.source.fileName})`,
    '',
    `- ECU ${plan.ecu.ecuId}: ${syncPlan.ecuKey ?? (count('create-ecu') ? 'new ECU ticket' : 'not found')}`,
    `- Planned: ${count('create')} create, ${count('update')} update + reopen, ${count('adopt')} link existing, ${count('remove')} not relevant, ${count('refresh')} version refresh, ${count('unchanged')} unchanged${count('update-ecu') ? ', ECU ticket description refreshed' : ''}`,
  ]
  const held = syncPlan.actions.filter((action) => action.held)

  if (syncPlan.blockers.length) {
    lines.push('', '**Blocked — nothing will be written for this file:**', ...syncPlan.blockers.map((blocker) => `- ${blocker}`))
  }

  if (held.length) {
    lines.push('', '**Held for review:**', ...held.map((action) => `- ${action.type} ${action.issueKey ?? ''} "${action.summary}": ${action.held}`))
  }

  syncPlan.notes.forEach((note) => lines.push(`- Note: ${note}`))

  const changes = syncPlan.actions.filter((action) => !action.held && LISTED_TYPES.includes(action.type))

  if (changes.length && !syncPlan.blockers.length) {
    lines.push(
      '',
      result ? '**Applied:**' : '**Would apply (dry run, pass --apply):**',
      ...(result
        ? result.outcomes.map(
            (outcome) =>
              `- ${outcome.ok ? 'OK ' : 'FAILED '}${outcome.type} ${outcome.issueKey ?? ''} "${outcome.summary}"${outcome.detail ? ` (${outcome.detail})` : ''}${outcome.error ? ` — ${outcome.error}` : ''}`,
          )
        : changes.map(
            (action) => `- ${action.type} ${action.issueKey ?? ''} "${action.summary}"${action.reason ? ` (${action.reason})` : ''}`,
          )),
    )
  }

  return lines.join('\n')
}

function looksLikeTicket(summary: string, ticket: PlannedTicket): boolean {
  const target = normalizeName(summary)
  const names =
    ticket.kind === 'block'
      ? [ticket.summary, ticket.fields.Block, ticket.fields['Block (original name)']]
      : [ticket.summary, ticket.fields.Step]

  return names.some((name) => name && normalizeName(name) === target)
}

function looksLikeBlockOrStep(summary: string, ticket: PlannedTicket): boolean {
  const target = normalizeName(summary)

  return [ticket.fields.Block, ticket.fields['Block (original name)'], ticket.fields.Step].some(
    (name) => name && normalizeName(name) === target,
  )
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function sameName(first: string, second: string): boolean {
  return first.trim().toLowerCase() === second.trim().toLowerCase()
}

function toCandidate(issue: JiraIssueRef) {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? '',
    property: parseSyncProperty(issue.properties?.[SYNC_PROPERTY]),
  }
}

export function ecuContentHash(plan: JiraTicketPlan): string {
  return cyrb53(JSON.stringify(plan.ecu.sections))
}

function toExistingChild(issue: JiraIssueRef): ExistingChild {
  return {
    key: issue.key,
    summary: issue.fields.summary ?? '',
    status: issue.fields.status?.name ?? '',
    labels: issue.fields.labels ?? [],
    property: parseSyncProperty(issue.properties?.[SYNC_PROPERTY]),
  }
}

function parseSyncProperty(value: unknown): SyncProperty | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const candidate = value as Partial<SyncProperty>

  return typeof candidate.key === 'string' && typeof candidate.hash === 'string' && typeof candidate.ibName === 'string'
    ? {
        key: candidate.key,
        hash: candidate.hash,
        ibName: candidate.ibName,
        ibVersion: String(candidate.ibVersion ?? ''),
        ecuId: String(candidate.ecuId ?? ''),
        syncedAt: String(candidate.syncedAt ?? ''),
        ...(candidate.removedIn ? { removedIn: String(candidate.removedIn) } : {}),
      }
    : null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function cyrb53(value: string): string {
  let first = 0xdeadbeef
  let second = 0x41c6ce57

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)

    first = Math.imul(first ^ code, 2654435761)
    second = Math.imul(second ^ code, 1597334677)
  }

  first = Math.imul(first ^ (first >>> 16), 2246822507) ^ Math.imul(second ^ (second >>> 13), 3266489909)
  second = Math.imul(second ^ (second >>> 16), 2246822507) ^ Math.imul(first ^ (first >>> 13), 3266489909)

  return (4294967296 * (2097151 & second) + (first >>> 0)).toString(16)
}
