/** @import { IncomingMessage } from 'node:http' */

const SOCKET_PROTOCOL_HEADER = 'x-workload-socket-protocol';

// adapter-node assumes https when its protocol header is missing. Fill it on every request, or
// plain-http form POSTs fail the CSRF origin check and the session cookie turns Secure.
/** @param {string | undefined} forwarded the header a trusted reverse proxy sets, if any */
export function protocolSource(forwarded) {
	const trusted = forwarded?.trim().toLowerCase() ?? '';
	const header = trusted || SOCKET_PROTOCOL_HEADER;
	return {
		header,
		/** @param {Pick<IncomingMessage, 'headers'>} req */
		apply(req) {
			if (trusted && req.headers[trusted]) return;
			req.headers[header] = 'http';
		}
	};
}
