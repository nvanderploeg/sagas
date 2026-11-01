import { createHmac } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { open } from '#lib/server/auth/webhook-secrets.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import type { Db } from '#lib/server/db/client.ts';
import { realmKeys, webhooks } from '#lib/server/db/schema.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { recordDelivery } from '#lib/server/webhooks/deliveries.ts';
import { setWebhookRuntime } from '#lib/server/webhooks/runtime.ts';
import type { SafeFetchInput, SafeFetchResult } from '#lib/server/webhooks/safe-fetch.ts';
import type { WebhookEnv } from '#lib/server/webhooks/store.ts';
import { createMcpServer } from '../server.ts';

const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);
const URL = 'https://example.com/hook';
const NOW = Date.UTC(2026, 0, 1);
const HOUR = 60 * 60 * 1000;

let db: Db;
let ada: AuthUser;
let bob: AuthUser;
let root: AuthUser;
let owner: Client;
let stranger: Client;
let admin: Client;
let env: WebhookEnv;
let calls: { input: SafeFetchInput; allowPrivate: boolean }[];
let respond: () => Promise<SafeFetchResult>;
const clients: Client[] = [];

async function connect(actor: AuthUser): Promise<Client> {
	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
	await createMcpServer(db, actor, 'http://sagas.test').connect(serverSide);
	const client = new Client({ name: 'spec', version: '0' });
	await client.connect(clientSide);
	clients.push(client);
	return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
	(await client.callTool({ name, arguments: args })) as CallToolResult;

const summary = (result: CallToolResult) => text(result).split('\n')[0]!;

const text = (result: CallToolResult) =>
	result.content.map((part) => (part.type === 'text' ? part.text : '')).join('');

async function ok(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name}: ${text(result)}`).toBeFalsy();
	return result.structuredContent as any;
}

async function fail(client: Client, name: string, args: Record<string, unknown> = {}) {
	const result = await call(client, name, args);
	expect(result.isError, `${name} should fail`).toBe(true);
	return (result.structuredContent as any).error as { code: string; message: string };
}

const create = async (args: Record<string, unknown> = {}, client = owner) =>
	(await ok(client, 'create_webhook', { name: 'hook', url: URL, ...args })) as {
		webhook: any;
		secret: string;
	};

const row = (id: number) => db.select().from(webhooks).where(eq(webhooks.id, id)).get()!;
const realmIdOf = (key: string) =>
	db.select().from(realmKeys).where(eq(realmKeys.key, key)).get()!.realmId;

function sign(secret: string, content: string): string {
	const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
	return `v1,${createHmac('sha256', key).update(content).digest('base64')}`;
}

function expectSignedBy(sent: { input: SafeFetchInput }, secrets: string[]) {
	const headers = sent.input.headers;
	const content = `${headers['webhook-id']}.${headers['webhook-timestamp']}.${sent.input.body}`;
	const signatures = headers['webhook-signature']!.split(' ');
	expect(signatures).toHaveLength(secrets.length);
	for (const secret of secrets) expect(signatures).toContain(sign(secret, content));
}

// A secret never leaves create/rotate: no field of that name, no whsec_ value, no sealed text.
function expectNoSecret(result: CallToolResult, webhookId?: number) {
	const body = JSON.stringify(result.structuredContent) + text(result);
	expect(body).not.toContain('whsec_');
	expect(body).not.toMatch(/secret/i);
	if (webhookId !== undefined) {
		const stored = row(webhookId);
		expect(body).not.toContain(stored.secret);
		if (stored.previousSecret) expect(body).not.toContain(stored.previousSecret);
	}
}

function seedDeliveries(webhookId: number, n: number) {
	for (let i = 1; i <= n; i++) {
		recordDelivery(db, {
			webhookId,
			attemptedAt: NOW + i * 1000,
			messageId: `${webhookId}:${i}-${i}`,
			kind: 'events',
			firstSeq: i,
			lastSeq: i,
			status: 200,
			error: null,
			durationMs: i,
			responseBody: `body ${i}`
		});
	}
}

beforeEach(async () => {
	setAccessEnforced(true);
	db = testDb();
	ada = seedHuman(db, 'ada');
	bob = seedHuman(db, 'bob');
	root = { ...seedHuman(db, 'root'), isAdmin: true };
	owner = await connect(ada);
	stranger = await connect(bob);
	admin = await connect(root);
	await ok(owner, 'create_realm', { key: 'am', name: 'Atlas' });
	env = { key: KEY, maxPerUser: 10, max: 50, allowPrivate: false, now: NOW };
	calls = [];
	respond = async () => ({ ok: true, status: 200, durationMs: 7, body: '' });
	setWebhookRuntime({
		env: () => ({ ...env }),
		fetch: (input, allowPrivate) => {
			calls.push({ input, allowPrivate });
			return respond();
		}
	});
});

afterEach(async () => {
	setWebhookRuntime(null);
	setAccessEnforced(false);
	await Promise.all(clients.splice(0).map((client) => client.close()));
	db.$client.close();
});

describe('tool registration', () => {
	it('lists reads as read-only, delete_webhook as destructive and the rest as writes', async () => {
		const { tools } = await owner.listTools();
		const kinds = Object.fromEntries(
			tools
				.filter((t) => t.name.includes('webhook'))
				.map((t) => [
					t.name,
					t.annotations?.readOnlyHint
						? 'read'
						: t.annotations?.destructiveHint
							? 'destroy'
							: 'write'
				])
		);

		expect(kinds).toEqual({
			create_webhook: 'write',
			list_webhooks: 'read',
			update_webhook: 'write',
			rotate_webhook_secret: 'write',
			test_webhook: 'write',
			delete_webhook: 'destroy',
			list_webhook_deliveries: 'read'
		});
	});
});

describe('without WEBHOOK_KEY', () => {
	it('fails every tool as invalid', async () => {
		const { webhook } = await create();
		env.key = undefined;
		const id = webhook.id;

		const attempts: [string, Record<string, unknown>][] = [
			['create_webhook', { name: 'x', url: URL }],
			['list_webhooks', {}],
			['update_webhook', { webhook: id, name: 'x' }],
			['rotate_webhook_secret', { webhook: id }],
			['test_webhook', { webhook: id }],
			['delete_webhook', { webhook: id }],
			['list_webhook_deliveries', { webhook: id }]
		];
		for (const [name, args] of attempts) {
			expect(await fail(owner, name, args), name).toEqual({
				code: 'invalid',
				message: 'webhooks need WEBHOOK_KEY'
			});
		}
		expect(calls).toHaveLength(0);
		expect(row(id)).toBeDefined();
	});

	it('answers invalid before resolving a User ref', async () => {
		env.key = undefined;

		expect(await fail(owner, 'list_webhooks', { user: 'ghost' })).toEqual({
			code: 'invalid',
			message: 'webhooks need WEBHOOK_KEY'
		});
	});
});

describe('update_webhook on a Webhook the caller cannot see', () => {
	it('answers not_found before resolving Realm refs', async () => {
		const { webhook } = await create();

		expect(
			await fail(stranger, 'update_webhook', { webhook: webhook.id, realms: ['NOPE'] })
		).toEqual({
			code: 'not_found',
			message: 'Webhook not found'
		});
	});
});

describe('create_webhook', () => {
	it('answers with the Webhook view and the secret', async () => {
		const result = await call(owner, 'create_webhook', { name: 'hook', url: URL });
		const { webhook, secret } = result.structuredContent as any;

		expect(webhook).toEqual({
			id: expect.any(Number),
			owner: 'ada',
			name: 'hook',
			url: URL,
			eventTypes: null,
			realms: null,
			realmIds: null,
			status: 'active',
			statusReason: null,
			cursor: eventWindow(db).last,
			createdAt: new Date(NOW).toISOString(),
			updatedAt: new Date(NOW).toISOString(),
			failingSince: null,
			nextAttemptAt: null
		});
		expect(secret).toMatch(/^whsec_/);
		expect(Buffer.from(secret.slice(6), 'base64')).toHaveLength(32);
		expect(Object.keys(result.structuredContent as object).sort()).toEqual(['secret', 'webhook']);
	});

	it('stores the returned secret sealed under the key', async () => {
		const { webhook, secret } = await create();

		expect(open(row(webhook.id).secret, KEY)).toBe(secret);
	});

	it('keeps the secret out of the text reply, one short line', async () => {
		const result = await call(owner, 'create_webhook', { name: 'hook', url: URL });
		const { secret } = result.structuredContent as any;

		expect(summary(result)).not.toContain(secret);
		expect(summary(result)).not.toContain('whsec_');
		expect(summary(result).trim()).not.toBe('');
	});

	it('creates for the caller, even an Admin', async () => {
		const { webhook } = await create({}, admin);

		expect(webhook.owner).toBe('root');
	});

	it('takes eventTypes', async () => {
		const { webhook } = await create({ eventTypes: ['labour.created'] });

		expect(webhook.eventTypes).toEqual(['labour.created']);
	});

	it('refuses an unknown event type', async () => {
		expect(
			(await fail(owner, 'create_webhook', { name: 'h', url: URL, eventTypes: ['nope'] })).code
		).toBe('invalid');
	});

	it('takes Realm keys, answering with keys and ids', async () => {
		const { webhook } = await create({ realms: ['am'] });

		expect(webhook.realms).toEqual(['AM']);
		expect(webhook.realmIds).toEqual([realmIdOf('AM')]);
		expect(row(webhook.id).realmIds).toBe(JSON.stringify([realmIdOf('AM')]));
	});

	it('takes a Realm id as a JSON number', async () => {
		const id = realmIdOf('AM');

		const { webhook } = await create({ realms: [id] });

		expect(webhook.realms).toEqual(['AM']);
		expect(webhook.realmIds).toEqual([id]);
	});

	it('takes a former Realm key and answers with the current one', async () => {
		await ok(owner, 'rename_realm_key', { realm: 'AM', key: 'zz' });

		const { webhook } = await create({ realms: ['AM'] });

		expect(webhook.realms).toEqual(['ZZ']);
		expect(webhook.realmIds).toEqual([realmIdOf('ZZ')]);
	});

	it('keeps several Realms in the order given', async () => {
		await ok(owner, 'create_realm', { key: 'bm', name: 'Beta' });

		const { webhook } = await create({ realms: ['bm', 'am'] });

		expect(webhook.realms).toEqual(['BM', 'AM']);
		expect(webhook.realmIds).toEqual([realmIdOf('BM'), realmIdOf('AM')]);
	});

	it('answers a Realm the caller cannot see like one that does not exist', async () => {
		const unseen = await fail(stranger, 'create_webhook', { name: 'h', url: URL, realms: ['AM'] });
		const unknown = await fail(stranger, 'create_webhook', { name: 'h', url: URL, realms: ['QQ'] });
		const byId = await fail(stranger, 'create_webhook', {
			name: 'h',
			url: URL,
			realms: [realmIdOf('AM')]
		});

		expect(unseen).toEqual({ code: 'not_found', message: 'No Realm has the key AM' });
		expect(unknown).toEqual({ code: 'not_found', message: 'No Realm has the key QQ' });
		expect(byId.code).toBe('not_found');
		expect(await ok(stranger, 'list_webhooks')).toEqual({ webhooks: [] });
	});

	it('refuses an invalid URL', async () => {
		for (const url of ['ftp://example.com/hook', 'not a url', 'http://127.0.0.1/hook']) {
			expect((await fail(owner, 'create_webhook', { name: 'h', url })).code, url).toBe('invalid');
		}
		expect(await ok(owner, 'list_webhooks')).toEqual({ webhooks: [] });
	});

	it('allows a private URL when the env allows it', async () => {
		env.allowPrivate = true;

		const { webhook } = await create({ url: 'http://127.0.0.1/hook' });

		expect(webhook.url).toBe('http://127.0.0.1/hook');
	});

	it('refuses past the per-User cap, still serving another User', async () => {
		env.maxPerUser = 1;
		await create();

		expect((await fail(owner, 'create_webhook', { name: 'h', url: URL })).code).toBe('conflict');
		expect((await create({}, stranger)).webhook.owner).toBe('bob');
	});

	it('refuses past the instance cap', async () => {
		env.max = 1;
		await create();

		expect((await fail(stranger, 'create_webhook', { name: 'h', url: URL })).code).toBe('conflict');
	});
});

describe('list_webhooks', () => {
	it("lists the caller's Webhooks by default, in id order", async () => {
		const a = (await create({ name: 'a' })).webhook;
		const b = (await create({ name: 'b' })).webhook;
		await create({ name: 'bobs' }, stranger);

		const result = await call(owner, 'list_webhooks');

		expect((result.structuredContent as any).webhooks).toEqual([a, b]);
		expectNoSecret(result);
	});

	it('lists nothing for a User without Webhooks', async () => {
		expect(await ok(owner, 'list_webhooks')).toEqual({ webhooks: [] });
	});

	it('takes a username, "me" or an id for the owner', async () => {
		const { webhook } = await create();

		for (const user of ['ada', 'me', ada.id]) {
			expect((await ok(owner, 'list_webhooks', { user })).webhooks, String(user)).toEqual([
				webhook
			]);
		}
	});

	it("answers not_found to another User asking for the owner's list", async () => {
		await create();

		for (const user of ['ada', ada.id]) {
			expect((await fail(stranger, 'list_webhooks', { user })).code, String(user)).toBe(
				'not_found'
			);
		}
	});

	it("lets an Admin list any User's Webhooks", async () => {
		const { webhook } = await create();

		expect((await ok(admin, 'list_webhooks', { user: 'ada' })).webhooks).toEqual([webhook]);
		expect((await ok(admin, 'list_webhooks')).webhooks).toEqual([]);
	});

	it('answers not_found for an unknown User', async () => {
		expect((await fail(admin, 'list_webhooks', { user: 'nobody' })).code).toBe('not_found');
	});

	it("shows a deleted Realm's id in realmIds but not in realms", async () => {
		await ok(owner, 'create_realm', { key: 'bm', name: 'Beta' });
		await create({ realms: ['am', 'bm'] });
		const gone = realmIdOf('BM');
		await ok(owner, 'delete_realm', { realm: 'BM' });

		const [webhook] = (await ok(owner, 'list_webhooks')).webhooks;

		expect(webhook.realmIds).toEqual([realmIdOf('AM'), gone]);
		expect(webhook.realms).toEqual(['AM']);
	});

	it('shows the status, reason, failingSince and nextAttemptAt as ISO strings', async () => {
		const { webhook } = await create();
		db.update(webhooks)
			.set({
				status: 'disabled',
				statusReason: 'failing',
				failingSince: new Date(NOW + 1000),
				nextAttemptAt: new Date(NOW + 2000),
				cursor: 9
			})
			.where(eq(webhooks.id, webhook.id))
			.run();

		const [listed] = (await ok(owner, 'list_webhooks')).webhooks;

		expect(listed).toMatchObject({
			status: 'disabled',
			statusReason: 'failing',
			failingSince: new Date(NOW + 1000).toISOString(),
			nextAttemptAt: new Date(NOW + 2000).toISOString(),
			cursor: 9
		});
	});
});

describe('update_webhook', () => {
	it('changes the given fields and leaves the rest', async () => {
		const { webhook } = await create({ eventTypes: ['labour.created'], realms: ['am'] });
		env.now = NOW + HOUR;

		const result = await call(owner, 'update_webhook', { webhook: webhook.id, name: 'renamed' });
		const updated = (result.structuredContent as any).webhook;

		expect(updated).toEqual({
			...webhook,
			name: 'renamed',
			updatedAt: new Date(NOW + HOUR).toISOString()
		});
		expect(Object.keys(result.structuredContent as object)).toEqual(['webhook']);
		expectNoSecret(result, webhook.id);
	});

	it('changes the url', async () => {
		const { webhook } = await create();

		const updated = (
			await ok(owner, 'update_webhook', { webhook: webhook.id, url: 'https://example.org/x' })
		).webhook;

		expect(updated.url).toBe('https://example.org/x');
		expect(row(webhook.id).url).toBe('https://example.org/x');
	});

	it('refuses an invalid url, changing nothing', async () => {
		const { webhook } = await create();

		expect(
			(await fail(owner, 'update_webhook', { webhook: webhook.id, url: 'ftp://x/y' })).code
		).toBe('invalid');
		expect(row(webhook.id).url).toBe(URL);
	});

	it('sets and clears eventTypes', async () => {
		const { webhook } = await create();

		const set = (
			await ok(owner, 'update_webhook', { webhook: webhook.id, eventTypes: ['labour.created'] })
		).webhook;
		const cleared = (await ok(owner, 'update_webhook', { webhook: webhook.id, eventTypes: null }))
			.webhook;

		expect(set.eventTypes).toEqual(['labour.created']);
		expect(cleared.eventTypes).toBeNull();
	});

	it('sets Realms by key and clears them with null', async () => {
		const { webhook } = await create();

		const set = (await ok(owner, 'update_webhook', { webhook: webhook.id, realms: ['am'] }))
			.webhook;
		const cleared = (await ok(owner, 'update_webhook', { webhook: webhook.id, realms: null }))
			.webhook;

		expect(set.realms).toEqual(['AM']);
		expect(set.realmIds).toEqual([realmIdOf('AM')]);
		expect(cleared.realms).toBeNull();
		expect(cleared.realmIds).toBeNull();
	});

	it('refuses a Realm the owner cannot see as not found', async () => {
		const { webhook } = await create({}, stranger);

		const error = await fail(stranger, 'update_webhook', { webhook: webhook.id, realms: ['AM'] });

		expect(error).toEqual({ code: 'not_found', message: 'No Realm has the key AM' });
		expect(row(webhook.id).realmIds).toBeNull();
	});

	it('does not move the cursor on a filter change', async () => {
		const { webhook } = await create();
		db.update(webhooks).set({ cursor: 5 }).where(eq(webhooks.id, webhook.id)).run();

		const updated = (await ok(owner, 'update_webhook', { webhook: webhook.id, realms: ['am'] }))
			.webhook;

		expect(updated.cursor).toBe(5);
		expect(row(webhook.id).cursor).toBe(5);
	});

	it('pauses an active Webhook', async () => {
		const { webhook } = await create();

		const updated = (await ok(owner, 'update_webhook', { webhook: webhook.id, status: 'paused' }))
			.webhook;

		expect(updated.status).toBe('paused');
		expect(updated.statusReason).toBeNull();
	});

	it('resumes a disabled Webhook: active, reason cleared, cursor untouched', async () => {
		const { webhook } = await create();
		db.update(webhooks)
			.set({
				status: 'disabled',
				statusReason: 'failing',
				cursor: 7,
				attempts: 3,
				failingSince: new Date(NOW),
				nextAttemptAt: new Date(NOW + 1000)
			})
			.where(eq(webhooks.id, webhook.id))
			.run();

		const updated = (await ok(owner, 'update_webhook', { webhook: webhook.id, status: 'active' }))
			.webhook;

		expect(updated).toMatchObject({
			status: 'active',
			statusReason: null,
			cursor: 7,
			failingSince: null
		});
		expect(row(webhook.id)).toMatchObject({
			status: 'active',
			statusReason: null,
			cursor: 7,
			attempts: 0,
			failingSince: null
		});
	});

	it('resumes a Webhook paused by hand', async () => {
		const { webhook } = await create();
		await ok(owner, 'update_webhook', { webhook: webhook.id, status: 'paused' });

		const updated = (await ok(owner, 'update_webhook', { webhook: webhook.id, status: 'active' }))
			.webhook;

		expect(updated.status).toBe('active');
	});

	it('refuses to resume after a key change until the secret is rotated', async () => {
		const { webhook } = await create();
		db.update(webhooks)
			.set({ status: 'paused', statusReason: 'key_changed' })
			.where(eq(webhooks.id, webhook.id))
			.run();
		env.key = OTHER_KEY;

		expect(await fail(owner, 'update_webhook', { webhook: webhook.id, status: 'active' })).toEqual({
			code: 'conflict',
			message: 'rotate the secret first'
		});
		expect(row(webhook.id)).toMatchObject({ status: 'paused', statusReason: 'key_changed' });

		await ok(owner, 'rotate_webhook_secret', { webhook: webhook.id });
		const resumed = (await ok(owner, 'update_webhook', { webhook: webhook.id, status: 'active' }))
			.webhook;

		expect(resumed).toMatchObject({ status: 'active', statusReason: null });
	});

	it('refuses a status other than active or paused', async () => {
		const { webhook } = await create();

		const result = await call(owner, 'update_webhook', { webhook: webhook.id, status: 'disabled' });

		expect(result.isError).toBe(true);
		expect(row(webhook.id).status).toBe('active');
	});

	it('refuses a webhook that is not a positive integer', async () => {
		for (const webhook of [0, -1, 1.5]) {
			const result = await call(owner, 'update_webhook', { webhook, name: 'x' });
			expect(result.isError, String(webhook)).toBe(true);
		}
	});

	it('answers not_found to another User and for a missing Webhook', async () => {
		const { webhook } = await create();

		expect(await fail(stranger, 'update_webhook', { webhook: webhook.id, name: 'x' })).toEqual({
			code: 'not_found',
			message: 'Webhook not found'
		});
		expect((await fail(owner, 'update_webhook', { webhook: 999, name: 'x' })).code).toBe(
			'not_found'
		);
		expect(row(webhook.id).name).toBe('hook');
	});

	it('lets an Admin change any Webhook', async () => {
		const { webhook } = await create();

		const updated = (await ok(admin, 'update_webhook', { webhook: webhook.id, name: 'by admin' }))
			.webhook;

		expect(updated.name).toBe('by admin');
		expect(updated.owner).toBe('ada');
	});
});

describe('rotate_webhook_secret', () => {
	it('answers with a new secret and nothing else', async () => {
		const { webhook, secret } = await create();

		const result = await call(owner, 'rotate_webhook_secret', { webhook: webhook.id });
		const rotated = result.structuredContent as any;

		expect(rotated).toEqual({ secret: expect.stringMatching(/^whsec_/) });
		expect(rotated.secret).not.toBe(secret);
		expect(open(row(webhook.id).secret, KEY)).toBe(rotated.secret);
	});

	it('keeps the old secret through the overlap', async () => {
		const { webhook, secret } = await create();

		await ok(owner, 'rotate_webhook_secret', { webhook: webhook.id });

		const stored = row(webhook.id);
		expect(open(stored.previousSecret!, KEY)).toBe(secret);
	});

	it('keeps both secrets out of the text reply, one short line', async () => {
		const { webhook, secret } = await create();

		const result = await call(owner, 'rotate_webhook_secret', { webhook: webhook.id });
		const rotated = (result.structuredContent as any).secret;

		expect(summary(result)).not.toContain(rotated);
		expect(summary(result)).not.toContain(secret);
		expect(summary(result).trim()).not.toBe('');
	});

	it('answers not_found to another User, leaving the secret alone', async () => {
		const { webhook, secret } = await create();

		expect((await fail(stranger, 'rotate_webhook_secret', { webhook: webhook.id })).code).toBe(
			'not_found'
		);
		expect(open(row(webhook.id).secret, KEY)).toBe(secret);
	});

	it('lets an Admin rotate', async () => {
		const { webhook, secret } = await create();

		const rotated = await ok(admin, 'rotate_webhook_secret', { webhook: webhook.id });

		expect(rotated.secret).not.toBe(secret);
	});
});

describe('test_webhook', () => {
	it('sends a signed ping and answers with the attempt', async () => {
		const { webhook, secret } = await create({ name: 'my hook' });
		respond = async () => ({ ok: true, status: 202, durationMs: 21, body: 'pong' });

		const result = await call(owner, 'test_webhook', { webhook: webhook.id });

		expect(result.structuredContent).toEqual({
			attempt: { ok: true, status: 202, error: null, durationMs: 21 }
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]!.input.url).toBe(URL);
		expect(calls[0]!.input.body).toBe(
			`{"webhook":{"id":${webhook.id},"name":"my hook"},"ping":true}`
		);
		const timestamp = String(Math.floor(NOW / 1000));
		expect(calls[0]!.input.headers['webhook-id']).toBe(`${webhook.id}:ping-${timestamp}`);
		expect(calls[0]!.input.headers['webhook-timestamp']).toBe(timestamp);
		expectSignedBy(calls[0]!, [secret]);
		expectNoSecret(result, webhook.id);
		expect(summary(result).trim()).not.toBe('');
	});

	it('hands env.allowPrivate to fetch', async () => {
		const { webhook } = await create();
		env.allowPrivate = true;

		await ok(owner, 'test_webhook', { webhook: webhook.id });

		expect(calls[0]!.allowPrivate).toBe(true);
	});

	it('records one ping delivery that list_webhook_deliveries shows', async () => {
		const { webhook } = await create();
		respond = async () => ({ ok: true, status: 200, durationMs: 4, body: 'pong' });

		await ok(owner, 'test_webhook', { webhook: webhook.id });

		const { deliveries } = await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0]).toMatchObject({
			kind: 'ping',
			messageId: calls[0]!.input.headers['webhook-id'],
			firstSeq: null,
			lastSeq: null,
			status: 200,
			error: null,
			durationMs: 4,
			responseBody: 'pong'
		});
	});

	it('moves nothing on the Webhook', async () => {
		const { webhook } = await create();
		db.update(webhooks)
			.set({
				cursor: 11,
				attempts: 2,
				failingSince: new Date(NOW),
				nextAttemptAt: new Date(NOW + 5000)
			})
			.where(eq(webhooks.id, webhook.id))
			.run();
		const before = row(webhook.id);
		env.now = NOW + HOUR;

		await ok(owner, 'test_webhook', { webhook: webhook.id });

		expect(row(webhook.id)).toEqual(before);
	});

	it.each([
		['paused', null],
		['disabled', 'failing']
	] as const)('works on a %s Webhook without changing it', async (status, reason) => {
		const { webhook } = await create();
		db.update(webhooks)
			.set({ status, statusReason: reason })
			.where(eq(webhooks.id, webhook.id))
			.run();
		const before = row(webhook.id);

		const { attempt } = await ok(owner, 'test_webhook', { webhook: webhook.id });

		expect(attempt.ok).toBe(true);
		expect(calls).toHaveLength(1);
		expect(row(webhook.id)).toEqual(before);
	});

	it('reports ok:false from fetch as an attempt, not an error', async () => {
		const { webhook } = await create();
		respond = async () => ({
			ok: false,
			status: 500,
			durationMs: 9,
			body: 'no',
			error: 'HTTP 500'
		});

		const { attempt } = await ok(owner, 'test_webhook', { webhook: webhook.id });

		expect(attempt).toEqual({ ok: false, status: 500, error: 'HTTP 500', durationMs: 9 });
		const { deliveries } = await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id });
		expect(deliveries[0]).toMatchObject({ kind: 'ping', status: 500, error: 'HTTP 500' });
	});

	it('reports a throwing fetch as an attempt, not an error', async () => {
		const { webhook } = await create();
		respond = async () => {
			throw new Error('socket exploded');
		};

		const { attempt } = await ok(owner, 'test_webhook', { webhook: webhook.id });

		expect(attempt.ok).toBe(false);
		expect(attempt.error).toEqual(expect.any(String));
		expect(attempt.error).not.toBe('');
		expect(
			(await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id })).deliveries
		).toHaveLength(1);
	});

	it('signs with both secrets during a rotation overlap', async () => {
		const { webhook, secret: first } = await create();
		const { secret: second } = await ok(owner, 'rotate_webhook_secret', { webhook: webhook.id });

		await ok(owner, 'test_webhook', { webhook: webhook.id });

		expectSignedBy(calls[0]!, [first, second]);
	});

	it('signs with the new secret alone after the overlap', async () => {
		const { webhook } = await create();
		const { secret: second } = await ok(owner, 'rotate_webhook_secret', { webhook: webhook.id });
		env.now = NOW + 25 * HOUR;

		await ok(owner, 'test_webhook', { webhook: webhook.id });

		expectSignedBy(calls[0]!, [second]);
	});

	it('answers not_found to another User, sending nothing', async () => {
		const { webhook } = await create();

		expect(await fail(stranger, 'test_webhook', { webhook: webhook.id })).toEqual({
			code: 'not_found',
			message: 'Webhook not found'
		});
		expect(calls).toHaveLength(0);
	});

	it('lets an Admin ping any Webhook', async () => {
		const { webhook } = await create();

		expect((await ok(admin, 'test_webhook', { webhook: webhook.id })).attempt.ok).toBe(true);
	});
});

describe('delete_webhook', () => {
	it('deletes the Webhook and answers with its id', async () => {
		const { webhook } = await create();
		seedDeliveries(webhook.id, 2);

		const result = await call(owner, 'delete_webhook', { webhook: webhook.id });

		expect(result.structuredContent).toEqual({ deleted: webhook.id });
		expect(db.select().from(webhooks).where(eq(webhooks.id, webhook.id)).get()).toBeUndefined();
		expect(await ok(owner, 'list_webhooks')).toEqual({ webhooks: [] });
		expect((await fail(owner, 'list_webhook_deliveries', { webhook: webhook.id })).code).toBe(
			'not_found'
		);
	});

	it('answers not_found to another User, deleting nothing', async () => {
		const { webhook } = await create();

		expect((await fail(stranger, 'delete_webhook', { webhook: webhook.id })).code).toBe(
			'not_found'
		);
		expect(row(webhook.id)).toBeDefined();
	});

	it('answers not_found the second time', async () => {
		const { webhook } = await create();
		await ok(owner, 'delete_webhook', { webhook: webhook.id });

		expect((await fail(owner, 'delete_webhook', { webhook: webhook.id })).code).toBe('not_found');
	});

	it('lets an Admin delete any Webhook', async () => {
		const { webhook } = await create();

		await ok(admin, 'delete_webhook', { webhook: webhook.id });

		expect(await ok(owner, 'list_webhooks')).toEqual({ webhooks: [] });
	});
});

describe('list_webhook_deliveries', () => {
	it('lists newest first with the delivery shape and no secret', async () => {
		const { webhook } = await create();
		seedDeliveries(webhook.id, 3);

		const result = await call(owner, 'list_webhook_deliveries', { webhook: webhook.id });
		const { deliveries, nextBefore } = result.structuredContent as any;

		expect(nextBefore).toBeNull();
		expect(deliveries.map((d: any) => d.firstSeq)).toEqual([3, 2, 1]);
		expect(deliveries[0]).toEqual({
			id: expect.any(Number),
			attemptedAt: new Date(NOW + 3000).toISOString(),
			messageId: `${webhook.id}:3-3`,
			kind: 'events',
			firstSeq: 3,
			lastSeq: 3,
			status: 200,
			error: null,
			durationMs: 3,
			responseBody: 'body 3'
		});
		expect(deliveries[0].id).toBeGreaterThan(deliveries[1].id);
		expectNoSecret(result, webhook.id);
	});

	it('answers an empty list with a null nextBefore', async () => {
		const { webhook } = await create();

		expect(await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id })).toEqual({
			deliveries: [],
			nextBefore: null
		});
	});

	it('pages with limit and before until nextBefore is null', async () => {
		const { webhook } = await create();
		seedDeliveries(webhook.id, 5);
		const seen: number[] = [];

		const first = await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id, limit: 2 });
		expect(first.deliveries.map((d: any) => d.firstSeq)).toEqual([5, 4]);
		expect(first.nextBefore).toBe(first.deliveries[1].id);
		seen.push(...first.deliveries.map((d: any) => d.firstSeq));

		const second = await ok(owner, 'list_webhook_deliveries', {
			webhook: webhook.id,
			limit: 2,
			before: first.nextBefore
		});
		expect(second.deliveries.map((d: any) => d.firstSeq)).toEqual([3, 2]);
		expect(second.nextBefore).toBe(second.deliveries[1].id);
		seen.push(...second.deliveries.map((d: any) => d.firstSeq));

		const last = await ok(owner, 'list_webhook_deliveries', {
			webhook: webhook.id,
			limit: 2,
			before: second.nextBefore
		});
		expect(last.deliveries.map((d: any) => d.firstSeq)).toEqual([1]);
		expect(last.nextBefore).toBeNull();
		expect([...seen, 1]).toEqual([5, 4, 3, 2, 1]);
	});

	it('has no nextBefore when the page holds everything', async () => {
		const { webhook } = await create();
		seedDeliveries(webhook.id, 2);

		const page = await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id, limit: 2 });

		expect(page.deliveries).toHaveLength(2);
		expect(page.nextBefore).toBeNull();
	});

	it("lists only the given Webhook's deliveries", async () => {
		const { webhook } = await create();
		const other = (await create({ name: 'other' })).webhook;
		seedDeliveries(webhook.id, 2);
		seedDeliveries(other.id, 3);

		const page = await ok(owner, 'list_webhook_deliveries', { webhook: webhook.id });

		expect(page.deliveries).toHaveLength(2);
	});

	it('refuses a limit outside 1 to 200', async () => {
		const { webhook } = await create();

		for (const limit of [0, 201, -1]) {
			const result = await call(owner, 'list_webhook_deliveries', { webhook: webhook.id, limit });
			expect(result.isError, String(limit)).toBe(true);
		}
		expect(
			(await call(owner, 'list_webhook_deliveries', { webhook: webhook.id, limit: 200 })).isError
		).toBeFalsy();
		expect(
			(await call(owner, 'list_webhook_deliveries', { webhook: webhook.id, limit: 1 })).isError
		).toBeFalsy();
	});

	it('refuses a before that is not a positive integer', async () => {
		const { webhook } = await create();

		for (const before of [0, -3]) {
			const result = await call(owner, 'list_webhook_deliveries', { webhook: webhook.id, before });
			expect(result.isError, String(before)).toBe(true);
		}
	});

	it('answers not_found to another User and for a missing Webhook', async () => {
		const { webhook } = await create();
		seedDeliveries(webhook.id, 1);

		expect(await fail(stranger, 'list_webhook_deliveries', { webhook: webhook.id })).toEqual({
			code: 'not_found',
			message: 'Webhook not found'
		});
		expect((await fail(owner, 'list_webhook_deliveries', { webhook: 999 })).code).toBe('not_found');
	});

	it("lets an Admin read any Webhook's deliveries", async () => {
		const { webhook } = await create();
		seedDeliveries(webhook.id, 2);

		expect(
			(await ok(admin, 'list_webhook_deliveries', { webhook: webhook.id })).deliveries
		).toHaveLength(2);
	});
});
