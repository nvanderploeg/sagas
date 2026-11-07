import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, users, webhooks } from '#lib/server/db/schema.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { deleteRealm } from '#lib/server/domain/realms.ts';
import { eventWindow } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedLabour, seedRealm } from '#lib/server/test/fixtures.ts';
import { seedHuman } from '#lib/server/auth/fixtures.ts';
import type { AuthUser } from '#lib/server/auth/users.ts';
import {
	createWebhook,
	deleteWebhook,
	getWebhook,
	listWebhooks,
	pauseKeyChanged,
	rotateWebhookSecret,
	signingSecrets,
	updateWebhook,
	type WebhookEnv,
	type WebhookRow
} from './store.ts';

const HOUR = 60 * 60 * 1000;
const KEY = Buffer.alloc(32, 1);
const OTHER_KEY = Buffer.alloc(32, 2);
const URL = 'https://example.com/hook';

let db: Db;
let env: WebhookEnv;
let ada: AuthUser;
let bob: AuthUser;
let admin: AuthUser;

beforeEach(async () => {
	db = await testDb();
	env = { key: KEY, maxPerUser: 10, max: 50, allowPrivate: false, now: Date.UTC(2026, 0, 1) };
	ada = await seedHuman(db, 'ada');
	bob = await seedHuman(db, 'bob');
	admin = { ...(await seedHuman(db, 'root')), isAdmin: true };
});

async function expectCode(action: () => unknown, code: DomainError['code'], message?: string) {
	let thrown: unknown;
	try {
		await action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	if (message) expect((thrown as DomainError).message).toBe(message);
}

function make(actor = ada, extra = {}) {
	return createWebhook(db, actor, { name: 'hook', url: URL, ...extra }, env);
}

async function row(id: number): Promise<WebhookRow> {
	return (await db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1))[0]!;
}

describe('permissions', () => {
	it('lets the owner see and change a Webhook', async () => {
		const { webhook } = await make();

		expect((await getWebhook(db, ada, webhook.id, env)).ownerId).toBe(ada.id);
		expect((await updateWebhook(db, ada, webhook.id, { name: 'renamed' }, env)).name).toBe(
			'renamed'
		);
		expect(await listWebhooks(db, ada, ada.id, env)).toHaveLength(1);
	});

	it('answers not_found to another User for every call', async () => {
		const { webhook } = await make();

		await expectCode(() => getWebhook(db, bob, webhook.id, env), 'not_found');
		await expectCode(() => updateWebhook(db, bob, webhook.id, { name: 'x' }, env), 'not_found');
		await expectCode(() => rotateWebhookSecret(db, bob, webhook.id, env), 'not_found');
		await expectCode(() => deleteWebhook(db, bob, webhook.id, env), 'not_found');
		await expectCode(() => listWebhooks(db, bob, ada.id, env), 'not_found');
		expect(await row(webhook.id)).toBeDefined();
	});

	it('answers not_found for a Webhook that does not exist', async () => {
		await expectCode(() => getWebhook(db, ada, 999, env), 'not_found');
	});

	it('lets an Admin see, change, rotate and delete any Webhook', async () => {
		const { webhook } = await make();

		expect((await getWebhook(db, admin, webhook.id, env)).id).toBe(webhook.id);
		expect(await listWebhooks(db, admin, ada.id, env)).toHaveLength(1);
		await updateWebhook(db, admin, webhook.id, { status: 'paused' }, env);
		await rotateWebhookSecret(db, admin, webhook.id, env);
		await deleteWebhook(db, admin, webhook.id, env);
		expect(await listWebhooks(db, ada, ada.id, env)).toHaveLength(0);
	});

	it('creates for the actor, even an Admin', async () => {
		expect((await make(admin)).webhook.ownerId).toBe(admin.id);
	});
});

describe('limits', () => {
	it('refuses a Webhook past the per-User cap', async () => {
		env.maxPerUser = 2;
		await make();
		await make();

		await expectCode(() => make(), 'conflict');
		expect((await make(bob)).webhook.ownerId).toBe(bob.id);
	});

	it('refuses a Webhook past the instance cap', async () => {
		env.max = 2;
		await make(ada);
		await make(bob);

		await expectCode(() => make(admin), 'conflict');
	});
});

