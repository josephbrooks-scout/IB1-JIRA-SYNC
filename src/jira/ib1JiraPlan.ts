// Converts an IB1 XML document into a dry-run Jira ticket plan (ECU -> child tickets).
// Only minimal DOM APIs are used so the same code runs on the browser DOMParser and @xmldom/xmldom.

export type XmlNode = {
  nodeType: number
  nodeName: string
  textContent: string | null
  childNodes: ArrayLike<XmlNode>
  getAttribute?: (name: string) => string | null
}

export type TicketGranularity = 'step' | 'block'

export type JiraPlanOptions = {
  projectKey: string
  ecuIssueType: string
  childIssueType: string
  ecuIssueKey: string
  granularity: TicketGranularity
  extraLabels: string[]
}

export const DEFAULT_JIRA_PLAN_OPTIONS: JiraPlanOptions = {
  projectKey: 'PRDFSI',
  ecuIssueType: 'Electronic Control Unit',
  childIssueType: 'Commissioning Step',
  ecuIssueKey: '',
  granularity: 'block',
  extraLabels: [],
}

export type DescriptionSection =
  | { kind: 'fields'; title?: string; rows: Array<[string, string]> }
  | { kind: 'text'; title: string; text: string }
  | { kind: 'list'; title: string; items: string[] }
  | { kind: 'table'; title: string; headers: string[]; rows: string[][] }
  | { kind: 'code'; title: string; language?: string; code: string }
  | { kind: 'heading'; title: string }

export type PlannedTicketKind = 'step' | 'hmi-step' | 'block'

export type PlannedTicket = {
  ibKey: string
  sourceId: string
  kind: PlannedTicketKind
  issueType: string
  summary: string
  labels: string[]
  path: string[]
  blockKey: string
  blockName: string
  fields: Record<string, string>
  sections: DescriptionSection[]
}

export type PlannedEcu = {
  ecuId: string
  issueType: string
  existingIssueKey: string
  summary: string
  lookupJql: string
  fields: Record<string, string>
  slaves: Array<{ name: string; ecuId: string }>
  sections: DescriptionSection[]
}

export type PlanSource = {
  fileName: string
  ibName: string
  version: string
  releaseDate: string
  documentId: string
}

export type PlanStats = {
  procedures: number
  blocks: number
  standardBlocks: number
  blocksWithSteps: number
  steps: number
  tickets: number
}

export type JiraTicketPlan = {
  source: PlanSource
  options: JiraPlanOptions
  ecu: PlannedEcu
  tickets: PlannedTicket[]
  stats: PlanStats
  warnings: string[]
  // Subset of warnings serious enough that an automated sync must stop and wait for a person.
  reviewReasons: string[]
}

const ELEMENT_NODE = 1
const STEP_TAGS = new Set(['STEP', 'HMI-STEP'])
const CONDITIONAL_TAGS = new Set(['BRANCH', 'IF', 'ELSEIF', 'ELSE'])
const MAX_SUMMARY_LENGTH = 255

type PlanContext = {
  procedure: string
  caseLabel: string
}

type StepUnit = {
  element: XmlNode
  loops: string[]
  notes: string[]
}

type BuildState = {
  options: JiraPlanOptions
  ecuId: string
  source: PlanSource
  parameters: Map<string, XmlNode>
  tickets: PlannedTicket[]
  warnings: string[]
  reviewReasons: string[]
  usedKeys: Map<string, number>
  usedSummaries: Map<string, number>
  stats: PlanStats
}

