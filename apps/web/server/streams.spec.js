import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { eventStreams } from './streams.js';

/** @param {string} type */
function response(type) {
	const res = Object.assign(new EventEmitter(), {
		destroyed: false,
		getHeader: () => type,
		destroy() {
			res.destroyed = true;
			res.emit('close');
		}
	});
	return res;
}

describe('eventStreams', () => {
	it('destroys open event streams on closeAll and leaves other responses running', () => {
		const streams = eventStreams();
		const stream = response('text/event-stream');
		const page = response('text/html');
		streams.track(/** @type {any} */ (stream));
		streams.track(/** @type {any} */ (page));

		streams.closeAll();

		expect(stream.destroyed).toBe(true);
		expect(page.destroyed).toBe(false);
	});

	it('forgets a response once it closes', () => {
		const streams = eventStreams();
		const stream = response('text/event-stream');
		streams.track(/** @type {any} */ (stream));
		stream.emit('close');
		stream.destroy = () => {
			throw new Error('destroyed after close');
		};

		expect(() => streams.closeAll()).not.toThrow();
	});
});
