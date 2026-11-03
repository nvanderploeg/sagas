import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import boardHtml from './board.html?raw';

export const BOARD_URI = 'ui://sagas/board';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';

const resources = new Map<string, { listing: Resource; html: string }>([
	[
		BOARD_URI,
		{
			listing: {
				uri: BOARD_URI,
				name: 'Realm board',
				description: "A Realm's board, read-only",
				mimeType: APP_MIME_TYPE
			},
			html: boardHtml
		}
	]
]);

export const listUiResources = (): Resource[] => [...resources.values()].map((r) => r.listing);

export function readUiResource(uri: string) {
	const found = resources.get(uri);
	if (found === undefined) return undefined;
	return {
		contents: [
			{
				uri,
				mimeType: APP_MIME_TYPE,
				text: found.html,
				// No network: the view renders only the data the tool result hands it.
				_meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } } }
			}
		]
	};
}
