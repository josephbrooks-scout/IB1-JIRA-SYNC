import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import { createJiraRestClient, JiraRequestError, type JiraApi, type JiraIssueRef } from '../src/jira/jiraClient.ts'
import { serveLocalBaseline } from './localBaseline.ts'

export const LOCAL_ORIGIN = 'http://localhost:5184'
export const CALLBACK_URL = `${LOCAL_ORIGIN}/auth/callback`
const SITE = 'https://scoutmotors.atlassian.net'
const SESSION_COOKIE = 'ib1_local_session'
const STATE_TTL = 10 * 60 * 1000
const SESSION_TTL = 60 * 60 * 1000
const MAX_ISSUES = 5000

type Session = {
  state?: string
  expiresAt: number
  accessToken?: string
  cloudId?: string
}

type ServerOptions = {
  clientId: string
  clientSecret: string
  distPath: string
  fetchImpl?: typeof fetch
  now?: () => number
  reportError?: (message: string) => void
}

class LocalError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function readTravellerHierarchy(jira: Pick<JiraApi, 'getIssue' | 'searchIssues'>) {
  const root = await jira.getIssue('PRDFSI-35')
  if (!root) throw new LocalError(404, 'PRDFSI-35 was not found or your account cannot access it.')
  const issues: JiraIssueRef[] = [root]
  const seen = new Set([root.key])
  let parents = [root.key]
  while (parents.length) {
    const next: string[] = []
    for (let offset = 0; offset < parents.length; offset += 50) {
      const keys = parents.slice(offset, offset + 50)
      if (keys.some(key => !/^PRDFSI-\d+$/.test(key))) {
        throw new LocalError(502, 'Jira returned an unexpected issue key in the Traveller hierarchy.')
      }
      const children = await jira.searchIssues(`project = PRDFSI AND parent in (${keys.join(',')}) ORDER BY key`)
      for (const child of children) {
        if (seen.has(child.key)) continue
        if (!child.fields.parent || !keys.includes(child.fields.parent.key)) {
          throw new LocalError(502, 'Jira returned an issue without its expected hierarchy parent.')
        }
        seen.add(child.key)
        issues.push(child)
        next.push(child.key)
        if (issues.length > MAX_ISSUES) {
          throw new LocalError(422, 'The hierarchy exceeds the 5,000-issue prototype limit. No partial result was returned.')
        }
      }
    }
    parents = next
  }
  return { rootKey: root.key, issues, fetchedAt: new Date().toISOString() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function equalState(left: string, right: string) {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function createLocalJiraServer(options: ServerOptions) {
  const sessions = new Map<string, Session>()
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const reportError = options.reportError ?? console.error
  const distPath = resolve(options.distPath)

  function json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  function cookie(res: ServerResponse, id: string, maxAge: number) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`)
  }

  async function oauthJson(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30000), redirect: 'error' })
    if (!response.ok) throw new LocalError(502, `Atlassian authorization request failed (${response.status}). Try connecting again.`)
    return response.json()
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    if (req.headers.host !== new URL(LOCAL_ORIGIN).host) throw new LocalError(403, 'Invalid local host.')
    if (req.headers.origin && req.headers.origin !== LOCAL_ORIGIN) throw new LocalError(403, 'Cross-origin access is not allowed.')
    if (await serveLocalBaseline(req, res)) return
    const url = new URL(req.url ?? '/', LOCAL_ORIGIN)
    for (const [id, session] of sessions) {
      if (session.expiresAt <= now()) sessions.delete(id)
    }
    const sessionId = req.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1)
    const session = sessionId ? sessions.get(sessionId) : undefined

    if (url.pathname === '/auth/login' && req.method === 'GET') {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new LocalError(403, 'Start sign-in from the local IB1 tool.')
      if (sessions.size >= 100) throw new LocalError(429, 'Too many local sign-in sessions. Restart the prototype to clear them.')
      if (sessionId) sessions.delete(sessionId)
      const id = randomBytes(32).toString('hex')
      const state = randomBytes(32).toString('hex')
      sessions.set(id, { state, expiresAt: now() + STATE_TTL })
      cookie(res, id, STATE_TTL / 1000)
      const target = new URL('https://auth.atlassian.com/authorize')
      target.search = new URLSearchParams({
        audience: 'api.atlassian.com', client_id: options.clientId,
        scope: 'read:jira-work', redirect_uri: CALLBACK_URL,
        state, response_type: 'code', prompt: 'consent',
      }).toString()
      res.writeHead(302, { Location: target.href })
      res.end()
      return
    }

    if (url.pathname === '/auth/callback' && req.method === 'GET') {
      if (!sessionId || !session?.state || !equalState(url.searchParams.get('state') ?? '', session.state)) {
        throw new LocalError(400, 'Invalid or expired OAuth state. Start sign-in again from the local tool.')
      }
      sessions.delete(sessionId)
      cookie(res, '', 0)
      if (url.searchParams.has('error')) throw new LocalError(400, 'Jira sign-in was denied or cancelled. No connection was established.')
      const code = url.searchParams.get('code')
      if (!code) throw new LocalError(400, 'Atlassian did not return an authorization code.')
      const token = await oauthJson('https://auth.atlassian.com/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code', client_id: options.clientId,
          client_secret: options.clientSecret, code, redirect_uri: CALLBACK_URL,
        }),
      })
      if (!isRecord(token) || typeof token.access_token !== 'string' || typeof token.expires_in !== 'number' || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
        throw new LocalError(502, 'Atlassian returned an invalid token response.')
      }
      const resources = await oauthJson('https://api.atlassian.com/oauth/token/accessible-resources', {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' },
      })
      if (!Array.isArray(resources)) throw new LocalError(502, 'Atlassian returned an invalid site list.')
      const site = resources.find((resource: unknown) => isRecord(resource) && resource.url === SITE && Array.isArray(resource.scopes) && resource.scopes.includes('read:jira-work'))
      if (!isRecord(site) || typeof site.id !== 'string' || !/^[a-zA-Z0-9-]+$/.test(site.id)) {
        throw new LocalError(403, 'Authorize access to scoutmotors.atlassian.net with read:jira-work to use this prototype.')
      }
      const id = randomBytes(32).toString('hex')
      const ttl = Math.min(token.expires_in * 1000, SESSION_TTL)
      sessions.set(id, { accessToken: token.access_token, cloudId: site.id, expiresAt: now() + ttl })
      cookie(res, id, Math.floor(ttl / 1000))
      res.writeHead(303, { Location: '/' })
      res.end()
      return
    }

    if (url.pathname === '/api/jira/session' && req.method === 'GET') {
      json(res, 200, { connected: Boolean(session?.accessToken), site: SITE, rootKey: 'PRDFSI-35' })
      return
    }
    if (url.pathname === '/api/jira/logout' && req.method === 'POST') {
      if (req.headers.origin !== LOCAL_ORIGIN) throw new LocalError(403, 'Logout requires a same-origin request.')
      if (sessionId) sessions.delete(sessionId)
      cookie(res, '', 0)
      json(res, 200, { connected: false })
      return
    }
    if (url.pathname === '/api/jira/hierarchy' && req.method === 'GET') {
      if (!session?.accessToken || !session.cloudId) throw new LocalError(401, 'Connect your Jira account first. Sessions expire after at most one hour.')
      const jira = createJiraRestClient({
        baseUrl: `https://api.atlassian.com/ex/jira/${session.cloudId}`,
        accessToken: session.accessToken,
      }, (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(30000), redirect: 'error' }))
      try {
        const hierarchy = await readTravellerHierarchy(jira)
        json(res, 200, hierarchy)
      } catch (error) {
        if (error instanceof JiraRequestError) {
          if (error.status === 401 && sessionId) sessions.delete(sessionId)
          throw new LocalError(error.status === 401 || error.status === 403 ? error.status : 502, `Jira read failed (${error.status}). Check your session, Jira permissions, and OAuth scopes.`)
        }
        throw error
      }
      return
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
      throw new LocalError(404, 'Unknown endpoint or unsupported method. This prototype has no Jira write endpoints.')
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new LocalError(405, 'Method not allowed.')
    const path = resolve(distPath, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`)
    if (!path.startsWith(`${distPath}${sep}`)) throw new LocalError(403, 'Invalid file path.')
    let content: Buffer
    try {
      content = await readFile(path)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new LocalError(404, 'Built application not found. Run npm run build before starting the local server.')
      }
      throw error
    }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
    res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' })
    res.end(req.method === 'HEAD' ? undefined : content)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      const status = error instanceof LocalError ? error.status : 500
      const message = error instanceof LocalError ? error.message : 'Local backend request failed. Check connectivity and restart sign-in if necessary.'
      reportError(`Local Jira backend: ${status} ${message}`)
      json(res, status, { error: message })
    })
  })
  server.on('close', () => sessions.clear())
  return server
}
