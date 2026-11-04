import { afterEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest, type Server } from 'node:http'
import { CALLBACK_URL, createLocalJiraServer, LOCAL_ORIGIN, readTravellerHierarchy } from '../scripts/localJiraServer.ts'
import { createJiraRestClient, type JiraIssueRef } from '../src/jira/jiraClient.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  })))
})

const issue = (key: string, parent?: string): JiraIssueRef => ({
  key, fields: { summary: key, ...(parent ? { parent: { key: parent } } : {}) },
})

async function setup(fetchImpl: typeof fetch = vi.fn(), now: () => number = Date.now) {
  const server = createLocalJiraServer({
    clientId: 'test-client', clientSecret: 'test-secret', distPath: '/nonexistent/ib1-dist',
    fetchImpl, now, reportError: vi.fn(),
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  const request = (path: string, init: RequestInit = {}) => new Promise<Response>((resolve, reject) => {
    const headers = new Headers({ Host: new URL(LOCAL_ORIGIN).host })
    new Headers(init.headers).forEach((value, key) => headers.set(key, value))
    const req = httpRequest(`http://127.0.0.1:${address.port}${path}`, {
      method: init.method ?? 'GET', headers: Object.fromEntries(headers),
    }, response => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('error', reject)
      response.on('end', () => {
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) value.forEach(item => responseHeaders.append(key, item))
          else if (value !== undefined) responseHeaders.set(key, value)
        }
        resolve(new Response(Buffer.concat(chunks).toString(), { status: response.statusCode, headers: responseHeaders }))
      })
    })
    req.on('error', reject)
    req.end()
  })
  return { request }
}

async function login(request: Awaited<ReturnType<typeof setup>>['request']) {
  const response = await request('/auth/login')
  expect(response.status).toBe(302)
  const location = new URL(response.headers.get('location') ?? '')
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('Missing session cookie')
  expect(location.origin).toBe('https://auth.atlassian.com')
  expect(location.searchParams.get('redirect_uri')).toBe(CALLBACK_URL)
  expect(location.searchParams.get('scope')).toBe('read:jira-work')
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Lax')
  return { cookie, state: location.searchParams.get('state') }
}

function mockAtlassian() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input)
    if (url === 'https://auth.atlassian.com/oauth/token') {
      return Response.json({ access_token: 'private-test-token', expires_in: 3600 })
    }
    if (url.endsWith('/accessible-resources')) {
      return Response.json([{ id: 'test-cloud', url: 'https://scoutmotors.atlassian.net', scopes: ['read:jira-work'] }])
    }
    if (url.includes('/issue/PRDFSI-35?')) return Response.json(issue('PRDFSI-35'))
    if (url.endsWith('/search/jql')) return Response.json({ issues: [] })
    throw new Error('Unexpected mocked endpoint')
  })
}

