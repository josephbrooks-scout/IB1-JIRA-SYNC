import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { serveLocalBaseline } from './scripts/localBaseline.ts'

export default defineConfig({
  base: './',
  // Jira credentials belong to the local CLI, never to the browser build.
  envDir: false,
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/jira-baseline.local.json'] },
  },
  plugins: [react(), {
    name: 'private-local-jira-baseline',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        void serveLocalBaseline(req, res).then(handled => { if (!handled) next() }).catch(next)
      })
    },
  }],
})
