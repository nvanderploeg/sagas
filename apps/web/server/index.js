import http from 'node:http';
import process from 'node:process';
import { protocolSource } from './protocol.js';
import { eventStreams } from './streams.js';

const protocol = protocolSource(process.env.PROTOCOL_HEADER);
process.env.PROTOCOL_HEADER = protocol.header;
const { handler } = await import('../build/handler.js');

const host = process.env.HOST || '0.0.0.0';
const port = Number(process.env.PORT || 3000);

const streams = eventStreams();

const server = http.createServer((req, res) => {
	protocol.apply(req);
	streams.track(res);
	handler(req, res, () => {
		res.statusCode = 404;
		res.end();
	});
});

server.listen({ host, port }, () => console.log(`Listening on http://${host}:${port}`));

for (const signal of ['SIGINT', 'SIGTERM']) {
	process.once(signal, () => {
		server.close(() => process.exit(0));
		server.closeIdleConnections();
		streams.closeAll();
		setTimeout(() => server.closeAllConnections(), 10_000).unref();
	});
}
