import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import {
	adminEmail,
	authHost,
	authPort,
	databaseUrl,
	firebaseProject,
	origin,
	port,
	runDir,
	serverUrl
} from './e2e/support/env.ts';

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
	projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
	webServer: [
		{
			command: `firebase emulators:start --only auth --project ${firebaseProject} --config e2e/support/firebase.json`,
			url: `http://${authHost}:${authPort}/`,
			reuseExistingServer: false,
			timeout: 60_000,
			stdout: 'ignore',
			stderr: 'pipe'
		},
		{
			command:
				'node e2e/support/prepare-db.mjs && pnpm --filter web build && node apps/web/server/index.js',
			url: `${origin}/login`,
			reuseExistingServer: false,
			timeout: 240_000,
			stdout: 'ignore',
			stderr: 'pipe',
			env: {
				NODE_ENV: 'production',
				HOST: '127.0.0.1',
				PORT: String(port),
				DATABASE_URL: databaseUrl,
				E2E_SERVER_URL: serverUrl,
				// Keep this missing: the e2e suite runs without the embedding model.
				EMBEDDING_MODEL_DIR: join(runDir, 'no-embedding-model'),
				STREAM_HEARTBEAT_MS: '300',
				ORIGIN: '',
				PROTOCOL_HEADER: '',
				HOST_HEADER: '',
				FIREBASE_PROJECT_ID: firebaseProject,
				FIREBASE_AUTH_EMULATOR_HOST: `${authHost}:${authPort}`,
				ADMIN_EMAILS: adminEmail
			}
		}
	]
});
