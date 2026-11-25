import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/e2e',
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30_000,
  reporter: 'list',
  projects: [
    {
      name: 'smoke',
      testMatch: ['app.spec.ts', 'contract.spec.ts']
    },
    {
      name: 'screens',
      testMatch: ['screens/*.spec.ts']
    },
    {
      name: 'live',
      testMatch: ['live/*.spec.ts']
    }
  ]
})