export function buildJiraTicketPlan(
  xmlDocument: XmlNode,
  fileName: string,
  partialOptions: Partial<JiraPlanOptions> = {},
): JiraTicketPlan {
  const options = { ...DEFAULT_JIRA_PLAN_OPTIONS, ...partialOptions }
  const root = findIbRoot(xmlDocument)

  if (!root) {
    throw new Error('Jira ticket preview needs IB1 XML with an IB-1 root element.')
  }

  const warnings: string[] = []
  const reviewReasons: string[] = []
  const source: PlanSource = {
    fileName,
    ibName: textOf(root, 'NAME') || fileName,
    version: attr(root, 'version'),
    releaseDate: textOf(root, 'RELEASE-DATE'),
    documentId: attr(root, 'id'),
  }
  const ecu = buildEcu(root, source, options, { warnings, reviewReasons })
  const state: BuildState = {
    options,
    ecuId: ecu.ecuId,
    source,
    parameters: collectParameters(root),
    tickets: [],
    warnings,
    reviewReasons,
    usedKeys: new Map(),
    usedSummaries: new Map(),
    stats: {
      procedures: 0,
      blocks: 0,
      standardBlocks: 0,
      blocksWithSteps: 0,
      steps: 0,
      tickets: 0,
    },
  }

  childElements(child(root, 'PROCEDURES'), 'PROCEDURE').forEach((procedure) => {
    state.stats.procedures += 1
    walkContainer(procedure, { procedure: textOf(procedure, 'NAME'), caseLabel: '' }, state)
  })

  if (state.stats.blocks === 0) {
    flag({ warnings, reviewReasons }, 'No procedure blocks were found in this IB1 document.')
  }

  const duplicateSummaries = Array.from(state.usedSummaries.values()).filter((count) => count > 1)

  if (duplicateSummaries.length) {
    warnings.push(
      `${duplicateSummaries.length} ticket title(s) were repeated; a "(2)", "(3)" suffix was added to keep them distinguishable.`,
    )
  }

  state.stats.tickets = state.tickets.length

  return {
    source,
    options,
    ecu,
    tickets: state.tickets,
    stats: state.stats,
    warnings,
    reviewReasons,
  }
}

type Notices = { warnings: string[]; reviewReasons: string[] }

function flag(notices: Notices, message: string) {
  notices.warnings.push(message)
  notices.reviewReasons.push(message)
}

function walkContainer(container: XmlNode, context: PlanContext, state: BuildState) {
  childElements(container).forEach((element) => {
    if (element.nodeName === 'BLOCK') {
      processBlock(element, context, state)
    } else if (element.nodeName === 'BLOCKS') {
      walkContainer(element, context, state)
    } else if (element.nodeName === 'SWITCH') {
      const switchName = textOf(element, 'NAME') || 'Switch'

      childElements(element, 'CASE').forEach((caseElement) => {
        const caseName = textOf(caseElement, 'NAME') || 'Case'

        walkContainer(caseElement, { ...context, caseLabel: `${switchName}: ${caseName}` }, state)
      })
    }
  })
}

