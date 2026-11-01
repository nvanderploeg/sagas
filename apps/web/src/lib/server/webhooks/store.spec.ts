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

beforeEach(() => {
	db = testDb();
	env = { key: KEY, maxPerUser: 10, max: 50, allowPrivate: false, now: Date.UTC(2026, 0, 1) };
	ada = seedHuman(db, 'ada');
	bob = seedHuman(db, 'bob');
	admin = { ...seedHuman(db, 'root'), isAdmin: true };
});

afterEach(() => {
	db.$client.close();
});

function expectCode(action: () => unknown, code: DomainError['code'], message?: string) {
	let thrown: unknown;
	try {
		action();
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

function row(id: number): WebhookRow {
	return db.select().from(webhooks).where(eq(webhooks.id, id)).get()!;
}

describe('permissions', () => {
	it('lets the owner see and change a Webhook', () => {
		const { webhook } = make();

		expect(getWebhook(db, ada, webhook.id, env).ownerId).toBe(ada.id);
		expect(updateWebhook(db, ada, webhook.id, { name: 'renamed' }, env).name).toBe('renamed');
		expect(listWebhooks(db, ada, ada.id, env)).toHaveLength(1);
	});

	it('answers not_found to another User for every call', () => {
		const { webhook } = make();

		expectCode(() => getWebhook(db, bob, webhook.id, env), 'not_found');
		expectCode(() => updateWebhook(db, bob, webhook.id, { name: 'x' }, env), 'not_found');
		expectCode(() => rotateWebhookSecret(db, bob, webhook.id, env), 'not_found');
		expectCode(() => deleteWebhook(db, bob, webhook.id, env), 'not_found');
		expectCode(() => listWebhooks(db, bob, ada.id, env), 'not_found');
		expect(row(webhook.id)).toBeDefined();
	});

	it('answers not_found for a Webhook that does not exist', () => {
		expectCode(() => getWebhook(db, ada, 999, env), 'not_found');
	});

	it('lets an Admin see, change, rotate and delete any Webhook', () => {
		const { webhook } = make();

		expect(getWebhook(db, admin, webhook.id, env).id).toBe(webhook.id);
		expect(listWebhooks(db, admin, ada.id, env)).toHaveLength(1);
		updateWebhook(db, admin, webhook.id, { status: 'paused' }, env);
		rotateWebhookSecret(db, admin, webhook.id, env);
		deleteWebhook(db, admin, webhook.id, env);
		expect(listWebhooks(db, ada, ada.id, env)).toHaveLength(0);
	});

	it('creates for the actor, even an Admin', () => {
		expect(make(admin).webhook.ownerId).toBe(admin.id);
	});
});

describe('limits', () => {
	it('refuses a Webhook past the per-User cap', () => {
		env.maxPerUser = 2;
		make();
		make();

		expectCode(() => make(), 'conflict');
		expect(make(bob).webhook.ownerId).toBe(bob.id);
	});

	it('refuses a Webhook past the instance cap', () => {
		env.max = 2;
		make(ada);
		make(bob);

		expectCode(() => make(admin), 'conflict');
	});
});

describe('cursor and filters', () => {
	it('starts at the last seq assigned', () => {
		const realm = seedRealm(db);
		seedLabour(db, { realmId: realm.id });
		const last = eventWindow(db).last;
		expect(last).toBeGreaterThan(0);

		expect(make().webhook.cursor).toBe(last);
	});

	it('starts at 0 on an empty log', () => {
		expect(make().webhook.cursor).toBe(0);
	});

	it('applies new filters without moving the cursor', () => {
		const realm = seedRealm(db);
		const { webhook } = make();
		seedLabour(db, { realmId: realm.id });

		const updated = updateWebhook(
			db,
			ada,
			webhook.id,
			{ eventTypes: ['labour.created'], realmIds: [realm.id] },
			env
		);

		expect(updated.eventTypes).toEqual(['labour.created']);
		expect(updated.realmIds).toEqual([realm.id]);
		expect(updated.cursor).toBe(webhook.cursor);
		expect(updated.cursor).toBeLessThan(eventWindow(db).last);
	});

	it('clears filters with null', () => {
		const realm = seedRealm(db);
		const { webhook } = make(ada, { eventTypes: ['labour.created'], realmIds: [realm.id] });

		const updated = updateWebhook(db, ada, webhook.id, { eventTypes: null, realmIds: null }, env);

		expect(updated.eventTypes).toBeNull();
		expect(updated.realmIds).toBeNull();
	});
});

describe('validation', () => {
	it('rejects a bad name', () => {
		expectCode(() => make(ada, { name: '  ' }), 'invalid');
		expectCode(() => make(ada, { name: 'x'.repeat(101) }), 'invalid');
		const { webhook } = make();
		expectCode(() => updateWebhook(db, ada, webhook.id, { name: '' }, env), 'invalid');
	});

	it('rejects a bad url', () => {
		expectCode(() => make(ada, { url: 'http://example.com/h' }), 'invalid');
		expectCode(() => make(ada, { url: 'nope' }), 'invalid');
		const { webhook } = make();
		expectCode(() => updateWebhook(db, ada, webhook.id, { url: 'ftp://x.test' }, env), 'invalid');
	});

	it('allows http when private targets are allowed', () => {
		env.allowPrivate = true;
		expect(make(ada, { url: 'http://localhost:9000/h' }).webhook.url).toBe(
			'http://localhost:9000/h'
		);
	});

	it('rejects unknown event types and empty lists', () => {
		expectCode(() => make(ada, { eventTypes: ['nope.nothing'] }), 'invalid');
		expectCode(() => make(ada, { eventTypes: [] }), 'invalid');
		expectCode(() => make(ada, { realmIds: [] }), 'invalid');
	});

	it('rejects Realms that do not exist', () => {
		expectCode(() => make(ada, { realmIds: [999] }), 'invalid');
		const { webhook } = make();
		expectCode(() => updateWebhook(db, ada, webhook.id, { realmIds: [999] }, env), 'invalid');
	});

	it('creates nothing on a failed create', () => {
		expectCode(() => make(ada, { realmIds: [999] }), 'invalid');
		expect(db.select().from(webhooks).all()).toHaveLength(0);
	});

	it('rejects a status other than active or paused', () => {
		const { webhook } = make();
		expectCode(
			() => updateWebhook(db, ada, webhook.id, { status: 'disabled' as 'paused' }, env),
			'invalid'
		);
	});

	it('needs WEBHOOK_KEY for every call', () => {
		const { webhook } = make();
		env.key = undefined;

		for (const action of [
			() => make(),
			() => listWebhooks(db, ada, ada.id, env),
			() => getWebhook(db, ada, webhook.id, env),
			() => updateWebhook(db, ada, webhook.id, { name: 'x' }, env),
			() => rotateWebhookSecret(db, ada, webhook.id, env),
			() => deleteWebhook(db, ada, webhook.id, env),
			() => signingSecrets(row(webhook.id), env)
		]) {
			expectCode(action, 'invalid', 'webhooks need WEBHOOK_KEY');
		}
		expect(pauseKeyChanged(db, env)).toBe(0);
	});
});

describe('secrets', () => {
	it('returns the secret once and never in WebhookInfo', () => {
		const { webhook, secret } = make();

		expect(secret).toMatch(/^whsec_/);
		expect(JSON.stringify(webhook)).not.toContain(secret);
		expect(JSON.stringify(getWebhook(db, ada, webhook.id, env))).not.toContain(secret);
		expect(JSON.stringify(listWebhooks(db, ada, ada.id, env))).not.toContain(secret);
		expect(Object.keys(webhook)).not.toContain('secret');
		expect(row(webhook.id).secret).not.toContain(secret);
		expect(signingSecrets(row(webhook.id), env)).toEqual([secret]);
	});

	it('signs with both secrets for 24 hours after a rotation', () => {
		const { webhook, secret: first } = make();

		const { secret: second } = rotateWebhookSecret(db, ada, webhook.id, env);

		expect(second).not.toBe(first);
		expect(signingSecrets(row(webhook.id), env)).toEqual([second, first]);
		env.now += 24 * HOUR - 1;
		expect(signingSecrets(row(webhook.id), env)).toEqual([second, first]);
		env.now += 1;
		expect(signingSecrets(row(webhook.id), env)).toEqual([second]);
	});

	it('replaces a live previous secret with the current one on a second rotation', () => {
		const { webhook, secret: first } = make();
		const { secret: second } = rotateWebhookSecret(db, ada, webhook.id, env);
		env.now += HOUR;

		const { secret: third } = rotateWebhookSecret(db, ada, webhook.id, env);

		expect(signingSecrets(row(webhook.id), env)).toEqual([third, second]);
		expect(signingSecrets(row(webhook.id), env)).not.toContain(first);
		env.now += 24 * HOUR - 1;
		expect(signingSecrets(row(webhook.id), env)).toHaveLength(2);
	});

	it('drops a previous secret sealed under another key', () => {
		const { webhook } = make();
		env.key = OTHER_KEY;

		const { secret } = rotateWebhookSecret(db, ada, webhook.id, env);

		expect(row(webhook.id).previousSecret).toBeNull();
		expect(signingSecrets(row(webhook.id), env)).toEqual([secret]);
	});
});

describe('key change', () => {
	it('pauses Webhooks sealed under another key', () => {
		const stale = make().webhook;
		const paused = make().webhook;
		updateWebhook(db, ada, paused.id, { status: 'paused' }, env);
		env.key = OTHER_KEY;
		const fresh = make(bob).webhook;

		expect(pauseKeyChanged(db, env)).toBe(2);

		expect(getWebhook(db, ada, stale.id, env)).toMatchObject({
			status: 'paused',
			statusReason: 'key_changed'
		});
		expect(getWebhook(db, ada, paused.id, env).statusReason).toBe('key_changed');
		expect(getWebhook(db, bob, fresh.id, env).status).toBe('active');
		expect(pauseKeyChanged(db, env)).toBe(0);
	});

	it('leaves everything alone under the same key', () => {
		make();
		expect(pauseKeyChanged(db, env)).toBe(0);
	});

	it('refuses to resume until the secret is rotated', () => {
		const { webhook } = make();
		env.key = OTHER_KEY;
		pauseKeyChanged(db, env);

		expectCode(
			() => updateWebhook(db, ada, webhook.id, { status: 'active' }, env),
			'conflict',
			'rotate the secret first'
		);

		rotateWebhookSecret(db, ada, webhook.id, env);
		expect(getWebhook(db, ada, webhook.id, env).status).toBe('paused');
		const resumed = updateWebhook(db, ada, webhook.id, { status: 'active' }, env);
		expect(resumed.status).toBe('active');
		expect(resumed.statusReason).toBeNull();
	});
});

describe('pause and resume', () => {
	it('clears failure state and schedules an attempt on resume', () => {
		const { webhook } = make();
		db.update(webhooks)
			.set({
				status: 'disabled',
				statusReason: 'failing',
				failingSince: new Date(env.now - HOUR),
				attempts: 7,
				nextAttemptAt: new Date(env.now + HOUR)
			})
			.where(eq(webhooks.id, webhook.id))
			.run();

		const resumed = updateWebhook(db, ada, webhook.id, { status: 'active' }, env);

		expect(resumed).toMatchObject({ status: 'active', statusReason: null, failingSince: null });
		expect(resumed.nextAttemptAt).toEqual(new Date(env.now));
		expect(row(webhook.id).attempts).toBe(0);
	});

	it('pauses with no reason', () => {
		const { webhook } = make();

		const paused = updateWebhook(db, ada, webhook.id, { status: 'paused' }, env);

		expect(paused).toMatchObject({ status: 'paused', statusReason: null });
	});
});

describe('deletion', () => {
	it('deletes a Webhook', () => {
		const { webhook } = make();
		deleteWebhook(db, ada, webhook.id, env);
		expectCode(() => getWebhook(db, ada, webhook.id, env), 'not_found');
	});

	it('deletes a User s Webhooks with the User', () => {
		make(ada);
		const kept = make(bob).webhook;

		db.delete(users).where(eq(users.id, ada.id)).run();

		expect(
			db
				.select()
				.from(webhooks)
				.all()
				.map((w) => w.id)
		).toEqual([kept.id]);
	});
});

describe('Events', () => {
	it('records none', () => {
		const before = db.select().from(events).all().length;
		const { webhook } = make();
		updateWebhook(db, ada, webhook.id, { name: 'a', status: 'paused' }, env);
		updateWebhook(db, ada, webhook.id, { status: 'active' }, env);
		rotateWebhookSecret(db, ada, webhook.id, env);
		listWebhooks(db, ada, ada.id, env);
		env.key = OTHER_KEY;
		pauseKeyChanged(db, env);
		env.key = KEY;
		deleteWebhook(db, ada, webhook.id, env);

		expect(db.select().from(events).all()).toHaveLength(before);
	});
});

describe('stored secrets', () => {
	it('treats a malformed sealed secret as another key', () => {
		const { webhook } = make();
		db.update(webhooks).set({ secret: 'garbage' }).where(eq(webhooks.id, webhook.id)).run();

		expect(pauseKeyChanged(db, env)).toBe(1);
	});
});

describe('Realm visibility', () => {
	afterEach(() => setAccessEnforced(false));

	it('answers a Realm the owner cannot see like one that does not exist', () => {
		const realm = seedRealm(db);
		setAccessEnforced(true);
		let hidden = '';
		let missing = '';
		try {
			make(ada, { realmIds: [realm.id] });
		} catch (error) {
			hidden = (error as DomainError).message.replace(String(realm.id), 'N');
		}
		try {
			make(ada, { realmIds: [999] });
		} catch (error) {
			missing = (error as DomainError).message.replace('999', 'N');
		}
		expect(hidden).not.toBe('');
		expect(hidden).toBe(missing);
	});

	it('keeps a deleted Realm id when the list is sent again', () => {
		const realm = seedRealm(db);
		const { webhook } = make(ada, { realmIds: [realm.id] });
		deleteRealm(db, ada, realm.id);
		setAccessEnforced(true);
		expect(updateWebhook(db, ada, webhook.id, { realmIds: [realm.id] }, env).realmIds).toEqual([
			realm.id
		]);
	});
});

describe('pause only from active', () => {
	it('leaves a disabled Webhook as sagas set it', () => {
		const { webhook } = make();
		db.update(webhooks)
			.set({ status: 'disabled', statusReason: 'failing' })
			.where(eq(webhooks.id, webhook.id))
			.run();
		const after = updateWebhook(db, ada, webhook.id, { status: 'paused' }, env);
		expect(after.status).toBe('disabled');
		expect(after.statusReason).toBe('failing');
	});
});
