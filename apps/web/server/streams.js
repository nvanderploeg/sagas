/** @import { ServerResponse } from 'node:http' */

// Event streams never end on their own: shutdown must destroy them, or server.close() waits out
// its deadline.
export function eventStreams() {
	/** @type {Set<ServerResponse>} */
	const open = new Set();
	return {
		/** @param {ServerResponse} res */
		track(res) {
			open.add(res);
			res.once('close', () => open.delete(res));
		},
		closeAll() {
			for (const res of open) {
				const type = String(res.getHeader('content-type') ?? '');
				if (type.startsWith('text/event-stream')) res.destroy();
			}
		}
	};
}
