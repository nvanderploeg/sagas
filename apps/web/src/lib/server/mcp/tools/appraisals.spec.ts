import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import { createFirstAdmin, type AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { createMcpServer } from '../server.ts';

let db: Db;
let admin: AuthUser;
let bob: AuthUser;
const clients: Client[] = [];

beforeEach(async () => {
	db = testDb();
	admin = await createFirstAdmin(db, {
		username: 'root',
		displayName: 'Root',
		password: 'a long enough password'
	});
	bob = seedHuman(db, 'bob');
});

afterEach(async () => {
	vi.useRealTimers();
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

async function connect(actor: AuthUser): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor).connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
	return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const at = (day: number) => {
	vi.useFakeTimers({ toFake: ['Date'] });
	const now = new Date(Date.UTC(2030, 0, day));
	vi.setSystemTime(now);
	return now.toISOString();
};

const IMPACT = {
	key: 'impact',
	kind: 'scale',
	label: 'Impact',
	rubric: 'How much it matters',
	spec: { min: 1, max: 5 }
};

async function seed(client: Client, labourCount = 0, realm = { key: 'am', name: 'Atlas' }) {
	await ok(client, 'create_realm', realm);
	for (let i = 1; i <= labourCount; i++) {
		await ok(client, 'create_labour', { realm: realm.key, title: `Labour ${i}` });
	}
}

const appraise = (client: Client, ...labours: Record<string, unknown>[]) =>
	call(client, 'appraise', { labours });

const getAppraisal = (client: Client, labour: string | number) =>
	ok(client, 'get_appraisal', { labour });

const lastSeq = () => eventWindow(db).last;

describe('tool registration', () => {
	it('lists appraise as a write and the other two as reads, each with a closed input schema', async () => {
		const { tools } = await (await connect(admin)).listTools();

		for (const [name, readOnly] of [
			['appraise', false],
			['get_appraisal', true],
			['list_unappraised', true]
		] as const) {
			const tool = tools.find((t) => t.name === name);
			expect(tool, name).toBeDefined();
			expect(tool!.description, name).toBeTruthy();
			expect(tool!.inputSchema.additionalProperties, name).toBe(false);
			expect(tool!.annotations?.readOnlyHint, name).toBe(readOnly);
		}
	});

	it('does not offer `needs` anywhere in the appraise input', async () => {
		const { tools } = await (await connect(admin)).listTools();

		expect(JSON.stringify(tools.find((t) => t.name === 'appraise')!.inputSchema)).not.toContain(
			'needs'
		);
	});
});

describe('appraise', () => {
	it('answers with each Labour by key and whether it was stamped, in item order', async () => {
		const client = await connect(admin);
		await seed(client, 3);
		const { contentHash } = await getAppraisal(client, 'AM-2');

		const result = await appraise(
			client,
			{ labour: 'AM-3', brief: 'third' },
			{ labour: 'AM-2', stamp: contentHash },
			{ labour: 'AM-1', stamp: 'not the hash' }
		);

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			appraised: [
				{ labour: 'AM-3', stamped: false },
				{ labour: 'AM-2', stamped: true },
				{ labour: 'AM-1', stamped: false }
			]
		});
	});

	it('puts a summary line and then the result as JSON in the text', async () => {
		const client = await connect(admin);
		await seed(client, 1);

		const result = await appraise(client, { labour: 'AM-1', brief: 'x' });

		const [summary, ...rest] = text(result).split('\n');
		expect(summary).toBeTruthy();
		expect(JSON.parse(rest.join('\n'))).toEqual(result.structuredContent);
	});

	it('writes the whole agent layer as the calling User, readable with get_appraisal', async () => {
		const root = await connect(admin);
		await seed(root, 1);
		await seed(root, 1, { key: 'bl', name: 'Borealis' });
		await ok(root, 'define_attribute', { realm: 'AM', ...IMPACT });
		const client = await connect(bob);
		const now = at(5);
		const hash = sha256('{"title":"Labour 1","description":"","labels":[],"comments":[]}');

		const result = await appraise(client, {
			labour: 'AM-1',
			brief: '  Short and clear  ',
			refs: [{ href: 'https://example.com/spec', label: 'Spec' }, { href: 'src/a.ts' }],
			values: { impact: 4 },
			links: [{ type: 'evidence', to: 'BL-1', note: 'seen there' }],
			stamp: hash
		});

		expect(result.structuredContent).toEqual({ appraised: [{ labour: 'AM-1', stamped: true }] });
		expect(await getAppraisal(root, 'AM-1')).toEqual({
			labour: 'AM-1',
			brief: 'Short and clear',
			refs: [
				{ href: 'https://example.com/spec', label: 'Spec' },
				{ href: 'src/a.ts', label: null }
			],
			setBy: 'bob',
			setAt: now,
			contentHash: hash,
			stamp: { contentHash: hash, appraisedBy: 'bob', appraisedAt: now },
			unappraised: false,
			stale: false,
			values: [{ key: 'impact', kind: 'scale', value: 4, setBy: 'bob', setAt: now, stale: false }],
			links: [
				{ type: 'evidence', from: 'AM-1', to: 'BL-1', note: 'seen there', setBy: 'bob', setAt: now }
			],
			mentions: []
		});
	});

	it('names Labours given in any case, by Alias or by id', async () => {
		const client = await connect(admin);
		await seed(client, 1);
		await seed(client, 0, { key: 'bl', name: 'Borealis' });
		const { labour } = await ok(client, 'get_labour', { labour: 'AM-1' });
		await ok(client, 'move_labour', { labour: 'AM-1', realm: 'BL' });

		const byAlias = await appraise(client, { labour: 'am-1', brief: 'via alias' });
		const byId = await appraise(client, { labour: labour.id, brief: 'via id' });

		expect(byAlias.structuredContent).toEqual({ appraised: [{ labour: 'BL-1', stamped: false }] });
		expect(byId.structuredContent).toEqual({ appraised: [{ labour: 'BL-1', stamped: false }] });
		expect((await getAppraisal(client, 'bl-1')).brief).toBe('via id');
	});

	it('refuses a digit string where a Labour is named', async () => {
		const client = await connect(admin);
		await seed(client, 1);

		const result = await appraise(client, { labour: '1', brief: 'x' });

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('JSON number') }
		});
	});

	it('reports a Labour that does not exist as not_found', async () => {
		const client = await connect(admin);
		await seed(client, 1);

		expect(
			(await appraise(client, { labour: 'AM-9', brief: 'x' })).structuredContent
		).toMatchObject({ error: { code: 'not_found' } });
		expect((await appraise(client, { labour: 9999, brief: 'x' })).structuredContent).toMatchObject({
			error: { code: 'not_found' }
		});
	});

	it('records no Event and leaves the Labour updatedAt alone', async () => {
		const client = await connect(admin);
		await seed(client, 2);
		await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });
		const { labour: before } = await ok(client, 'get_labour', { labour: 'AM-1' });
		const seq = lastSeq();
		at(20);

		await ok(client, 'appraise', {
			labours: [
				{
					labour: 'AM-1',
					brief: 'b',
					refs: [{ href: 'r' }],
					values: { impact: 2 },
					links: [{ type: 'blocks', to: 'AM-2' }],
					stamp: 'whatever'
				}
			]
		});

		expect(lastSeq()).toBe(seq);
		const { labour: after } = await ok(client, 'get_labour', { labour: 'AM-1' });
		expect(after.updatedAt).toBe(before.updatedAt);
	});

	describe('batch limits', () => {
		it('refuses an empty batch as invalid', async () => {
			const client = await connect(admin);

			expect((await call(client, 'appraise', { labours: [] })).structuredContent).toMatchObject({
				error: { code: 'invalid' }
			});
		});

		it('accepts 50 Labours and refuses 51 as invalid, writing none of them', async () => {
			const client = await connect(admin);
			await seed(client, 51);
			const items = (n: number) =>
				Array.from({ length: n }, (_, i) => ({ labour: `AM-${i + 1}`, brief: 'b' }));

			const tooMany = await call(client, 'appraise', { labours: items(51) });
			expect(tooMany.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect((await getAppraisal(client, 'AM-1')).brief).toBe('');

			const fifty = await ok(client, 'appraise', { labours: items(50) });
			expect(fifty.appraised).toHaveLength(50);
		});

		it('refuses the same Labour twice, even named by key and by id, as invalid', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			const { labour } = await ok(client, 'get_labour', { labour: 'AM-1' });

			const result = await appraise(
				client,
				{ labour: 'AM-1', brief: 'one' },
				{ labour: labour.id, brief: 'two' }
			);

			expect(result.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect((await getAppraisal(client, 'AM-1')).brief).toBe('');
		});
	});

	describe('all or nothing', () => {
		it('writes none of an earlier item when a later one fails', async () => {
			const client = await connect(admin);
			await seed(client, 3);
			await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });
			const { contentHash } = await getAppraisal(client, 'AM-1');

			const result = await appraise(
				client,
				{
					labour: 'AM-1',
					brief: 'would stay',
					refs: [{ href: 'x' }],
					values: { impact: 3 },
					links: [{ type: 'evidence', to: 'AM-3' }],
					stamp: contentHash
				},
				{ labour: 'AM-2', brief: 'x'.repeat(401) }
			);

			expect(result.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect(await getAppraisal(client, 'AM-1')).toMatchObject({
				brief: '',
				refs: [],
				setBy: null,
				setAt: null,
				stamp: null,
				unappraised: true,
				values: [],
				links: []
			});
		});

		it('refuses a blocks cycle as conflict, naming the Labours by key', async () => {
			const client = await connect(admin);
			await seed(client, 2);
			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', links: [{ type: 'blocks', to: 'AM-2' }] }]
			});

			const result = await appraise(client, {
				labour: 'AM-2',
				links: [{ type: 'blocks', to: 'AM-1' }]
			});

			expect(result.structuredContent).toMatchObject({
				error: {
					code: 'conflict',
					message: expect.stringMatching(/AM-1[\s\S]*AM-2|AM-2[\s\S]*AM-1/)
				}
			});
		});

		it('refuses a cycle closed across the items of one batch', async () => {
			const client = await connect(admin);
			await seed(client, 2);

			const result = await appraise(
				client,
				{ labour: 'AM-1', links: [{ type: 'blocks', to: 'AM-2' }] },
				{ labour: 'AM-2', links: [{ type: 'blocks', to: 'AM-1' }] }
			);

			expect(result.structuredContent).toMatchObject({ error: { code: 'conflict' } });
			expect((await getAppraisal(client, 'AM-1')).links).toEqual([]);
		});
	});

	describe('fields', () => {
		it('clears the Brief and References with an empty string and an empty list', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', brief: 'b', refs: [{ href: 'x' }] }]
			});

			await ok(client, 'appraise', { labours: [{ labour: 'AM-1', brief: '', refs: [] }] });

			expect(await getAppraisal(client, 'AM-1')).toMatchObject({ brief: '', refs: [] });
		});

		it('refuses a Brief over 400 characters and more than 20 References as invalid', async () => {
			const client = await connect(admin);
			await seed(client, 1);

			const long = await appraise(client, { labour: 'AM-1', brief: 'b'.repeat(401) });
			const many = await appraise(client, {
				labour: 'AM-1',
				refs: Array.from({ length: 21 }, (_, i) => ({ href: `h${i}` }))
			});
			const duplicate = await appraise(client, {
				labour: 'AM-1',
				refs: [{ href: 'same' }, { href: 'same' }]
			});

			for (const result of [long, many, duplicate]) {
				expect(result.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			}
		});

		it('clears a value with null', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });
			await ok(client, 'appraise', { labours: [{ labour: 'AM-1', values: { impact: 2 } }] });

			await ok(client, 'appraise', { labours: [{ labour: 'AM-1', values: { impact: null } }] });

			expect((await getAppraisal(client, 'AM-1')).values).toEqual([]);
		});

		it('refuses an unknown Attribute key and an out-of-range value as invalid', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });

			const unknown = await appraise(client, { labour: 'AM-1', values: { nope: 1 } });
			const range = await appraise(client, { labour: 'AM-1', values: { impact: 6 } });

			expect(unknown.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect(range.structuredContent).toMatchObject({ error: { code: 'invalid' } });
		});

		it('still writes everything but the stamp when the stamp differs', async () => {
			const client = await connect(admin);
			await seed(client, 1);

			const result = await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', brief: 'lands', stamp: 'f'.repeat(64) }]
			});

			expect(result.appraised).toEqual([{ labour: 'AM-1', stamped: false }]);
			expect(await getAppraisal(client, 'AM-1')).toMatchObject({
				brief: 'lands',
				stamp: null,
				unappraised: true
			});
		});
	});

	describe('Links', () => {
		it('reads direction from to and from, naming both ends by key', async () => {
			const client = await connect(admin);
			await seed(client, 3);

			await ok(client, 'appraise', {
				labours: [
					{
						labour: 'AM-1',
						links: [
							{ type: 'evidence', to: 'am-2' },
							{ type: 'duplicates', from: 'AM-3', note: ' same bug ' }
						]
					}
				]
			});

			const { links } = await getAppraisal(client, 'AM-1');
			expect(links).toEqual([
				expect.objectContaining({ type: 'evidence', from: 'AM-1', to: 'AM-2', note: '' }),
				expect.objectContaining({ type: 'duplicates', from: 'AM-3', to: 'AM-1', note: 'same bug' })
			]);
			expect((await getAppraisal(client, 'AM-3')).links).toEqual(links.slice(1));
		});

		it('takes the other end as an id', async () => {
			const client = await connect(admin);
			await seed(client, 2);
			const { labour } = await ok(client, 'get_labour', { labour: 'AM-2' });

			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', links: [{ type: 'blocks', to: labour.id }] }]
			});

			expect((await getAppraisal(client, 'AM-1')).links).toMatchObject([
				{ type: 'blocks', from: 'AM-1', to: 'AM-2' }
			]);
		});

		it('stores relates with the lower id as from, whichever Labour names the other', async () => {
			const client = await connect(admin);
			await seed(client, 2);

			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-2', links: [{ type: 'relates', to: 'AM-1' }] }]
			});
			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', links: [{ type: 'relates', from: 'AM-2', note: 'both ways' }] }]
			});

			expect((await getAppraisal(client, 'AM-1')).links).toMatchObject([
				{ type: 'relates', from: 'AM-1', to: 'AM-2', note: 'both ways' }
			]);
		});

		it('keeps the note when re-added without one, and removes with remove', async () => {
			const client = await connect(admin);
			await seed(client, 2);
			const add = (extra: Record<string, unknown> = {}) =>
				ok(client, 'appraise', {
					labours: [{ labour: 'AM-1', links: [{ type: 'evidence', to: 'AM-2', ...extra }] }]
				});
			await add({ note: 'kept' });

			await add();
			expect((await getAppraisal(client, 'AM-1')).links).toMatchObject([{ note: 'kept' }]);

			await add({ remove: true });
			expect((await getAppraisal(client, 'AM-1')).links).toEqual([]);

			await add({ remove: true });
			expect((await getAppraisal(client, 'AM-1')).links).toEqual([]);
		});

		it('shows a Link under the current keys of its Labours after a move', async () => {
			const client = await connect(admin);
			await seed(client, 2);
			await seed(client, 0, { key: 'bl', name: 'Borealis' });
			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', links: [{ type: 'evidence', to: 'AM-2' }] }]
			});

			await ok(client, 'move_labour', { labour: 'AM-2', realm: 'BL' });

			expect((await getAppraisal(client, 'AM-1')).links).toMatchObject([
				{ from: 'AM-1', to: 'BL-1' }
			]);
		});

		it('refuses both ends, neither end and itself as invalid, and an unknown end as not_found', async () => {
			const client = await connect(admin);
			await seed(client, 2);
			const link = (entry: Record<string, unknown>) =>
				appraise(client, { labour: 'AM-1', links: [entry] });

			const both = await link({ type: 'evidence', to: 'AM-2', from: 'AM-2' });
			const neither = await link({ type: 'evidence' });
			const itself = await link({ type: 'evidence', to: 'AM-1' });
			const unknown = await link({ type: 'evidence', to: 'AM-9' });

			expect(both.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect(neither.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect(itself.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			expect(unknown.structuredContent).toMatchObject({ error: { code: 'not_found' } });
		});

		it('refuses a note over 500 characters as invalid', async () => {
			const client = await connect(admin);
			await seed(client, 2);

			const result = await appraise(client, {
				labour: 'AM-1',
				links: [{ type: 'evidence', to: 'AM-2', note: 'n'.repeat(501) }]
			});

			expect(result.structuredContent).toMatchObject({ error: { code: 'invalid' } });
		});
	});

	describe('unknown arguments', () => {
		it('refuses an unknown top-level argument, naming it', async () => {
			const client = await connect(admin);
			await seed(client, 1);

			const result = await call(client, 'appraise', {
				labours: [{ labour: 'AM-1', brief: 'x' }],
				verbose: true
			});

			expect(result.structuredContent).toMatchObject({
				error: { code: 'invalid', message: expect.stringContaining('verbose') }
			});
		});

		it('refuses needs on an item as an unknown argument', async () => {
			const client = await connect(admin);
			await seed(client, 1);

			const result = await appraise(client, { labour: 'AM-1', needs: [{ kind: 'x' }] });

			expect(result.structuredContent).toMatchObject({
				error: { code: 'invalid', message: expect.stringContaining('needs') }
			});
			expect((await getAppraisal(client, 'AM-1')).unappraised).toBe(true);
		});

		it('refuses an unknown key on an item, a Reference and a Link', async () => {
			const client = await connect(admin);
			await seed(client, 2);

			const item = await appraise(client, { labour: 'AM-1', mood: 'good' });
			const ref = await appraise(client, { labour: 'AM-1', refs: [{ href: 'x', title: 'y' }] });
			const link = await appraise(client, {
				labour: 'AM-1',
				links: [{ type: 'evidence', to: 'AM-2', weight: 3 }]
			});

			expect(item.structuredContent).toMatchObject({
				error: { code: 'invalid', message: expect.stringContaining('mood') }
			});
			expect(ref.structuredContent).toMatchObject({
				error: { code: 'invalid', message: expect.stringContaining('title') }
			});
			expect(link.structuredContent).toMatchObject({
				error: { code: 'invalid', message: expect.stringContaining('weight') }
			});
		});

		it('refuses a missing Labour, a missing href and an unknown Link type as invalid', async () => {
			const client = await connect(admin);
			await seed(client, 2);

			const noLabour = await appraise(client, { brief: 'x' });
			const noHref = await appraise(client, { labour: 'AM-1', refs: [{ label: 'x' }] });
			const badType = await appraise(client, {
				labour: 'AM-1',
				links: [{ type: 'causes', to: 'AM-2' }]
			});

			for (const result of [noLabour, noHref, badType]) {
				expect(result.structuredContent).toMatchObject({ error: { code: 'invalid' } });
			}
		});
	});
});