describe('local OAuth backend', () => {
  it('rejects invalid hosts, cross-origin requests, unauthenticated reads, and write endpoints', async () => {
    const { request } = await setup()
    expect((await request('/api/jira/session', { headers: { Host: 'attacker.example' } })).status).toBe(403)
    expect((await request('/api/jira/session', { headers: { Origin: 'https://attacker.example' } })).status).toBe(403)
    expect((await request('/auth/login', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403)
    expect((await request('/api/jira/hierarchy')).status).toBe(401)
    expect((await request('/api/jira/hierarchy', { method: 'POST' })).status).toBe(404)
    expect((await request('/api/jira/logout', { method: 'POST' })).status).toBe(403)
  })

  it('rejects missing, mismatched and expired OAuth state without exchanging tokens', async () => {
    let time = 0
    const atlassian = mockAtlassian()
    const { request } = await setup(atlassian, () => time)
    const { cookie, state } = await login(request)
    expect((await request(`/auth/callback?state=${state}&code=x`)).status).toBe(400)
    expect((await request('/auth/callback?state=bad&code=x', { headers: { Cookie: cookie } })).status).toBe(400)
    time = 10 * 60 * 1000 + 1
    expect((await request(`/auth/callback?state=${state}&code=x`, { headers: { Cookie: cookie } })).status).toBe(400)
    expect(atlassian).not.toHaveBeenCalled()
  })

  it('connects only the intended site, keeps tokens server-side, reads Jira, expires and disconnects', async () => {
    const atlassian = mockAtlassian()
    let time = 0
    const { request } = await setup(atlassian, () => time)
    const { cookie, state } = await login(request)
    const callback = await request(`/auth/callback?state=${state}&code=code`, { headers: { Cookie: cookie } })
    expect(callback.status).toBe(303)
    const connectedCookie = callback.headers.get('set-cookie')?.split(';')[0] ?? ''
    expect(connectedCookie).not.toBe(cookie)
    expect(connectedCookie).not.toContain('private-test-token')
    const status = await request('/api/jira/session', { headers: { Cookie: connectedCookie } })
    expect(await status.json()).toMatchObject({ connected: true })
    const hierarchy = await request('/api/jira/hierarchy', { headers: { Cookie: connectedCookie } })
    expect(hierarchy.status).toBe(200)
    expect(hierarchy.headers.get('cache-control')).toBe('no-store')
    expect(await hierarchy.json()).toMatchObject({ rootKey: 'PRDFSI-35', issues: [issue('PRDFSI-35')] })
    const jiraCall = atlassian.mock.calls.find(([input]) => String(input).includes('/issue/PRDFSI-35?'))
    expect(jiraCall?.[1]?.headers).toMatchObject({ Authorization: 'Bearer private-test-token' })
    expect((await request(`/auth/callback?state=${state}&code=code`, { headers: { Cookie: cookie } })).status).toBe(400)
    const logout = await request('/api/jira/logout', { method: 'POST', headers: { Origin: LOCAL_ORIGIN, Cookie: connectedCookie } })
    expect(logout.status).toBe(200)
    expect((await request('/api/jira/hierarchy', { headers: { Cookie: connectedCookie } })).status).toBe(401)
    const again = await login(request)
    const connected = await request(`/auth/callback?state=${again.state}&code=code`, { headers: { Cookie: again.cookie } })
    time = 3600 * 1000 + 1
    expect((await request('/api/jira/hierarchy', { headers: { Cookie: connected.headers.get('set-cookie')?.split(';')[0] ?? '' } })).status).toBe(401)
  })

  it('rejects a different Jira site instead of selecting the first OAuth resource', async () => {
    const atlassian = mockAtlassian()
    atlassian.mockImplementationOnce(async () => Response.json({ access_token: 'private-test-token', expires_in: 3600 }))
      .mockImplementationOnce(async () => Response.json([{ id: 'other', url: 'https://other.atlassian.net', scopes: ['read:jira-work'] }]))
    const { request } = await setup(atlassian)
    const { cookie, state } = await login(request)
    const response = await request(`/auth/callback?state=${state}&code=code`, { headers: { Cookie: cookie } })
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('private-test-token')
  })

  it('surfaces denial and upstream errors without leaking token response bodies', async () => {
    const atlassian = vi.fn<typeof fetch>(async () => Response.json({ error: 'private-test-token' }, { status: 500 }))
    const { request } = await setup(atlassian)
    const first = await login(request)
    const denied = await request(`/auth/callback?state=${first.state}&error=access_denied`, { headers: { Cookie: first.cookie } })
    expect(denied.status).toBe(400)
    expect(atlassian).not.toHaveBeenCalled()
    const second = await login(request)
    const failed = await request(`/auth/callback?state=${second.state}&code=x`, { headers: { Cookie: second.cookie } })
    expect(failed.status).toBe(502)
    expect(await failed.text()).not.toContain('private-test-token')
  })
})

describe('Traveller hierarchy', () => {
  it('follows all descendants with parent relationships and deduplicates results', async () => {
    const searchIssues = vi.fn(async (jql: string) => {
      if (jql.includes('(PRDFSI-35)')) return [issue('PRDFSI-90', 'PRDFSI-35')]
      if (jql.includes('(PRDFSI-90)')) return [issue('PRDFSI-91', 'PRDFSI-90'), issue('PRDFSI-91', 'PRDFSI-90')]
      if (jql.includes('(PRDFSI-91)')) return [issue('PRDFSI-92', 'PRDFSI-91')]
      return []
    })
    const result = await readTravellerHierarchy({ getIssue: async () => issue('PRDFSI-35'), searchIssues })
    expect(result.issues.map(value => value.key)).toEqual(['PRDFSI-35', 'PRDFSI-90', 'PRDFSI-91', 'PRDFSI-92'])
    expect(searchIssues).toHaveBeenCalledTimes(4)
  })

  it('reports inaccessible roots and malformed hierarchy responses', async () => {
    await expect(readTravellerHierarchy({ getIssue: async () => null, searchIssues: vi.fn() })).rejects.toThrow('not found')
    await expect(readTravellerHierarchy({
      getIssue: async () => issue('PRDFSI-35'),
      searchIssues: async () => [issue('PRDFSI-90')],
    })).rejects.toThrow('expected hierarchy parent')
  })

  it('fails explicitly instead of returning an over-limit partial hierarchy', async () => {
    await expect(readTravellerHierarchy({
      getIssue: async () => issue('PRDFSI-35'),
      searchIssues: async () => Array.from({ length: 5000 }, (_, index) => issue(`PRDFSI-${1000 + index}`, 'PRDFSI-35')),
    })).rejects.toThrow('5,000-issue')
  })

  it('preserves Jira search pagination and uses bearer authorization', async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ issues: [issue('PRDFSI-90', 'PRDFSI-35')], nextPageToken: 'next' }))
      .mockResolvedValueOnce(Response.json({ issues: [issue('PRDFSI-91', 'PRDFSI-35')] }))
    const client = createJiraRestClient({ baseUrl: 'https://api.atlassian.com/ex/jira/cloud', accessToken: 'token' }, fetchImpl)
    expect(await client.searchIssues('parent = PRDFSI-35')).toHaveLength(2)
    expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer token' })
    const body = JSON.parse(String(fetchImpl.mock.calls[1][1]?.body))
    expect(body.nextPageToken).toBe('next')
    expect(body.fields).toContain('parent')
  })
})
