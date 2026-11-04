import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { validateBaseline } from '../src/jira/baseline.ts'

export const BASELINE_PATH = new URL('../jira-baseline.local.json', import.meta.url)

export async function serveLocalBaseline(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.url?.split('?')[0] !== '/api/offline-baseline') return false
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  const remote = req.socket.remoteAddress
  const host = req.headers.host ?? ''
  const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)
  const origin = req.headers.origin
  if (!localHost || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')
    || (origin && origin !== `http://${host}`)
    || req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403)
    res.end(JSON.stringify({ error: 'The private baseline is available only on this computer.' }))
    return true
  }
  if (req.method !== 'GET') {
    res.writeHead(405)
    res.end(JSON.stringify({ error: 'Baseline requests must use GET.' }))
    return true
  }
  try {
    const text = await readFile(BASELINE_PATH, 'utf8')
    const baseline = validateBaseline(JSON.parse(text))
    res.end(JSON.stringify({ available: true, baseline }))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      res.end(JSON.stringify({ available: false }))
    } else {
      console.error('Unable to read or validate the private Jira baseline. Check the local baseline file.')
      res.writeHead(500)
      res.end(JSON.stringify({ error: 'Unable to read or validate the private Jira baseline.' }))
    }
  }
  return true
}
