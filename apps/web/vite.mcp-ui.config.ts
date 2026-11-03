import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig } from 'vite';

// Bundles each MCP App view to one HTML file the server imports with `?raw`.
export default defineConfig({
	root: 'mcp-ui/board',
	plugins: [viteSingleFile()],
	build: {
		outDir: '../../src/lib/server/mcp/ui',
		emptyOutDir: false,
		target: 'es2022',
		rollupOptions: { input: 'mcp-ui/board/index.html' }
	}
});
