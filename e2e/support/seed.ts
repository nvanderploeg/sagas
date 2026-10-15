import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

export type SeedKit = typeof import('./seed-impl.ts');
export type { Db, IssuedToken, Seed } from './seed-impl.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

// The services import `#lib/*` and use `import.meta.glob`, so they load through Vite's SSR
// pipeline, the same one that builds the app. Nothing else in the app is loaded.
export async function loadSeedKit(): Promise<{ kit: SeedKit; close: () => Promise<void> }> {
	const server = await createServer({
		root: repoRoot,
		configFile: false,
		appType: 'custom',
		logLevel: 'error',
		server: { middlewareMode: true, hmr: false, watch: null, fs: { strict: false } },
		optimizeDeps: { noDiscovery: true, include: [] }
	});
	const kit = (await server.ssrLoadModule('/e2e/support/seed-impl.ts')) as SeedKit;
	return { kit, close: () => server.close() };
}