describe('get_appraisal', () => {
	it('reads a Labour with no agent layer', async () => {
		const client = await connect(admin);
		await seed(client, 1);
		const hash = sha256('{"title":"Labour 1","description":"","labels":[],"comments":[]}');

		expect(await getAppraisal(client, 'AM-1')).toEqual({
			labour: 'AM-1',
			brief: '',
			refs: [],
			setBy: null,
			setAt: null,
			contentHash: hash,
			stamp: null,
			unappraised: true,
			stale: false,
			values: [],
			links: [],
			mentions: []
		});
	});

	it('hashes the title, description, Labels and Comments', async () => {
		const client = await connect(admin);
		await seed(client);
		await ok(client, 'create_labour', {
			realm: 'AM',
			title: 'Fix login',
			description: 'Broken',
			labels: ['ui', 'bug']
		});
		await ok(client, 'add_comment', { labour: 'AM-1', body: 'one' });
		await ok(client, 'add_comment', { labour: 'AM-1', body: 'two' });

		const { contentHash } = await getAppraisal(client, 'AM-1');

		expect(contentHash).toBe(
			sha256(
				'{"title":"Fix login","description":"Broken","labels":["bug","ui"],"comments":["one","two"]}'
			)
		);
	});

	it('names Users by username and dates as ISO strings', async () => {
		const root = await connect(admin);
		await seed(root, 1);
		const now = at(9);
		await ok(await connect(bob), 'appraise', {
			labours: [
				{ labour: 'AM-1', refs: [{ href: 'x' }], stamp: (await getAppraisal(root, 1)).contentHash }
			]
		});

		const view = await getAppraisal(root, 'AM-1');

		expect(view.setBy).toBe('bob');
		expect(view.setAt).toBe(now);
		expect(view.stamp).toEqual({
			contentHash: view.contentHash,
			appraisedBy: 'bob',
			appraisedAt: now
		});
	});

	it('refuses an unknown Labour as not_found', async () => {
		const client = await connect(admin);

		const result = await call(client, 'get_appraisal', { labour: 'AM-1' });

		expect(result.structuredContent).toMatchObject({ error: { code: 'not_found' } });
	});

	it('refuses an unknown argument as invalid', async () => {
		const client = await connect(admin);
		await seed(client, 1);

		const result = await call(client, 'get_appraisal', { labour: 'AM-1', needs: true });

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('needs') }
		});
	});

	describe('staleness', () => {
		async function stampedLabour() {
			const client = await connect(admin);
			await seed(client, 1);
			const { contentHash } = await getAppraisal(client, 'AM-1');
			await ok(client, 'appraise', { labours: [{ labour: 'AM-1', stamp: contentHash }] });
			expect(await getAppraisal(client, 'AM-1')).toMatchObject({
				stale: false,
				unappraised: false
			});
			return { client, contentHash };
		}

		it.each<[string, (client: Client) => Promise<unknown>]>([
			['the title', (c) => ok(c, 'update_labour', { labour: 'AM-1', title: 'New' })],
			['the description', (c) => ok(c, 'update_labour', { labour: 'AM-1', description: 'New' })],
			['a Label', (c) => ok(c, 'update_labour', { labour: 'AM-1', add_labels: ['x'] })],
			['a Comment added', (c) => ok(c, 'add_comment', { labour: 'AM-1', body: 'hi' })]
		])('goes stale when %s changes', async (_name, change) => {
			const { client, contentHash } = await stampedLabour();

			await change(client);

			const view = await getAppraisal(client, 'AM-1');
			expect(view).toMatchObject({ stale: true, unappraised: false });
			expect(view.stamp.contentHash).toBe(contentHash);
			expect(view.contentHash).not.toBe(contentHash);
		});

		it('goes stale when a Comment is edited or deleted', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			const { comment } = await ok(client, 'add_comment', { labour: 'AM-1', body: 'a' });
			const stamp = async () =>
				ok(client, 'appraise', {
					labours: [{ labour: 'AM-1', stamp: (await getAppraisal(client, 'AM-1')).contentHash }]
				});
			await stamp();

			await ok(client, 'update_comment', { comment: comment.id, body: 'b' });
			expect((await getAppraisal(client, 'AM-1')).stale).toBe(true);

			await stamp();
			expect((await getAppraisal(client, 'AM-1')).stale).toBe(false);

			await ok(client, 'delete_comment', { comment: comment.id });
			expect((await getAppraisal(client, 'AM-1')).stale).toBe(true);
		});

		it('stays current through a State change, a move and an agent write', async () => {
			const { client } = await stampedLabour();
			await ok(client, 'create_realm', { name: 'Borealis', key: 'bl' });

			await ok(client, 'update_labour', { labour: 'AM-1', state: 'closed' });
			await ok(client, 'move_labour', { labour: 'AM-1', realm: 'BL' });
			await ok(client, 'appraise', {
				labours: [{ labour: 'BL-1', brief: 'more', refs: [{ href: 'x' }] }]
			});

			expect(await getAppraisal(client, 'BL-1')).toMatchObject({
				stale: false,
				unappraised: false
			});
		});

		it('is current again after a fresh stamp', async () => {
			const { client } = await stampedLabour();
			await ok(client, 'update_labour', { labour: 'AM-1', title: 'New' });

			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', stamp: (await getAppraisal(client, 'AM-1')).contentHash }]
			});

			expect(await getAppraisal(client, 'AM-1')).toMatchObject({
				stale: false,
				unappraised: false
			});
		});
	});

	describe('values', () => {
		it('marks a value stale once its Attribute is revised after it was set', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			at(1);
			await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });
			at(2);
			await ok(client, 'appraise', { labours: [{ labour: 'AM-1', values: { impact: 3 } }] });
			expect((await getAppraisal(client, 'AM-1')).values).toMatchObject([{ stale: false }]);

			at(3);
			await ok(client, 'define_attribute', {
				realm: 'AM',
				key: 'impact',
				kind: 'scale',
				rubric: 'A sharper rubric'
			});

			expect((await getAppraisal(client, 'AM-1')).values).toEqual([
				{
					key: 'impact',
					kind: 'scale',
					value: 3,
					setBy: 'root',
					setAt: '2030-01-02T00:00:00.000Z',
					stale: true
				}
			]);
		});

		it('lists values in Attribute order, tags as arrays and text as strings', async () => {
			const client = await connect(admin);
			await seed(client, 1);
			await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });
			await ok(client, 'define_attribute', {
				realm: 'AM',
				key: 'areas',
				kind: 'tags',
				label: 'Areas',
				rubric: 'Where',
				spec: {
					members: [
						{ key: 'ui', label: 'UI' },
						{ key: 'api', label: 'API' }
					]
				}
			});
			await ok(client, 'define_attribute', {
				realm: 'AM',
				key: 'notes',
				kind: 'text',
				label: 'Notes',
				rubric: 'Notes'
			});

			await ok(client, 'appraise', {
				labours: [{ labour: 'AM-1', values: { notes: ' hi ', areas: ['ui', 'api'], impact: 2 } }]
			});

			expect((await getAppraisal(client, 'AM-1')).values).toMatchObject([
				{ key: 'impact', kind: 'scale', value: 2, setBy: 'root' },
				{ key: 'areas', kind: 'tags', value: ['api', 'ui'] },
				{ key: 'notes', kind: 'text', value: 'hi' }
			]);
		});
	});
});