describe('cursor and filters', () => {
	it('starts at the last seq assigned', async () => {
		const realm = await seedRealm(db);
		await seedLabour(db, { realmId: realm.id });
		const last = (await eventWindow(db)).last;
		expect(last).toBeGreaterThan(0);

		expect((await make()).webhook.cursor).toBe(last);
	});

	it('starts at 0 on an empty log', async () => {
		expect((await make()).webhook.cursor).toBe(0);
	});

	it('applies new filters without moving the cursor', async () => {
		const realm = await seedRealm(db);
		const { webhook } = await make();
		await seedLabour(db, { realmId: realm.id });

		const updated = await updateWebhook(
			db,
			ada,
			webhook.id,
			{ eventTypes: ['labour.created'], realmIds: [realm.id] },
			env
		);

		expect(updated.eventTypes).toEqual(['labour.created']);
		expect(updated.realmIds).toEqual([realm.id]);
		expect(updated.cursor).toBe(webhook.cursor);
		expect(updated.cursor).toBeLessThan((await eventWindow(db)).last);
	});

	it('clears filters with null', async () => {
		const realm = await seedRealm(db);
		const { webhook } = await make(ada, { eventTypes: ['labour.created'], realmIds: [realm.id] });

		const updated = await updateWebhook(
			db,
			ada,
			webhook.id,
			{ eventTypes: null, realmIds: null },
			env
		);

		expect(updated.eventTypes).toBeNull();
		expect(updated.realmIds).toBeNull();
	});
});

describe('validation', () => {
	it('rejects a bad name', async () => {
		await expectCode(() => make(ada, { name: '  ' }), 'invalid');
		await expectCode(() => make(ada, { name: 'x'.repeat(101) }), 'invalid');
		const { webhook } = await make();
		await expectCode(() => updateWebhook(db, ada, webhook.id, { name: '' }, env), 'invalid');
	});

	it('rejects a bad url', async () => {
		await expectCode(() => make(ada, { url: 'http://example.com/h' }), 'invalid');
		await expectCode(() => make(ada, { url: 'nope' }), 'invalid');
		const { webhook } = await make();
		await expectCode(
			() => updateWebhook(db, ada, webhook.id, { url: 'ftp://x.test' }, env),
			'invalid'
		);
	});

	it('allows http when private targets are allowed', async () => {
		env.allowPrivate = true;
		expect((await make(ada, { url: 'http://localhost:9000/h' })).webhook.url).toBe(
			'http://localhost:9000/h'
		);
	});

	it('rejects unknown event types and empty lists', async () => {
		await expectCode(() => make(ada, { eventTypes: ['nope.nothing'] }), 'invalid');
		await expectCode(() => make(ada, { eventTypes: [] }), 'invalid');
		await expectCode(() => make(ada, { realmIds: [] }), 'invalid');
	});

	it('rejects Realms that do not exist', async () => {
		await expectCode(() => make(ada, { realmIds: [999] }), 'invalid');
		const { webhook } = await make();
		await expectCode(() => updateWebhook(db, ada, webhook.id, { realmIds: [999] }, env), 'invalid');
	});

	it('creates nothing on a failed create', async () => {
		await expectCode(() => make(ada, { realmIds: [999] }), 'invalid');
		expect(await db.select().from(webhooks)).toHaveLength(0);
	});

	it('rejects a status other than active or paused', async () => {
		const { webhook } = await make();
		await expectCode(
			() => updateWebhook(db, ada, webhook.id, { status: 'disabled' as 'paused' }, env),
			'invalid'
		);
	});

	it('needs WEBHOOK_KEY for every call', async () => {
		const { webhook } = await make();
		env.key = undefined;

		for (const action of [
			() => make(),
			() => listWebhooks(db, ada, ada.id, env),
			() => getWebhook(db, ada, webhook.id, env),
			() => updateWebhook(db, ada, webhook.id, { name: 'x' }, env),
			() => rotateWebhookSecret(db, ada, webhook.id, env),
			() => deleteWebhook(db, ada, webhook.id, env),
			async () => signingSecrets(await row(webhook.id), env)
		]) {
			await expectCode(action, 'invalid', 'webhooks need WEBHOOK_KEY');
		}
		expect(await pauseKeyChanged(db, env)).toBe(0);
	});
});

