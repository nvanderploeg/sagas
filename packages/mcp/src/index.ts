#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { optionsFromEnv } from './env.ts';
import { createHelper } from './server.ts';

const log = (message: string) => void process.stderr.write(`sagas-mcp: ${message}\n`);

// A broken stderr must not raise an error that is logged to stderr again.
process.stderr.on('error', () => {});

process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${String(reason)}`));
process.on('uncaughtException', (error) => log(`uncaught exception: ${error.message}`));

const options = optionsFromEnv(process.env, log);
if ('error' in options) {
	log(options.error);
	process.exit(1);
}

const helper = await createHelper(options);
let closing = false;
const shutdown = () => {
	if (closing) return;
	closing = true;
	void helper.close().finally(() => {
		process.exitCode = 0;
		setTimeout(() => process.exit(0), 1_000).unref();
	});
};
process.stdout.on('error', shutdown);
process.stdin.on('end', shutdown);
process.stdin.on('close', shutdown);
const signal = () => (closing ? process.exit(0) : shutdown());
process.on('SIGINT', signal);
process.on('SIGTERM', signal);

await helper.server.connect(new StdioServerTransport());
