import tailwindcss from '@tailwindcss/vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import { buildInfo } from './build-info.ts';

export default defineConfig({
	define: buildInfo(),
	plugins: [
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// hooks.server.ts enforces this check itself (crossSiteFormRefusal); never turn it back on here.
			csrf: { trustedOrigins: ['*'] },
			// An inline script in app.html runs only with nonce="%sveltekit.nonce%".
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'data:'],
					'font-src': ['self'],
					'connect-src': ['self'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self', 'https://claude.ai', 'https://claude.com'],
					'frame-ancestors': ['none']
				}
			}
		})
	],
	test: {
		expect: { requireAssertions: true },
		environment: 'node',
		setupFiles: ['src/lib/server/test/setup.ts'],
		include: ['src/**/*.{test,spec}.{js,ts}', 'server/**/*.{test,spec}.js']
	}
});
