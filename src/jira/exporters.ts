import type { DescriptionSection, JiraTicketPlan, PlannedTicket } from './ib1JiraPlan.ts'

// Escapes characters that would create tables, macros, links or emphasis; line-leading list/heading markers too.
// URLs and in-word underscores (snake_case IDs) are left alone so they stay readable and auto-link in Jira.
const WIKI_STRUCTURAL_CHARACTERS = /([[\]{}|\\])/g
const WIKI_EMPHASIS_CHARACTERS = /(?<![A-Za-z0-9])([*_^~+])|([*_^~+])(?![A-Za-z0-9])/g
const URL_PATTERN = /(https?:\/\/[^\s|[\]{}]+)/

export function escapeWiki(value: string): string {
  return value
    .split(URL_PATTERN)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(WIKI_STRUCTURAL_CHARACTERS, '\\$1')
            .replace(WIKI_EMPHASIS_CHARACTERS, (_match, before?: string, after?: string) => `\\${before ?? after}`),
    )
    .join('')
    .replace(/^([#-]|h[1-6]\.)/gm, '\\$1')
}

function wikiCell(value: string): string {
  const escaped = escapeWiki(value).replace(/\n+/g, ' \\\\ ')

  return escaped.trim() ? escaped : ' '
}

export function toJiraWikiMarkup(sections: DescriptionSection[], footerKey?: string): string {
  const blocks = sections.map((section) => {
    const heading = section.title ? `h4. ${escapeWiki(section.title)}\n` : ''

    switch (section.kind) {
      case 'fields':
        return `${heading}${section.rows.map(([key, value]) => `*${escapeWiki(key)}:* ${escapeWiki(value)}`).join('\n')}`
      case 'text':
        return `${heading}${escapeWiki(section.text)}`
      case 'list':
        return `${heading}${section.items.map((item) => `* ${escapeWiki(item).replace(/\n+/g, ' ')}`).join('\n')}`
      case 'table':
        return `${heading}||${section.headers.map(wikiCell).join('||')}||\n${section.rows
          .map((row) => `|${row.map(wikiCell).join('|')}|`)
          .join('\n')}`
      case 'code':
        return `${heading}{code${section.language ? `:${section.language}` : ''}}\n${section.code.replace(/\{code/g, '{ code')}\n{code}`
    }
  })

  if (footerKey) {
    blocks.push(`----\n_Generated from IB1. Sync key:_ {{${footerKey}}}`)
  }

  return blocks.join('\n\n')
}

export function toPlainText(sections: DescriptionSection[], footerKey?: string): string {
  const blocks = sections.map((section) => {
    const heading = section.title ? `${section.title.toUpperCase()}\n` : ''

    switch (section.kind) {
      case 'fields':
        return `${heading}${section.rows.map(([key, value]) => `${key}: ${value}`).join('\n')}`
      case 'text':
        return `${heading}${section.text}`
      case 'list':
        return `${heading}${section.items.map((item) => `• ${item}`).join('\n')}`
      case 'table':
        return `${heading}${[section.headers, ...section.rows].map((row) => row.join(' | ')).join('\n')}`
      case 'code':
        return `${heading}${section.code}`
    }
  })

  if (footerKey) {
    blocks.push(`Sync key: ${footerKey}`)
  }

  return blocks.join('\n\n')
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`
}

// Columns follow the Jira Cloud CSV importer: "Issue Id" / "Parent Id" link rows created in the same import,
// "Parent" links rows to an issue that already exists (e.g. PRDFSI-150). Repeated "Labels" columns hold one label each.
export function toJiraCsv(plan: JiraTicketPlan): string {
  const existingParent = plan.ecu.existingIssueKey
  const maxLabels = Math.max(1, ...plan.tickets.map((ticket) => ticket.labels.length))
  const ecuLabels = ['ib1', `ecu-${plan.ecu.ecuId}`, ...plan.options.extraLabels]
  const header = [
    'Issue Id',
    'Parent Id',
    'Parent',
    'Summary',
    'Issue Type',
    'Description',
    'IB1 Key',
    ...Array.from({ length: Math.max(maxLabels, ecuLabels.length) }, () => 'Labels'),
  ]
  const labelColumns = header.length - 7
  const padLabels = (labels: string[]) =>
    Array.from({ length: labelColumns }, (_, index) => labels[index] ?? '')
  const rows: string[][] = []

  if (!existingParent) {
    rows.push([
      '1',
      '',
      '',
      plan.ecu.summary,
      plan.ecu.issueType,
      toJiraWikiMarkup(plan.ecu.sections, `ib1:${plan.ecu.ecuId}:ecu`),
      `ib1:${plan.ecu.ecuId}:ecu`,
      ...padLabels(ecuLabels),
    ])
  }

  plan.tickets.forEach((ticket, index) => {
    rows.push([
      String(index + 2),
      existingParent ? '' : '1',
      existingParent,
      ticket.summary,
      ticket.issueType,
      ticketWikiDescription(ticket),
      ticket.ibKey,
      ...padLabels(ticket.labels),
    ])
  })

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function ticketWikiDescription(ticket: PlannedTicket): string {
  return toJiraWikiMarkup(ticket.sections, ticket.ibKey)
}

export function ticketPlainDescription(ticket: PlannedTicket): string {
  return toPlainText(ticket.sections, ticket.ibKey)
}

export function toPlanJson(plan: JiraTicketPlan): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode: 'dry-run',
      ...plan,
      ecu: { ...plan.ecu, descriptionWiki: toJiraWikiMarkup(plan.ecu.sections) },
      tickets: plan.tickets.map((ticket) => ({
        ...ticket,
        parent: plan.ecu.existingIssueKey || `(new ${plan.ecu.issueType}: ${plan.ecu.summary})`,
        descriptionWiki: ticketWikiDescription(ticket),
      })),
    },
    null,
    2,
  )
}
