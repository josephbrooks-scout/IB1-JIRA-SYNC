import { createServer, request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { serveLocalBaseline } from '../scripts/localBaseline.ts'
import { validateBaseline } from '../src/jira/baseline.ts'

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))
afterEach(() => vi.restoreAllMocks())

const baseline = {
  version: 'Traveller Jira baseline v1', snapshotDate: '2026-11-04', coverage: 'Root only; incomplete.',
  issues: [{ key: 'PRDFSI-35', id: '1', parentKey: '', summary: 'Synthetic root', description: '', issueType: 'Initiative', status: 'To Do', labels: [] }],
}

async function getBaseline(headers: Record<string, string> = {}) {
  const server = createServer((req, res) => {
    void serveLocalBaseline(req, res).catch(error => res.destroy(error))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP address')
  try {
    return await new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: address.port, path: '/api/offline-baseline', headers: { Host: `localhost:${address.port}`, ...headers } }, res => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', chunk => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body, cache: res.headers['cache-control'] }))
        res.on('error', reject)
      })
      req.on('error', reject)
      req.end()
    })
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('private local baseline', () => {
  it('validates version/date and strips non-comparison fields', () => {
    const parsed = validateBaseline({ ...baseline, issues: [{ ...baseline.issues[0], assignee: 'not retained' }] })
    expect(parsed).toEqual(baseline)
    expect(() => validateBaseline({ ...baseline, snapshotDate: '2026-02-30' })).toThrow('metadata')
    expect(() => validateBaseline({ ...baseline, version: '' })).toThrow('metadata')
    expect(() => validateBaseline({ ...baseline, issues: [] })).toThrow('PRDFSI-35')
    expect(() => validateBaseline({ ...baseline, issues: [baseline.issues[0], baseline.issues[0]] })).toThrow('duplicate')
  })

  it('serves versioned baseline locally with no caching', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(baseline))
    const result = await getBaseline()
    expect(result.status).toBe(200)
    expect(result.cache).toBe('no-store')
    expect(JSON.parse(result.body)).toEqual({ available: true, baseline })
  })

  it('blocks remote hosts, cross-origin and cross-site reads before reading the file', async () => {
    vi.mocked(readFile).mockClear()
    expect((await getBaseline({ Host: '192.168.1.1:5183' })).status).toBe(403)
    expect((await getBaseline({ Origin: 'https://other.example' })).status).toBe(403)
    expect((await getBaseline({ 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect(readFile).not.toHaveBeenCalled()
  })

  it('distinguishes an unconfigured baseline from invalid data', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    expect(JSON.parse((await getBaseline()).body)).toEqual({ available: false })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(readFile).mockResolvedValueOnce('invalid')
    const result = await getBaseline()
    expect(result.status).toBe(500)
    expect(JSON.parse(result.body)).toHaveProperty('error')
    expect(console.error).toHaveBeenCalled()
  })
})
