// Minimal Jira Cloud REST client used by the IB1 sync. Descriptions and comments use REST v2, which accepts
// wiki markup; search uses the v3 /search/jql endpoint that replaced the removed v2/v3 /search.

export type JiraIssueRef = {
  key: string
  fields: {
    summary?: string
    description?: unknown
    status?: { name: string }
    labels?: string[]
    issuetype?: { name: string }
    parent?: { key: string }
  }
  properties?: Record<string, unknown>
}

export type JiraTransition = {
  id: string
  name: string
  to: { name: string }
}

export type JiraField = {
  id: string
  name: string
}

export type JiraIssueProperty = {
  key: string
  value: unknown
}

export interface JiraApi {
  searchIssues(jql: string, properties?: string[]): Promise<JiraIssueRef[]>
  getIssue(key: string, properties?: string[]): Promise<JiraIssueRef | null>
  createIssue(fields: Record<string, unknown>, properties?: JiraIssueProperty[]): Promise<string>
  editIssue(key: string, fields: Record<string, unknown>, labelsToAdd?: string[]): Promise<void>
  setProperty(key: string, propertyKey: string, value: unknown): Promise<void>
  getTransitions(key: string): Promise<JiraTransition[]>
  transitionIssue(key: string, transitionId: string): Promise<void>
  addComment(key: string, body: string): Promise<void>
  getFields(): Promise<JiraField[]>
}

export type JiraConnection = {
  baseUrl: string
  email: string
  apiToken: string
} | {
  baseUrl: string
  accessToken: string
}

const ISSUE_FIELDS = ['summary', 'description', 'status', 'labels', 'issuetype', 'parent']
const MAX_ATTEMPTS = 4

export class JiraRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function createJiraRestClient(connection: JiraConnection, fetchImpl: typeof fetch = fetch): JiraApi {
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')
  const authorization = 'accessToken' in connection
    ? `Bearer ${connection.accessToken}`
    : `Basic ${btoa(`${connection.email}:${connection.apiToken}`)}`

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: authorization,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })

      if ((response.status === 429 || response.status >= 500) && attempt < MAX_ATTEMPTS) {
        const retryAfter = Number(response.headers.get('Retry-After'))
        const delayMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt

        await new Promise((resolve) => setTimeout(resolve, delayMs))
        continue
      }

      const text = await response.text()

      if (!response.ok) {
        throw new JiraRequestError(response.status, `Jira ${method} ${path} failed (${response.status}): ${summarizeError(text)}`)
      }

      return (text ? JSON.parse(text) : undefined) as T
    }
  }

  return {
    async searchIssues(jql, properties = []) {
      const issues: JiraIssueRef[] = []
      let nextPageToken: string | undefined

      do {
        const page = await request<{ issues: JiraIssueRef[]; nextPageToken?: string }>(
          'POST',
          '/rest/api/3/search/jql',
          { jql, fields: ISSUE_FIELDS, properties, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
        )

        issues.push(...page.issues)
        nextPageToken = page.nextPageToken
      } while (nextPageToken)

      return issues
    },

    async getIssue(key, properties = []) {
      const query = new URLSearchParams({ fields: ISSUE_FIELDS.join(',') })

      if (properties.length) {
        query.set('properties', properties.join(','))
      }

      try {
        return await request<JiraIssueRef>('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?${query}`)
      } catch (error) {
        if (error instanceof JiraRequestError && error.status === 404) {
          return null
        }

        throw error
      }
    },

    async createIssue(fields, properties = []) {
      const created = await request<{ key: string }>('POST', '/rest/api/2/issue', {
        fields,
        ...(properties.length ? { properties } : {}),
      })

      return created.key
    },

    async editIssue(key, fields, labelsToAdd = []) {
      await request('PUT', `/rest/api/2/issue/${encodeURIComponent(key)}?notifyUsers=false`, {
        fields,
        ...(labelsToAdd.length ? { update: { labels: labelsToAdd.map((label) => ({ add: label })) } } : {}),
      })
    },

    async setProperty(key, propertyKey, value) {
      await request(
        'PUT',
        `/rest/api/2/issue/${encodeURIComponent(key)}/properties/${encodeURIComponent(propertyKey)}`,
        value,
      )
    },

    async getTransitions(key) {
      const result = await request<{ transitions: JiraTransition[] }>(
        'GET',
        `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`,
      )

      return result.transitions
    },

    async transitionIssue(key, transitionId) {
      await request('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
        transition: { id: transitionId },
      })
    },

    async addComment(key, body) {
      await request('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body })
    },

    async getFields() {
      return request<JiraField[]>('GET', '/rest/api/2/field')
    },
  }
}

function summarizeError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { errorMessages?: string[]; errors?: Record<string, string> }
    const messages = [...(parsed.errorMessages ?? []), ...Object.entries(parsed.errors ?? {}).map(([field, message]) => `${field}: ${message}`)]

    return messages.join('; ') || text.slice(0, 300)
  } catch {
    return text.slice(0, 300)
  }
}
