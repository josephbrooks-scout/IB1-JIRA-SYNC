import { ticketWikiDescription, toJiraWikiMarkup } from './exporters.ts'
import type { SyncAction, SyncActionType, SyncPlan } from './jiraSync.ts'

export type ReviewChoice = 'accept' | 'keep' | 'merge'

export type ReviewAction = {
  id: string
  type: SyncActionType
  summary: string
  ibKey?: string
  parentIbKey?: string
  issueKey?: string
  reason?: string
  held?: string
  current?: {
    summary: string
    description: string
    status: string
  }
  proposed?: {
    summary: string
    description: string
    issueType?: string
    parent?: string
  }
}

export type ReviewFile = {
  reviewId: string
  file: string
  ibName: string
  version: string
  ecuId: string
  ecuKey: string | null
  blockers: string[]
  notes: string[]
  actions: ReviewAction[]
}

export type SyncReviewReport = {
  schemaVersion: 1
  generatedAt: string
  files: ReviewFile[]
}

export type ReviewedAction = {
  choice: ReviewChoice
  checked: boolean
  summary?: string
  description?: string
}

export type ReviewApprovalFile = {
  schemaVersion: 1
  generatedAt: string
  files: Array<{
    reviewId: string
    actions: Record<string, ReviewedAction>
  }>
}

export function reviewActionId(action: SyncAction, index: number) {
  return `${index}:${action.type}:${action.ticket?.ibKey ?? action.issueKey ?? action.summary}`
}

export function buildReviewFile(syncPlan: SyncPlan, file: string, reviewId: string): ReviewFile {
  const { plan } = syncPlan
  const ecuDescription = toJiraWikiMarkup(plan.ecu.sections, `ib1:${plan.ecu.ecuId}:ecu`)

  return {
    reviewId,
    file,
    ibName: plan.source.ibName,
    version: plan.source.version,
    ecuId: plan.ecu.ecuId,
    ecuKey: syncPlan.ecuKey,
    blockers: syncPlan.blockers,
    notes: syncPlan.notes,
    actions: syncPlan.actions.map((action, index) => {
      const ticket = action.ticket
      const isEcuAction = action.type === 'create-ecu' || action.type === 'update-ecu'

      return {
        id: reviewActionId(action, index),
        type: action.type,
        summary: action.summary,
        ...(ticket ? { ibKey: ticket.ibKey } : {}),
        ...(ticket?.parentIbKey ? { parentIbKey: ticket.parentIbKey } : {}),
        ...(action.issueKey ? { issueKey: action.issueKey } : {}),
        ...(action.reason ? { reason: action.reason } : {}),
        ...(action.held ? { held: action.held } : {}),
        ...(action.current
          ? {
              current: {
                summary: action.current.summary,
                description: descriptionText(action.current.description),
                status: action.current.status,
              },
            }
          : {}),
        ...((ticket || isEcuAction)
          ? {
              proposed: {
                summary: ticket?.summary ?? plan.ecu.summary,
                description: ticket
                  ? ticketWikiDescription(ticket)
                  : isEcuAction
                    ? ecuDescription
                    : '',
                ...(ticket
                  ? {
                      issueType: ticket.issueType,
                      parent: ticket.parentIbKey
                        ? plan.tickets.find((parent) => parent.ibKey === ticket.parentIbKey)?.summary ?? ''
                        : syncPlan.ecuKey ?? `New ${plan.ecu.issueType}: ${plan.ecu.summary}`,
                    }
                  : {}),
              },
            }
          : {}),
      }
    }),
  }
}

export function validateReviewApproval(
  review: ReviewFile,
  approval: ReviewApprovalFile['files'][number] | undefined,
): { decisions: Record<string, ReviewedAction> | null; errors: string[] } {
  if (!approval) {
    return {
      decisions: null,
      errors: ['Approval file does not match this Jira/source snapshot. Generate a fresh report and review it again.'],
    }
  }

  if (!approval.actions || typeof approval.actions !== 'object' || Array.isArray(approval.actions)) {
    return { decisions: null, errors: ['Approval file has no action decisions.'] }
  }

  const errors: string[] = []
  const expected = review.actions.filter((action) => action.type !== 'unchanged')
  const expectedIds = new Set(expected.map((action) => action.id))
  const suppliedIds = new Set(Object.keys(approval.actions))

  for (const action of expected) {
    const decision = approval.actions[action.id]

    if (!decision || decision.checked !== true) {
      errors.push(`"${action.summary}" has not been explicitly reviewed and checked off.`)
      continue
    }

    if (!['accept', 'keep', 'merge'].includes(decision.choice)) {
      errors.push(`"${action.summary}" has an invalid review choice.`)
    } else if (action.held && decision.choice === 'accept' && action.type !== 'remove') {
      errors.push(`"${action.summary}" is held for review; resolve the hold before accepting it.`)
    } else if (decision.choice === 'merge' && (!decision.summary?.trim() || !decision.description?.trim())) {
      errors.push(`Merged "${action.summary}" needs a summary and description.`)
    } else if (decision.description && decision.description.length > 32_000) {
      errors.push(`Description for "${action.summary}" exceeds Jira's 32,000 character limit.`)
    }
  }

  for (const action of expected) {
    if (!action.parentIbKey) continue
    const parent = review.actions.find((candidate) => candidate.ibKey === action.parentIbKey)
    if (!parent) {
      errors.push(`"${action.summary}" has no matching block action in this review.`)
      continue
    }

    const childDecision = approval.actions[action.id]
    const parentDecision = approval.actions[parent.id]
    if (
      parent.type === 'create' &&
      childDecision?.choice !== 'keep' &&
      (parentDecision?.choice === 'keep' || parentDecision?.checked !== true)
    ) {
      errors.push(`"${action.summary}" cannot be applied unless its block "${parent.summary}" is also accepted or merged.`)
    }
  }

  for (const id of suppliedIds) {
    if (!expectedIds.has(id)) {
      errors.push(`Approval file contains an unknown or unchanged action "${id}".`)
    }
  }

  return { decisions: errors.length ? null : approval.actions, errors }
}

function descriptionText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (!value || typeof value !== 'object') {
    return ''
  }

  const adf = value as { type?: string; text?: string; content?: unknown[] }

  if (adf.type === 'text') {
    return adf.text ?? ''
  }

  if (adf.type === 'hardBreak') {
    return '\n'
  }

  const content = adf.content ?? []
  const children = content.map(descriptionText)

  if (adf.type === 'doc') {
    return children.filter(Boolean).join('\n\n')
  }

  if (adf.type === 'paragraph' || adf.type === 'heading' || adf.type === 'codeBlock') {
    return children.join('').trim()
  }

  if (adf.type === 'tableRow') {
    return children.join(' | ')
  }

  return children.join('')
}