describe('secrets', () => {
	it('returns the secret once and never in WebhookInfo', async () => {
		const { webhook, secret } = await make();

		expect(secret).toMatch(/^whsec_/);
		expect(JSON.stringify(webhook)).not.toContain(secret);
		expect(JSON.stringify(await getWebhook(db, ada, webhook.id, env))).not.toContain(secret);
		expect(JSON.stringify(await listWebhooks(db, ada, ada.id, env))).not.toContain(secret);
		expect(Object.keys(webhook)).not.toContain('secret');
		expect((await row(webhook.id)).secret).not.toContain(secret);
		expect(signingSecrets(await row(webhook.id), env)).toEqual([secret]);
	});

	it('signs with both secrets for 24 hours after a rotation', async () => {
		const { webhook, secret: first } = await make();

		const { secret: second } = await rotateWebhookSecret(db, ada, webhook.id, env);

		expect(second).not.toBe(first);
		expect(signingSecrets(await row(webhook.id), env)).toEqual([second, first]);
		env.now += 24 * HOUR - 1;
		expect(signingSecrets(await row(webhook.id), env)).toEqual([second, first]);
		env.now += 1;
		expect(signingSecrets(await row(webhook.id), env)).toEqual([second]);
	});

	it('replaces a live previous secret with the current one on a second rotation', async () => {
		const { webhook, secret: first } = await make();
		const { secret: second } = await rotateWebhookSecret(db, ada, webhook.id, env);
		env.now += HOUR;

		const { secret: third } = await rotateWebhookSecret(db, ada, webhook.id, env);

		expect(signingSecrets(await row(webhook.id), env)).toEqual([third, second]);
		expect(signingSecrets(await row(webhook.id), env)).not.toContain(first);
		env.now += 24 * HOUR - 1;
		expect(signingSecrets(await row(webhook.id), env)).toHaveLength(2);
	});

	it('drops a previous secret sealed under another key', async () => {
		const { webhook } = await make();
		env.key = OTHER_KEY;

		const { secret } = await rotateWebhookSecret(db, ada, webhook.id, env);

		expect((await row(webhook.id)).previousSecret).toBeNull();
		expect(signingSecrets(await row(webhook.id), env)).toEqual([secret]);
	});
});

describe('key change', () => {
	it('pauses Webhooks sealed under another key', async () => {
		const stale = (await make()).webhook;
		const paused = (await make()).webhook;
		await updateWebhook(db, ada, paused.id, { status: 'paused' }, env);
		env.key = OTHER_KEY;
		const fresh = (await make(bob)).webhook;

		expect(await pauseKeyChanged(db, env)).toBe(2);

		expect(await getWebhook(db, ada, stale.id, env)).toMatchObject({
			status: 'paused',
			statusReason: 'key_changed'
		});
		expect((await getWebhook(db, ada, paused.id, env)).statusReason).toBe('key_changed');
		expect((await getWebhook(db, bob, fresh.id, env)).status).toBe('active');
		expect(await pauseKeyChanged(db, env)).toBe(0);
	});

	it('leaves everything alone under the same key', async () => {
		await make();
		expect(await pauseKeyChanged(db, env)).toBe(0);
	});

	it('refuses to resume until the secret is rotated', async () => {
		const { webhook } = await make();
		env.key = OTHER_KEY;
		await pauseKeyChanged(db, env);

		await expectCode(
			() => updateWebhook(db, ada, webhook.id, { status: 'active' }, env),
			'conflict',
			'rotate the secret first'
		);

		await rotateWebhookSecret(db, ada, webhook.id, env);
		expect((await getWebhook(db, ada, webhook.id, env)).status).toBe('paused');
		const resumed = await updateWebhook(db, ada, webhook.id, { status: 'active' }, env);
		expect(resumed.status).toBe('active');
		expect(resumed.statusReason).toBeNull();
	});
});

