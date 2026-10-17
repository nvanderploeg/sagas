import { describe, expect, it } from 'vitest';
import { optionsFromEnv } from './env.ts';

function parse(env: Record<string, string>) {
	const warnings: string[] = [];
	const options = optionsFromEnv({ SAGAS_URL: 'http://localhost:3290', ...env }, (message) =>
		warnings.push(message)
	);
	if ('error' in options) throw new Error(options.error);
	return { options, warnings };
}

describe('optionsFromEnv', () => {
	it('takes the defaults and trims the URL and token', () => {
		const { options, warnings } = parse({
			SAGAS_URL: '  http://localhost:3290 \n',
			SAGAS_TOKEN: ' sgs_abc\n'
		});
		expect(options).toEqual({
			url: 'http://localhost:3290',
			token: 'sgs_abc',
			pollMs: 60_000,
			sentimentMs: 300_000,
			callTimeoutMs: 120_000
		});
		expect(warnings).toEqual([]);
	});

	it('keeps 0 as off', () => {
		const { options } = parse({ SAGAS_POLL_MS: '0', SAGAS_SENTIMENT_MS: '0' });
		expect([options.pollMs, options.sentimentMs]).toEqual([0, 0]);
	});

	it('clamps intervals to 5 seconds through 1 day, and says so', () => {
		const { options, warnings } = parse({ SAGAS_POLL_MS: '1', SAGAS_SENTIMENT_MS: '1e12' });
		expect([options.pollMs, options.sentimentMs]).toEqual([5_000, 86_400_000]);
		expect(warnings).toHaveLength(2);
	});

	it('warns once for a value that is not a number and takes the default', () => {
		const { options, warnings } = parse({
			SAGAS_POLL_MS: 'soon',
			SAGAS_SENTIMENT_MS: '5m',
			SAGAS_CALL_TIMEOUT_MS: 'long'
		});
		expect([options.pollMs, options.sentimentMs, options.callTimeoutMs]).toEqual([
			60_000, 300_000, 120_000
		]);
		expect(warnings).toEqual([
			'SAGAS_POLL_MS is not a number (soon); using 60000',
			'SAGAS_SENTIMENT_MS is not a number (5m); using 300000',
			'SAGAS_CALL_TIMEOUT_MS is not a number from 1 to 2147483647 (long); using 120000'
		]);
	});

	it('takes a call timeout', () => {
		expect(parse({ SAGAS_CALL_TIMEOUT_MS: '30000' }).options.callTimeoutMs).toBe(30_000);
	});

	it('refuses a missing or broken URL', () => {
		expect(optionsFromEnv({}, () => {})).toEqual({ error: 'SAGAS_URL is not set' });
		expect(optionsFromEnv({ SAGAS_URL: 'nope' }, () => {})).toEqual({
			error: 'SAGAS_URL is not a URL: nope'
		});
	});
});