function processBlock(block: XmlNode, context: PlanContext, state: BuildState) {
  const { options } = state
  const name = textOf(block, 'NAME') || attr(block, 'shortname') || 'Unnamed block'
  const englishName = textOf(block, 'NAME_EN')
  const blockName = englishName || name
  const isStandard = attr(block, 'standardIBNB') === 'true'
  const isOptional = attr(block, 'optional') === 'true'
  const caseName = context.caseLabel.split(': ').slice(1).join(': ')
  const blockTitle = caseName ? `${blockName} (${caseName})` : blockName
  const blockPath = [context.procedure, context.caseLabel, `Block: ${blockName}`].filter(Boolean)
  const blockKey = makeIbKey(state, block, blockPath)
  const blockFields = cleanFields({
    Procedure: context.procedure,
    'Switch case': context.caseLabel,
    Block: blockName,
    'Block (original name)': englishName && englishName !== name ? name : '',
    'Standard block': isStandard ? `yes (${attr(block, 'shortname')} v${attr(block, 'version')})` : 'no',
    Category: textOf(block, 'CATEGORY'),
    'Logical link': textOf(block, 'LOGICAL-LINK'),
    'Diagnostic session': textOf(block, 'DIAGNOSTIC-SESSION'),
    'P relevant': yesNo(attr(block, 'P-relevant')),
    'KD relevant': yesNo(attr(block, 'KD-relevant')),
    Optional: yesNo(attr(block, 'optional')),
  })
  const units = collectStepUnits(block)

  state.stats.blocks += 1
  state.stats.steps += units.length

  if (isStandard) {
    state.stats.standardBlocks += 1
  }

  if (units.length) {
    state.stats.blocksWithSteps += 1
  }

  const baseLabels = [
    'ib1',
    `ecu-${state.ecuId}`,
    ...(isStandard ? ['standard-block'] : []),
    ...(isOptional ? ['optional'] : []),
    ...options.extraLabels,
  ]

  if (options.granularity === 'step' && units.length) {
    units.forEach((unit) => {
      const stepElement = unit.element
      const isHmi = stepElement.nodeName === 'HMI-STEP'
      const stepName = singleLine(textOf(stepElement, 'NAME')) || (isHmi ? 'HMI step' : 'Step')
      const stepPath = [...blockPath, ...unit.loops.map((loop) => `Loop: ${loop}`), stepName]

      pushTicket(state, {
        ibKey: makeIbKey(state, stepElement, stepPath),
        sourceId: attr(stepElement, 'id'),
        kind: isHmi ? 'hmi-step' : 'step',
        issueType: options.childIssueType,
        summary: `[${blockTitle}] ${stepName}`,
        labels: sanitizeLabels([...baseLabels, 'ib1-step', ...(isHmi ? ['hmi'] : [])]),
        path: stepPath,
        blockKey,
        blockName: blockTitle,
        fields: cleanFields({
          ...blockFields,
          Step: stepName,
          'Step type': isHmi ? 'HMI step (worker interaction)' : 'Diagnostic step',
          Action: describeStepAction(stepElement),
          'Runs inside': unit.loops.join(' > '),
          Cyclic: yesNo(attr(stepElement, 'cyclic')),
        }),
        sections: [
          ...ibSourceSections(state, blockFields, unit.loops),
          ...stepSections(stepElement, state),
          ...(unit.notes.length
            ? [{ kind: 'list' as const, title: 'Conditional handling', items: unit.notes }]
            : []),
        ],
      })
    })

    return
  }

  const blockSections: DescriptionSection[] = [...ibSourceSections(state, blockFields, [])]
  const blockDescription = textOf(block, 'DESC')

  if (blockDescription) {
    blockSections.push({ kind: 'text', title: 'Block description', text: blockDescription })
  }

  const parameterRows = childElements(child(block, 'PARAMETERS'), 'PARAMETER').map((parameter) => [
    textOf(parameter, 'KEY'),
    textOf(parameter, 'VALUE'),
    textOf(parameter, 'DEFAULT'),
    textOf(parameter, 'DATATYPE'),
    yesNo(attr(parameter, 'optional')),
  ])

  if (parameterRows.length) {
    blockSections.push({
      kind: 'table',
      title: 'Block parameters',
      headers: ['Key', 'Value', 'Default', 'Datatype', 'Optional'],
      rows: parameterRows,
    })
  }

  if (units.length) {
    blockSections.push({
      kind: 'table',
      title: 'Steps',
      headers: ['#', 'Step', 'Action', 'Runs inside'],
      rows: units.map((unit, index) => [
        String(index + 1),
        singleLine(textOf(unit.element, 'NAME')),
        describeStepAction(unit.element),
        unit.loops.join(' > '),
      ]),
    })

    // Full per-step detail, so one block ticket carries everything a step ticket would have.
    units.forEach((unit, index) => {
      const isHmi = unit.element.nodeName === 'HMI-STEP'
      const stepName = singleLine(textOf(unit.element, 'NAME')) || (isHmi ? 'HMI step' : 'Step')
      const overview = cleanFields({
        'Step type': isHmi ? 'HMI step (worker interaction)' : 'Diagnostic step',
        Action: describeStepAction(unit.element),
        'Runs inside': unit.loops.join(' > '),
        Cyclic: yesNo(attr(unit.element, 'cyclic')),
      })

      blockSections.push(
        { kind: 'heading', title: `Step ${index + 1}: ${stepName}` },
        { kind: 'fields', rows: Object.entries(overview) },
        ...stepSections(unit.element, state),
        ...(unit.notes.length ? [{ kind: 'list' as const, title: 'Conditional handling', items: unit.notes }] : []),
      )
    })
  }

  const links = childElements(child(block, 'LINKS'), 'LINK')
    .map((link) => [textOf(link, 'NAME'), textOf(link, 'URL')].filter(Boolean).join(': '))
    .filter(Boolean)

  if (links.length) {
    blockSections.push({ kind: 'list', title: 'Links', items: links })
  }

  pushTicket(state, {
    ibKey: blockKey,
    sourceId: attr(block, 'id'),
    kind: 'block',
    issueType: options.childIssueType,
    summary: blockTitle,
    labels: sanitizeLabels([...baseLabels, 'ib1-block']),
    path: blockPath,
    blockKey,
    blockName: blockTitle,
    fields: cleanFields({ ...blockFields, Steps: String(units.length) }),
    sections: blockSections,
  })
}