describe('list_unappraised', () => {
	async function mixedRealm() {
		const client = await connect(admin);
		await seed(client, 4);
		at(1);
		await ok(client, 'define_attribute', { realm: 'AM', ...IMPACT });
		const stamp = async (labour: string, values: Record<string, unknown> = {}) =>
			ok(client, 'appraise', {
				labours: [{ labour, values, stamp: (await getAppraisal(client, labour)).contentHash }]
			});
		at(2);
		await stamp('AM-1');
		await stamp('AM-2');
		await stamp('AM-4', { impact: 3 });
		await ok(client, 'update_labour', { labour: 'AM-2', title: 'Edited since' });
		at(3);
		await ok(client, 'define_attribute', {
			realm: 'AM',
			key: 'impact',
			kind: 'scale',
			rubric: 'Revised'
		});
		return client;
	}

	it('names the Labours to read next with their title and reason, unappraised first', async () => {
		const client = await mixedRealm();

		const result = await call(client, 'list_unappraised');

		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			labours: [
				{ labour: 'AM-3', title: 'Labour 3', reason: 'unappraised' },
				{ labour: 'AM-2', title: 'Edited since', reason: 'content' },
				{ labour: 'AM-4', title: 'Labour 4', reason: 'values' }
			],
			total: 3,
			offset: 0,
			nextOffset: null
		});
		const [summary, ...rest] = text(result).split('\n');
		expect(summary).toBeTruthy();
		expect(JSON.parse(rest.join('\n'))).toEqual(result.structuredContent);
	});

	it('lists nothing once every Labour is read and current', async () => {
		const client = await connect(admin);
		await seed(client, 2);
		for (const labour of ['AM-1', 'AM-2']) {
			await ok(client, 'appraise', {
				labours: [{ labour, stamp: (await getAppraisal(client, labour)).contentHash }]
			});
		}

		expect(await ok(client, 'list_unappraised')).toEqual({
			labours: [],
			total: 0,
			offset: 0,
			nextOffset: null
		});
	});

	it('lists unappraised Labours newest first', async () => {
		const client = await connect(admin);
		await seed(client, 3);

		const { labours } = await ok(client, 'list_unappraised');

		expect(labours.map((l: { labour: string }) => l.labour)).toEqual(['AM-3', 'AM-2', 'AM-1']);
	});

	it('limits to a Realm given by key in any case, former key or id', async () => {
		const client = await connect(admin);
		await seed(client, 2);
		await seed(client, 1, { key: 'bl', name: 'Borealis' });
		const { realm } = await ok(client, 'get_realm', { realm: 'BL' });
		await ok(client, 'rename_realm_key', { realm: 'BL', key: 'bo' });

		for (const ref of ['am', 'AM']) {
			const result = await ok(client, 'list_unappraised', { realm: ref });
			expect(result.labours.map((l: { labour: string }) => l.labour)).toEqual(['AM-2', 'AM-1']);
			expect(result.total).toBe(2);
		}
		for (const ref of ['bl', 'BO', realm.id]) {
			const result = await ok(client, 'list_unappraised', { realm: ref });
			expect(result.labours.map((l: { labour: string }) => l.labour)).toEqual(['BO-1']);
			expect(result.total).toBe(1);
		}
	});

	it('refuses an unknown Realm as not_found', async () => {
		const client = await connect(admin);

		const result = await call(client, 'list_unappraised', { realm: 'ZZ' });

		expect(result.structuredContent).toMatchObject({ error: { code: 'not_found' } });
	});

	it('leaves out Closed Labours unless include_closed is true', async () => {
		const client = await connect(admin);
		await seed(client, 2);
		await ok(client, 'update_labour', { labour: 'AM-1', state: 'closed' });

		const open = await ok(client, 'list_unappraised');
		const explicitlyOpen = await ok(client, 'list_unappraised', { include_closed: false });
		const all = await ok(client, 'list_unappraised', { include_closed: true });

		expect(open.labours.map((l: { labour: string }) => l.labour)).toEqual(['AM-2']);
		expect(explicitlyOpen.total).toBe(1);
		expect(all.labours.map((l: { labour: string }) => l.labour)).toEqual(['AM-2', 'AM-1']);
		expect(all.total).toBe(2);
	});

	it('pages with limit and offset, giving nextOffset until the last page', async () => {
		const client = await connect(admin);
		await seed(client, 5);
		const keys = (page: { labours: { labour: string }[] }) => page.labours.map((l) => l.labour);

		const first = await ok(client, 'list_unappraised', { limit: 2 });
		const second = await ok(client, 'list_unappraised', { limit: 2, offset: first.nextOffset });
		const last = await ok(client, 'list_unappraised', { limit: 2, offset: second.nextOffset });

		expect(keys(first)).toEqual(['AM-5', 'AM-4']);
		expect(first).toMatchObject({ total: 5, offset: 0, nextOffset: 2 });
		expect(keys(second)).toEqual(['AM-3', 'AM-2']);
		expect(second).toMatchObject({ total: 5, offset: 2, nextOffset: 4 });
		expect(keys(last)).toEqual(['AM-1']);
		expect(last).toMatchObject({ total: 5, offset: 4, nextOffset: null });
	});

	it('gives a null nextOffset when the last page is exactly full', async () => {
		const client = await connect(admin);
		await seed(client, 4);

		const page = await ok(client, 'list_unappraised', { limit: 2, offset: 2 });

		expect(page).toMatchObject({ total: 4, offset: 2, nextOffset: null });
		expect(page.labours).toHaveLength(2);
	});

	it('returns an empty page, with the total, past the end', async () => {
		const client = await connect(admin);
		await seed(client, 3);

		const page = await ok(client, 'list_unappraised', { offset: 10 });

		expect(page).toEqual({ labours: [], total: 3, offset: 10, nextOffset: null });
	});

	it('returns every Labour, up to 50, by default', async () => {
		const client = await connect(admin);
		await seed(client, 51);

		const page = await ok(client, 'list_unappraised');

		expect(page.labours).toHaveLength(50);
		expect(page).toMatchObject({ total: 51, nextOffset: 50 });
	});

	it('refuses a limit outside 1 to 200 and a negative offset as invalid', async () => {
		const client = await connect(admin);
		await seed(client, 1);

		for (const args of [{ limit: 0 }, { limit: 201 }, { offset: -1 }]) {
			const result = await call(client, 'list_unappraised', args);
			expect(result.structuredContent, JSON.stringify(args)).toMatchObject({
				error: { code: 'invalid' }
			});
		}
		expect((await ok(client, 'list_unappraised', { limit: 200 })).total).toBe(1);
	});

	it('refuses an unknown argument as invalid', async () => {
		const client = await connect(admin);

		const result = await call(client, 'list_unappraised', { needs: true });

		expect(result.structuredContent).toMatchObject({
			error: { code: 'invalid', message: expect.stringContaining('needs') }
		});
	});
});