describe('pause and resume', () => {
	it('clears failure state and schedules an attempt on resume', async () => {
		const { webhook } = await make();
		await db
			.update(webhooks)
			.set({
				status: 'disabled',
				statusReason: 'failing',
				failingSince: new Date(env.now - HOUR),
				attempts: 7,
				nextAttemptAt: new Date(env.now + HOUR)
			})
			.where(eq(webhooks.id, webhook.id));

		const resumed = await updateWebhook(db, ada, webhook.id, { status: 'active' }, env);

		expect(resumed).toMatchObject({ status: 'active', statusReason: null, failingSince: null });
		expect(resumed.nextAttemptAt).toEqual(new Date(env.now));
		expect((await row(webhook.id)).attempts).toBe(0);
	});

	it('pauses with no reason', async () => {
		const { webhook } = await make();

		const paused = await updateWebhook(db, ada, webhook.id, { status: 'paused' }, env);

		expect(paused).toMatchObject({ status: 'paused', statusReason: null });
	});
});

describe('deletion', () => {
	it('deletes a Webhook', async () => {
		const { webhook } = await make();
		await deleteWebhook(db, ada, webhook.id, env);
		await expectCode(() => getWebhook(db, ada, webhook.id, env), 'not_found');
	});

	it('deletes a User s Webhooks with the User', async () => {
		await make(ada);
		const kept = (await make(bob)).webhook;

		await db.delete(users).where(eq(users.id, ada.id));

		expect((await db.select().from(webhooks)).map((w) => w.id)).toEqual([kept.id]);
	});
});

describe('Events', () => {
	it('records none', async () => {
		const before = (await db.select().from(events)).length;
		const { webhook } = await make();
		await updateWebhook(db, ada, webhook.id, { name: 'a', status: 'paused' }, env);
		await updateWebhook(db, ada, webhook.id, { status: 'active' }, env);
		await rotateWebhookSecret(db, ada, webhook.id, env);
		await listWebhooks(db, ada, ada.id, env);
		env.key = OTHER_KEY;
		await pauseKeyChanged(db, env);
		env.key = KEY;
		await deleteWebhook(db, ada, webhook.id, env);

		expect(await db.select().from(events)).toHaveLength(before);
	});
});

describe('stored secrets', () => {
	it('treats a malformed sealed secret as another key', async () => {
		const { webhook } = await make();
		await db.update(webhooks).set({ secret: 'garbage' }).where(eq(webhooks.id, webhook.id));

		expect(await pauseKeyChanged(db, env)).toBe(1);
	});
});

describe('Realm visibility', () => {
	afterEach(() => setAccessEnforced(false));

	it('answers a Realm the owner cannot see like one that does not exist', async () => {
		const realm = await seedRealm(db);
		setAccessEnforced(true);
		let hidden = '';
		let missing = '';
		try {
			await make(ada, { realmIds: [realm.id] });
		} catch (error) {
			hidden = (error as DomainError).message.replace(String(realm.id), 'N');
		}
		try {
			await make(ada, { realmIds: [999] });
		} catch (error) {
			missing = (error as DomainError).message.replace('999', 'N');
		}
		expect(hidden).not.toBe('');
		expect(hidden).toBe(missing);
	});

	it('keeps a deleted Realm id when the list is sent again', async () => {
		const realm = await seedRealm(db);
		const { webhook } = await make(ada, { realmIds: [realm.id] });
		await deleteRealm(db, ada, realm.id);
		setAccessEnforced(true);
		expect(
			(await updateWebhook(db, ada, webhook.id, { realmIds: [realm.id] }, env)).realmIds
		).toEqual([realm.id]);
	});
});

describe('pause only from active', () => {
	it('leaves a disabled Webhook as sagas set it', async () => {
		const { webhook } = await make();
		await db
			.update(webhooks)
			.set({ status: 'disabled', statusReason: 'failing' })
			.where(eq(webhooks.id, webhook.id));
		const after = await updateWebhook(db, ada, webhook.id, { status: 'paused' }, env);
		expect(after.status).toBe('disabled');
		expect(after.statusReason).toBe('failing');
	});
});