function pushTicket(state: BuildState, ticket: PlannedTicket) {
  const summaryKey = ticket.summary.toLowerCase()
  const count = (state.usedSummaries.get(summaryKey) ?? 0) + 1

  state.usedSummaries.set(summaryKey, count)

  const summary = count > 1 ? `${ticket.summary} (${count})` : ticket.summary

  state.tickets.push({ ...ticket, summary: truncate(summary, MAX_SUMMARY_LENGTH) })
}

function collectStepUnits(block: XmlNode): StepUnit[] {
  const result = collectFromContainer(child(block, 'STEPS'), [])

  if (result.pendingNotes.length) {
    result.units.forEach((unit) => unit.notes.push(...result.pendingNotes))
  }

  return result.units
}

// Steps nested in BRANCH/IF are exception paths (e.g. "Abort button actuated"), so they are folded into
// notes on the surrounding steps instead of becoming tickets of their own.
function collectFromContainer(
  container: XmlNode | null,
  loops: string[],
): { units: StepUnit[]; pendingNotes: string[] } {
  const units: StepUnit[] = []
  const directUnits: StepUnit[] = []
  const notes: string[] = []

  childElements(container).forEach((element) => {
    if (STEP_TAGS.has(element.nodeName)) {
      const unit: StepUnit = { element, loops, notes: [] }

      units.push(unit)
      directUnits.push(unit)
    } else if (element.nodeName === 'LOOP') {
      const loopName = singleLine(textOf(element, 'NAME')) || 'Loop'
      const loopDetails = [
        textOf(element, 'POLLINTERVALL') ? `poll ${textOf(element, 'POLLINTERVALL')} ms` : '',
        textOf(element, 'TIMEOUT') ? `timeout ${textOf(element, 'TIMEOUT')} ms` : '',
      ].filter(Boolean)
      const loopLabel = loopDetails.length ? `${loopName} (${loopDetails.join(', ')})` : loopName
      const nested = collectFromContainer(child(element, 'STEPS') ?? element, [...loops, loopLabel])

      units.push(...nested.units)
      notes.push(...nested.pendingNotes)
    } else if (CONDITIONAL_TAGS.has(element.nodeName)) {
      notes.push(describeConditional(element))
    }
  })

  if (notes.length && directUnits.length) {
    directUnits.forEach((unit) => unit.notes.push(...notes))

    return { units, pendingNotes: [] }
  }

  return { units, pendingNotes: notes }
}

function describeConditional(element: XmlNode): string {
  const kind = element.nodeName === 'BRANCH' ? 'Branch' : element.nodeName
  const name = singleLine(textOf(element, 'NAME')) || kind
  const nestedSteps = descendants(element)
    .filter((node) => STEP_TAGS.has(node.nodeName))
    .map((node) => singleLine(textOf(node, 'NAME')))
    .filter(Boolean)
  const description = firstParagraph(textOf(element, 'DESC'))
  const parts = [`${kind} "${name}"`]

  if (description && description !== name) {
    parts.push(description)
  }

  if (nestedSteps.length) {
    parts.push(`runs: ${Array.from(new Set(nestedSteps)).join(', ')}`)
  }

  return parts.join(' - ')
}

function ibSourceSections(
  state: BuildState,
  blockFields: Record<string, string>,
  loops: string[],
): DescriptionSection[] {
  const { source } = state

  return [
    {
      kind: 'fields',
      title: 'IB1 source',
      rows: Object.entries(
        cleanFields({
          'IB1 document': `${source.ibName}${source.version ? ` v${source.version}` : ''}`,
          'Release date': source.releaseDate,
          ECU: state.ecuId,
          ...blockFields,
          'Runs inside': loops.join(' > '),
        }),
      ),
    },
  ]
}

