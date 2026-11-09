import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export type SeedKit = typeof import('./seed-impl.ts');
export type { Db, IssuedToken, Seed } from './seed-impl.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The services import `#lib/*` and use `import.meta.glob`, so they load through Vite's SSR
// pipeline, the same one that builds the app. Nothing else in the app is loaded.
// firebase-admin/auth is stubbed: Playwright's module hooks cannot load its jose dependency.
export function createSeedServer() {
	return createServer({
		root: repoRoot,
		configFile: false,
		appType: 'custom',
		logLevel: 'error',
		server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: false } },
		resolve: {
			alias: {
				'firebase-admin/auth': fileURLToPath(new URL('./firebase-auth-stub.ts', import.meta.url))
			}
		},
		optimizeDeps: { noDiscovery: true, include: [] }
	});
}

export async function loadSeedKit(): Promise<{ kit: SeedKit; close: () => Promise<void> }> {
	const server = await createSeedServer();
	const kit = (await server.ssrLoadModule('/e2e/support/seed-impl.ts')) as SeedKit;
	return { kit, close: () => server.close() };
}
