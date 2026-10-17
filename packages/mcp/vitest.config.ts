import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	resolve: {
		alias: {
			'@sagas/client': fileURLToPath(new URL('../client/src/index.ts', import.meta.url))
		}
	}
});