function stepSections(step: XmlNode, state: BuildState): DescriptionSection[] {
  const sections: DescriptionSection[] = []
  const description = textOf(step, 'DESC')
  const stepName = textOf(step, 'NAME')

  if (description && description !== stepName) {
    sections.push({ kind: 'text', title: 'Step description', text: description })
  }

  const request = child(step, 'RESTFUL-API-REQUEST')

  if (request) {
    sections.push({
      kind: 'fields',
      title: 'REST request',
      rows: Object.entries(
        cleanFields({ Method: textOf(request, 'METHOD'), URI: textOf(request, 'URI') }),
      ),
    })

    const input = textOf(request, 'INPUT')
    const output = textOf(request, 'OUTPUT')

    if (input) {
      sections.push({ kind: 'code', title: 'Request body', language: 'json', code: prettyJson(input) })
    }

    if (output) {
      sections.push({ kind: 'code', title: 'Expected output', language: 'json', code: prettyJson(output) })
    }
  }

  const service = child(step, 'DIAG-SERVICE')
  const diagParameters = child(step, 'DIAG-PARAMETERS')
  const dataIdentifier = textOf(diagParameters, 'DATA-IDENTIFIER')

  if (service || dataIdentifier) {
    const serviceId = textOf(service, 'SERVICE-IDENTIFIER')

    sections.push({
      kind: 'fields',
      title: 'Diagnostic service',
      rows: Object.entries(
        cleanFields({
          'Service ID': serviceId ? `0x${serviceId.replace(/^0x/i, '')}` : '',
          Service: textOf(service, 'LONG-NAME'),
          'Service short name': textOf(service, 'SHORT-NAME'),
          'Data identifier': dataIdentifier ? `0x${dataIdentifier.replace(/^0x/i, '')}` : '',
        }),
      ),
    })
  }

  const parameterRows = childElements(diagParameters, 'DIAG-PARAMETER').map((parameter) => [
    textOf(parameter, 'MESSAGE-TYPE'),
    textOf(parameter, 'LONG-NAME') || textOf(parameter, 'SHORT-NAME'),
    resolveValue(child(parameter, 'VALUE-PROXY'), state),
    textOf(parameter, 'DATATYPE'),
  ])

  if (parameterRows.length) {
    sections.push({
      kind: 'table',
      title: 'Diagnostic parameters',
      headers: ['Message', 'Parameter', 'Value', 'Datatype'],
      rows: parameterRows,
    })
  }

  const timeParameter = child(step, 'TIME-PARAMETER')

  if (timeParameter) {
    sections.push({
      kind: 'fields',
      title: 'Wait time',
      rows: Object.entries(
        cleanFields({
          'Value (ms)': resolveValue(child(timeParameter, 'VALUE-PROXY'), state),
          Description: textOf(timeParameter, 'DESC'),
        }),
      ),
    })
  }

  const hmiRows = childElements(child(step, 'HMI-PARAMETERS'), 'HMI-PARAMETER').map((parameter) => [
    textOf(parameter, 'KEY'),
    resolveValue(child(parameter, 'VALUE-PROXY'), state) || textOf(parameter, 'VALUE'),
    attr(parameter, 'type'),
  ])

  if (hmiRows.length) {
    sections.push({
      kind: 'table',
      title: 'HMI parameters',
      headers: ['Key', 'Value', 'Direction'],
      rows: hmiRows,
    })
  }

  const testInstructions = childElements(child(step, 'TIS'), 'TI')
    .map((ti) => normalizeText(ti.textContent))
    .filter(Boolean)

  if (testInstructions.length) {
    sections.push({ kind: 'list', title: 'Test instructions (TI)', items: testInstructions })
  }

  return sections
}

