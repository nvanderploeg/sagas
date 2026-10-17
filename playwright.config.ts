import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { databasePath, origin, port, runDir } from './e2e/support/env.ts';

export default defineConfig({
	testDir: 'e2e',
	testMatch: '**/*.e2e.ts',
	workers: 1,
	fullyParallel: false,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: [['list']],
	outputDir: 'test-results',
	globalTeardown: './e2e/support/teardown.ts',
	use: { baseURL: origin, trace: 'retain-on-failure' },
	projects: [
		{ name: 'setup', testMatch: 'setup.e2e.ts', use: { ...devices['Desktop Chrome'] } },
		{
			name: 'chromium',
			testIgnore: 'setup.e2e.ts',
			dependencies: ['setup'],
			use: { ...devices['Desktop Chrome'] }
		}
	],
	webServer: {
		command: 'pnpm --filter web build && node apps/web/server/index.js',
		url: `${origin}/setup`,
		reuseExistingServer: false,
		timeout: 240_000,
		stdout: 'ignore',
		stderr: 'pipe',
		env: {
			NODE_ENV: 'production',
			HOST: '127.0.0.1',
			PORT: String(port),
			DATABASE_PATH: databasePath,
			// Keep this missing: the e2e suite runs without the embedding model.
			EMBEDDING_MODEL_DIR: join(runDir, 'no-embedding-model'),
			STREAM_HEARTBEAT_MS: '300',
			ORIGIN: '',
			PROTOCOL_HEADER: '',
			HOST_HEADER: ''
		}
	}
});
