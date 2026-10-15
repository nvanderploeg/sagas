import { expect, test } from './fixtures/index.ts';
import { connectMcp, uniqueProjectKey } from './fixtures/mcp.ts';
import { cookieHeader, getNoFollow } from './support/http.ts';
import { openStream, type Frame } from './support/stream.ts';

const CONTROL = new Set(['ready', 'reset']);
const isEvent = (f: Frame) => f.event !== undefined && !CONTROL.has(f.event);
const pings = (frames: Frame[]) => frames.filter((f) => f.comment === 'ping').length;
const types = (frames: Frame[]) => frames.filter(isEvent).map((f) => f.event);
const ids = (frames: Frame[]) => frames.filter(isEvent).map((f) => Number(f.id));
const eventCount = (n: number) => (frames: Frame[]) => frames.filter(isEvent).length >= n;
const ready = (frames: Frame[]) => frames.some((f) => f.event === 'ready');
const control = (event: 'ready' | 'reset', seq: number) => ({
	id: String(seq),
	event,
	data: JSON.stringify({ seq })
});

test.describe('GET /api/events', () => {
	test('opens as an event stream with ready carrying the last seq', async ({ apiToken, seed }) => {
		const last = seed.lastSeq();
		const stream = await openStream({ authorization: `Bearer ${apiToken.token}` });
		try {
			expect(stream.response.status).toBe(200);
			expect(stream.response.headers.get('content-type')).toBe('text/event-stream');
			expect(stream.response.headers.get('cache-control')).toContain('no-cache');
			const frames = await stream.until((f) => f.length >= 1);
			expect(frames[0]).toEqual(control('ready', last));
		} finally {
			await stream.close();
		}
	});

	test('sends heartbeat comments and no replay when no seq is given', async ({
		apiToken,
		seed
	}) => {
		seed.project();
		const stream = await openStream({ authorization: `Bearer ${apiToken.token}` });
		try {
			const frames = await stream.until((f) => pings(f) >= 2);
			expect(frames.filter(isEvent)).toEqual([]);
			expect(frames.filter((f) => f.event)).toEqual([control('ready', seed.lastSeq())]);
		} finally {
			await stream.close();
		}
	});

	test('replays every Event after ?since, in order, with the stored shape, then ready', async ({
		apiToken,
		seed,
		admin
	}) => {
		const before = seed.lastSeq();
		const project = seed.project({ key: `R${Date.now().toString(36).slice(-4)}`.toUpperCase() });
		const ticket = seed.ticket(project.id, { title: 'Replayed' });

		const stream = await openStream(
			{ authorization: `Bearer ${apiToken.token}` },
			`?since=${before}`
		);
		try {
			const frames = await stream.until(ready);
			expect(types(frames)).toEqual(['project.created', 'ticket.created']);
			expect(ids(frames)).toEqual([before + 1, before + 2]);
			expect(frames.filter((f) => f.event).at(-1)).toEqual(control('ready', before + 2));

			const created = JSON.parse(frames.find((f) => f.event === 'ticket.created')!.data!);
			expect(created).toMatchObject({
				seq: before + 2,
				type: 'ticket.created',
				actor: {
					id: admin.id,
					kind: 'human',
					username: admin.username,
					displayName: admin.displayName
				},
				data: {
					ticket: {
						id: ticket.id,
						projectId: project.id,
						key: `${project.key}-1`,
						title: 'Replayed',
						closed: false
					}
				}
			});
		} finally {
			await stream.close();
		}
	});

	test('a reconnect with Last-Event-ID replays exactly the Events after it', async ({
		apiToken,
		seed
	}) => {
		const headers = { authorization: `Bearer ${apiToken.token}` };
		const before = seed.lastSeq();
		const project = seed.project();
		seed.ticket(project.id, { title: 'one' });
		seed.ticket(project.id, { title: 'two' });

		const first = await openStream(headers, `?since=${before}`);
		const seen = await first.until(eventCount(3));
		await first.close();
		expect(ids(seen)).toEqual([before + 1, before + 2, before + 3]);

		const afterFirstTwo = await openStream({ ...headers, 'last-event-id': String(before + 2) });
		try {
			const frames = await afterFirstTwo.until(eventCount(1));
			expect(ids(frames)).toEqual([before + 3]);
			await afterFirstTwo.until((f) => pings(f) >= 1);
			expect(ids(afterFirstTwo.frames())).toEqual([before + 3]);
		} finally {
			await afterFirstTwo.close();
		}

		const caughtUp = await openStream({ ...headers, 'last-event-id': String(before + 3) });
		try {
			const frames = await caughtUp.until((f) => pings(f) >= 1);
			expect(frames.filter((f) => f.event)).toEqual([control('ready', before + 3)]);
		} finally {
			await caughtUp.close();
		}
	});

	test('Last-Event-ID wins over ?since', async ({ apiToken, seed }) => {
		const before = seed.lastSeq();
		const project = seed.project();
		seed.ticket(project.id);

		const stream = await openStream(
			{ authorization: `Bearer ${apiToken.token}`, 'last-event-id': String(before + 1) },
			`?since=${before}`
		);
		try {
			const frames = await stream.until(eventCount(1));
			await stream.until((f) => pings(f) >= 1);
			expect(ids(frames)).toEqual([before + 2]);
			expect(ids(stream.frames())).toEqual([before + 2]);
		} finally {
			await stream.close();
		}
	});

	test('a session cookie replays the same way', async ({ signedInPage: page, seed }) => {
		const before = seed.lastSeq();
		seed.project();

		const stream = await openStream(
			{ cookie: await cookieHeader(page.context()) },
			`?since=${before}`
		);
		try {
			const frames = await stream.until(eventCount(1));
			expect(types(frames)).toEqual(['project.created']);
		} finally {
			await stream.close();
		}
	});

	test('a browser EventSource gets the replay', async ({ signedInPage: page, seed }) => {
		const before = seed.lastSeq();
		const project = seed.project();
		seed.ticket(project.id);
		await page.goto('/');

		const received = await page.evaluate(
			(since) =>
				new Promise<string[]>((resolve, reject) => {
					const got: string[] = [];
					const source = new EventSource(`/api/events?since=${since}`);
					const done = () => {
						source.close();
						resolve(got);
					};
					for (const type of ['project.created', 'ticket.created']) {
						source.addEventListener(type, (e) => {
							got.push(`${e.type}:${(e as MessageEvent).lastEventId}`);
							if (got.length === 2) done();
						});
					}
					source.onerror = () => reject(new Error('EventSource failed'));
				}),
			before
		);

		expect(received).toEqual([`project.created:${before + 1}`, `ticket.created:${before + 2}`]);
	});

	test('rejects a seq that is not a non-negative integer with a 400', async ({
		request,
		apiToken
	}) => {
		const authorization = `Bearer ${apiToken.token}`;
		for (const query of ['?since=-1', '?since=abc', '?since=1.5']) {
			const response = await getNoFollow(request, `/api/events${query}`, { authorization });
			expect(response.status(), query).toBe(400);
			expect(response.headers()['content-type'], query).toContain('application/json');
		}
		const header = await getNoFollow(request, '/api/events', {
			authorization,
			'last-event-id': 'abc'
		});
		expect(header.status()).toBe(400);
	});

	test('sends reset with the newest seq when the seq is ahead of the server', async ({
		apiToken,
		seed
	}) => {
		seed.project();
		const last = seed.lastSeq();

		const stream = await openStream(
			{ authorization: `Bearer ${apiToken.token}` },
			`?since=${last + 1000}`
		);
		try {
			const frames = await stream.until(ready);
			expect(frames.filter((f) => f.event)).toEqual([
				control('reset', last),
				control('ready', last)
			]);
		} finally {
			await stream.close();
		}
	});

	test('goes live after a reset without replaying the log', async ({ apiToken, seed }) => {
		seed.project();
		const last = seed.lastSeq();

		const stream = await openStream(
			{ authorization: `Bearer ${apiToken.token}` },
			`?since=${last + 1000}`
		);
		try {
			await stream.until((f) => pings(f) >= 1);
			expect(stream.frames().filter((f) => f.event)).toEqual([
				control('reset', last),
				control('ready', last)
			]);
		} finally {
			await stream.close();
		}
	});

	// Write through /mcp: the bus is in-process, so a seeded write never reaches an open Stream.
	test('delivers a write made after the stream opened', async ({ apiToken }) => {
		const stream = await openStream({ authorization: `Bearer ${apiToken.token}` });
		const mcp = await connectMcp(apiToken.token);
		try {
			await stream.until(ready);
			const { project } = await mcp.ok('create_project', {
				name: 'Live',
				key: uniqueProjectKey()
			});
			const frames = await stream.until(eventCount(1));
			expect(frames.find(isEvent)).toMatchObject({ event: 'project.created' });
			expect(JSON.parse(frames.find(isEvent)!.data!).data.project.id).toBe(project.id);
		} finally {
			await mcp.close();
			await stream.close();
		}
	});

	test('replays the whole log from zero', async ({ apiToken, seed }) => {
		seed.project();
		const last = seed.lastSeq();

		const stream = await openStream({ authorization: `Bearer ${apiToken.token}` }, '?since=0');
		try {
			const frames = await stream.until((f) => ids(f).at(-1) === last);
			expect(ids(frames)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
		} finally {
			await stream.close();
		}
	});

	test.describe('after the log is pruned', () => {
		test.describe.configure({ mode: 'serial' });

		test('sends reset for a seq older than the oldest retained Event', async ({
			apiToken,
			seed
		}) => {
			seed.project();
			seed.pruneAllEvents();
			const last = seed.lastSeq();

			const stream = await openStream({ authorization: `Bearer ${apiToken.token}` }, '?since=0');
			try {
				const frames = await stream.until(ready);
				expect(frames.filter((f) => f.event)).toEqual([
					control('reset', last),
					control('ready', last)
				]);
			} finally {
				await stream.close();
			}
		});

		test('replays from the last assigned seq without a reset, and never reuses a seq', async ({
			apiToken,
			seed
		}) => {
			const last = seed.lastSeq();
			seed.project();

			const stream = await openStream(
				{ authorization: `Bearer ${apiToken.token}` },
				`?since=${last}`
			);
			try {
				const frames = await stream.until(eventCount(1));
				expect(types(frames)).toEqual(['project.created']);
				expect(ids(frames)).toEqual([last + 1]);
			} finally {
				await stream.close();
			}
		});
	});
});