function describeStepAction(step: XmlNode): string {
  if (step.nodeName === 'HMI-STEP') {
    const outputText = childElements(child(step, 'HMI-PARAMETERS'), 'HMI-PARAMETER')
      .map((parameter) => textOf(child(parameter, 'VALUE-PROXY'), 'VALUE') || textOf(parameter, 'VALUE'))
      .find(Boolean)

    return outputText ? `HMI: ${truncate(singleLine(outputText), 80)}` : 'HMI interaction'
  }

  const request = child(step, 'RESTFUL-API-REQUEST')

  if (request) {
    const endpoint = textOf(request, 'URI').replace(/^https?:\/\/[^/]+/i, '')

    return `REST ${textOf(request, 'METHOD') || 'call'} ${endpoint}`.trim()
  }

  const service = child(step, 'DIAG-SERVICE')

  if (service) {
    const dataIdentifier = textOf(child(step, 'DIAG-PARAMETERS'), 'DATA-IDENTIFIER')
    const serviceName = textOf(service, 'LONG-NAME').split(' / ')[0]
    const serviceId = textOf(service, 'SERVICE-IDENTIFIER').replace(/^0x/i, '')

    return [
      serviceId ? `UDS 0x${serviceId}` : 'UDS',
      serviceName,
      dataIdentifier ? `DID 0x${dataIdentifier.replace(/^0x/i, '')}` : '',
    ]
      .filter(Boolean)
      .join(' ')
  }

  const timeParameter = child(step, 'TIME-PARAMETER')

  if (timeParameter) {
    const value = textOf(child(timeParameter, 'VALUE-PROXY'), 'VALUE')

    return value ? `Wait ${value} ms` : 'Wait (time from block parameter)'
  }

  return 'Manual / descriptive step'
}

function resolveValue(valueProxy: XmlNode | null, state: BuildState): string {
  if (!valueProxy) {
    return ''
  }

  const directValue = textOf(valueProxy, 'VALUE')

  if (directValue) {
    return directValue
  }

  const reference = attr(child(valueProxy, 'VALUE-REF'), 'ref')

  if (!reference) {
    return ''
  }

  const parameter = state.parameters.get(reference)

  if (!parameter) {
    return `(unresolved reference ${reference})`
  }

  const value = textOf(parameter, 'VALUE') || textOf(parameter, 'DEFAULT')

  return `${value || '?'} (block parameter "${textOf(parameter, 'KEY')}")`
}

function buildEcu(
  root: XmlNode,
  source: PlanSource,
  options: JiraPlanOptions,
  notices: Notices,
): PlannedEcu {
  const diagInfos = childElements(child(root, 'DIAG-INFOS'), 'DIAG-INFO')
  const ecuIds = diagInfos.map((info) => textOf(info, 'ECU-ID')).filter(Boolean)
  const primaryInfo = diagInfos[0] ?? null
  let ecuId = ecuIds[0] ?? ''

  if (!ecuId) {
    ecuId = /^(?:IB1_)?([0-9A-F]{4})_/i.exec(source.ibName)?.[1] ?? 'unknown'
    flag(notices, `No DIAG-INFO ECU-ID was found; using "${ecuId}" from the IB1 name to identify the ECU.`)
  }

  if (new Set(ecuIds).size > 1) {
    flag(
      notices,
      `This IB1 lists several ECU IDs (${Array.from(new Set(ecuIds)).join(', ')}). Tickets are assigned to ${ecuId}.`,
    )
  }

  const pdx = child(primaryInfo, 'PDX')
  const odxNames = descendants(pdx)
    .filter((node) => node.nodeName === 'ODX')
    .map((odx) => [textOf(odx, 'NAME'), textOf(odx, 'DESC')].filter(Boolean).join(' - '))
    .filter(Boolean)
  const ibDescription = child(root, 'IB-DESCRIPTION')
  const slaves = childElements(child(ibDescription, 'SLAVES'), 'SLAVE').map((slave) => ({
    name: textOf(slave, 'NAME'),
    ecuId: textOf(slave, 'ECU-ID'),
  }))
  const objectives = childElements(child(ibDescription, 'OBJECTIVES'))
    .map((objective) => normalizeText(objective.textContent))
    .filter(Boolean)
  const fields = cleanFields({
    'Diag Address': ecuId,
    'Diagnostic Address': /^[0-9A-F]+$/i.test(ecuId) ? `0x${ecuId}` : '',
    'ECU description': textOf(primaryInfo, 'DESC'),
    'Diagnostic protocol': textOf(primaryInfo, 'DIAG-PROTOCOL'),
    'Transport protocol': textOf(primaryInfo, 'TRANSPORT-PROTOCOL'),
    PDX: textOf(pdx, 'NAME'),
    'IB1 document': source.ibName,
    'IB1 version': source.version,
    'IB1 release date': source.releaseDate,
  })
  const sections: DescriptionSection[] = [{ kind: 'fields', title: 'IB1 source', rows: Object.entries(fields) }]

  if (objectives.length) {
    sections.push({ kind: 'list', title: 'Objectives', items: objectives })
  }

  if (odxNames.length) {
    sections.push({ kind: 'list', title: 'ODX files', items: odxNames })
  }

  if (slaves.length) {
    sections.push({
      kind: 'table',
      title: 'Slave ECUs',
      headers: ['Name', 'ECU ID'],
      rows: slaves.map((slave) => [slave.name, slave.ecuId]),
    })
  }

  return {
    ecuId,
    issueType: options.ecuIssueType,
    existingIssueKey: options.ecuIssueKey.trim(),
    summary: source.ibName,
    lookupJql: `project = ${options.projectKey} AND issuetype = "${options.ecuIssueType}" AND "Diag Address" ~ "${ecuId}"`,
    fields,
    slaves,
    sections,
  }
}

