import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CALLBACK_URL, createLocalJiraServer, LOCAL_ORIGIN } from './localJiraServer.ts'

if (existsSync('.env.oauth.local')) process.loadEnvFile('.env.oauth.local')
const clientId = process.env.ATLASSIAN_CLIENT_ID
const clientSecret = process.env.ATLASSIAN_CLIENT_SECRET
if (!clientId?.trim() || !clientSecret?.trim() || clientId.startsWith('replace-with-') || clientSecret.startsWith('replace-with-')) {
  console.error('Missing or placeholder ATLASSIAN_CLIENT_ID or ATLASSIAN_CLIENT_SECRET. Replace both values in .env.oauth.local with the OAuth credentials from Atlassian Settings; never commit or share the secret.')
  process.exit(1)
}
const distPath = fileURLToPath(new URL('../dist/', import.meta.url))
if (!existsSync(`${distPath}/index.html`)) {
  console.error('Missing built application. Run npm run build first.')
  process.exit(1)
}
const server = createLocalJiraServer({ clientId, clientSecret, distPath })
server.on('error', (error) => {
  console.error(`Local Jira server failed: ${error.message}`)
  process.exitCode = 1
})
server.listen(5184, '127.0.0.1', () => {
  console.log(`Read-only Jira prototype: ${LOCAL_ORIGIN}`)
  console.log(`Register this exact OAuth callback: ${CALLBACK_URL}`)
  console.log('Loopback only. Tokens stay in memory and disappear on restart. No Jira writes are available.')
})
