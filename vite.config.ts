import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: './',
  // Jira credentials belong to the local CLI, never to the browser build.
  envDir: false,
  plugins: [react()],
})