// IB1 UUIDs have been copied between sibling documents (see TSG revision notes), so keys are scoped to the ECU.
function makeIbKey(state: BuildState, element: XmlNode, path: string[]): string {
  const id = attr(element, 'id')
  let key = id
    ? `ib1:${state.ecuId}:${id}`
    : `ib1:${state.ecuId}:path:${path.map((part) => normalizeKeyPart(part)).join('/')}`

  if (!id) {
    flag(state, `"${path.at(-1)}" has no id attribute; its sync key is based on its position.`)
  }

  const seen = state.usedKeys.get(key) ?? 0

  state.usedKeys.set(key, seen + 1)

  if (seen > 0) {
    flag(state, `Duplicate IB1 id ${id || key} at "${path.join(' / ')}"; a suffix was added.`)
    key = `${key}#${seen + 1}`
  }

  return key
}

function collectParameters(root: XmlNode): Map<string, XmlNode> {
  const parameters = new Map<string, XmlNode>()

  descendants(root)
    .filter((node) => node.nodeName === 'PARAMETER' || node.nodeName === 'HMI-PARAMETER')
    .forEach((parameter) => {
      const id = attr(parameter, 'id')

      if (id) {
        parameters.set(id, parameter)
      }
    })

  return parameters
}

function findIbRoot(node: XmlNode): XmlNode | null {
  if (node.nodeType === ELEMENT_NODE && node.nodeName === 'IB-1') {
    return node
  }

  return childElements(node).find((element) => element.nodeName === 'IB-1') ?? null
}

function childElements(node: XmlNode | null | undefined, tagName?: string): XmlNode[] {
  if (!node) {
    return []
  }

  const elements: XmlNode[] = []

  for (let index = 0; index < node.childNodes.length; index += 1) {
    const childNode = node.childNodes[index]

    if (childNode.nodeType === ELEMENT_NODE && (!tagName || childNode.nodeName === tagName)) {
      elements.push(childNode)
    }
  }

  return elements
}

function descendants(node: XmlNode | null | undefined): XmlNode[] {
  return childElements(node).flatMap((element) => [element, ...descendants(element)])
}

function child(node: XmlNode | null | undefined, tagName: string): XmlNode | null {
  return childElements(node, tagName)[0] ?? null
}

function textOf(node: XmlNode | null | undefined, tagName: string): string {
  return normalizeText(child(node, tagName)?.textContent)
}

function attr(node: XmlNode | null | undefined, name: string): string {
  return node?.getAttribute?.(name)?.trim() ?? ''
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function firstParagraph(value: string): string {
  return singleLine(value.split(/\n-{3,}\n/)[0] ?? '')
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function prettyJson(value: string): string {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

function yesNo(value: string): string {
  if (value === 'true') {
    return 'yes'
  }

  if (value === 'false') {
    return 'no'
  }

  return value
}

function cleanFields(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value && value.trim()))
}

function sanitizeLabels(labels: string[]): string[] {
  return Array.from(new Set(labels.map((label) => label.trim().replace(/\s+/g, '-')).filter(Boolean)))
}

function normalizeKeyPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}
