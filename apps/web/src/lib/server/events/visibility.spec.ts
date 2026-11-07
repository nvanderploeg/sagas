import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { createLabour, moveLabour } from '#lib/server/domain/labours.ts';
import { acceptOffer, offerMembership } from '#lib/server/domain/memberships.ts';
import { addQuestLabour, createQuest } from '#lib/server/domain/quests.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
import {
	createScroll,
	deleteScroll,
	moveScroll,
	updateScroll
} from '#lib/server/domain/scrolls.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedUser, TODO } from '#lib/server/test/fixtures.ts';
import { eventsSince } from './log.ts';
import { openEventStream } from './stream.ts';
import { eventForViewer } from './visibility.ts';

let db: Db;
let ada: { id: number };
let bob: { id: number };
let secret: number;
let shared: number;

const seen = async (viewer: { id: number }) =>
	(await Promise.all((await eventsSince(db, 0)).map((event) => eventForViewer(db, event, viewer))))
		.filter((event) => event !== null)
		.map((event) => event.type);

beforeEach(async () => {
	setAccessEnforced(true);
	db = await testDb();
	ada = { id: await seedUser(db, 'ada') };
	bob = { id: await seedUser(db, 'bob') };
	secret = (await createRealm(db, ada, { name: 'Secret', key: 'SE', initialState: TODO })).id;
	shared = (await createRealm(db, ada, { name: 'Shared', key: 'SH', initialState: TODO })).id;
	await offerMembership(db, ada, shared, bob.id, 'editor');
	await acceptOffer(db, bob, shared);
});

afterEach(() => setAccessEnforced(false));

describe('eventForViewer', () => {
	it("sends a Realm's Scroll Events only to its members", async () => {
		for (const realmId of [secret, shared]) {
			const scroll = await createScroll(db, ada, { realmId, title: 'Home' });
			await updateScroll(db, ada, scroll.id, { body: 'x' });
			const other = await createScroll(db, ada, { realmId, title: 'Other' });
			await moveScroll(db, ada, other.id, { parentId: scroll.id });
			await deleteScroll(db, ada, scroll.id, new Map([[other.id, 'delete']]));
		}
		const scrollTypes = async (viewer: { id: number }) =>
			(await seen(viewer)).filter((t) => t.startsWith('scroll.'));
		const once = [
			'scroll.created',
			'scroll.updated',
			'scroll.created',
			'scroll.moved',
			'scroll.deleted'
		];

		expect(await scrollTypes(bob)).toEqual(once);
		expect(await scrollTypes(ada)).toEqual([...once, ...once]);
	});

	it("hides a private Realm's Events, its Labours and Comments from a non-member", async () => {
		const labour = await createLabour(db, ada, {
			realmId: secret,
			title: 'Hidden',
			ownerId: ada.id
		});
		await addComment(db, ada, labour.id, 'private note');

		const types = await seen(bob);

		expect(types).toContain('realm.created');
		expect((await eventsSince(db, 0)).filter((e) => e.type === 'realm.created')).toHaveLength(2);
		expect(types.filter((t) => t === 'realm.created')).toHaveLength(1);
		expect(types).not.toContain('labour.created');
		expect(types).not.toContain('labour.commented');
		expect(await seen(ada)).toContain('labour.commented');
	});

	it('shows a Labour moved out of sight as deleted, and one moved in as moved', async () => {
		const labour = await createLabour(db, ada, {
			realmId: shared,
			title: 'Travels',
			ownerId: ada.id
		});

		await moveLabour(db, ada, labour.id, { realmId: secret });
		const out = await Promise.all(
			(await eventsSince(db, 0))
				.filter((e) => e.type === 'labour.moved')
				.map((e) => eventForViewer(db, e, bob))
		);
		expect(out.map((e) => [e?.type, e && 'id' in e.data ? e.data.id : null])).toEqual([
			['labour.deleted', labour.id]
		]);
	});

	it('trims a Quest to the Labours in Realms the viewer can see, and recounts its progress', async () => {
		const open = await createLabour(db, ada, { realmId: shared, title: 'Open', ownerId: ada.id });
		const hidden = await createLabour(db, ada, {
			realmId: secret,
			title: 'Hidden',
			ownerId: ada.id
		});
		const quest = await createQuest(db, ada, { realmId: shared, name: 'Q', ownerId: ada.id });
		await addQuestLabour(db, ada, quest.id, open.id);
		await addQuestLabour(db, ada, quest.id, hidden.id);

		const last = (await eventsSince(db, 0)).filter((e) => e.type === 'quest.labours_added').at(-1)!;
		const forBob = (await eventForViewer(db, last, bob))!;
		const forAda = (await eventForViewer(db, last, ada))!;

		expect('quest' in forBob.data && forBob.data.quest.labours.map((l) => l.title)).toEqual([
			'Open'
		]);
		expect('quest' in forBob.data && forBob.data.quest.progress.total).toBe(1);
		expect('labourIds' in forBob.data && forBob.data.labourIds).toEqual([]);
		expect('quest' in forAda.data && forAda.data.quest.progress.total).toBe(2);
	});
});

describe('the Event stream for a viewer', () => {
	it("replays only the viewer's Events and says how far it read", async () => {
		await createLabour(db, ada, { realmId: secret, title: 'Hidden', ownerId: ada.id });
		const after = (await eventsSince(db, 0)).at(-1)!.seq;

		const reader = openEventStream(db, { heartbeatMs: 60_000, since: 0, viewer: bob }).getReader();
		const chunks: string[] = [];
		for (;;) {
			const { value } = await reader.read();
			chunks.push(new TextDecoder().decode(value));
			if (chunks.join('').includes('event: ready')) break;
		}
		await reader.cancel();

		const text = chunks.join('');
		expect(text).not.toContain('Hidden');
		expect(text).toContain(`event: ready\ndata: {"seq":${after}}`);
	});

	it('tells a live viewer the seq of Events it may not see, so its views stay current', async () => {
		const reader = openEventStream(db, { heartbeatMs: 5, viewer: bob }).getReader();
		const decoder = new TextDecoder();
		await reader.read();

		await createLabour(db, ada, { realmId: secret, title: 'Hidden', ownerId: ada.id });
		const hiddenSeq = (await eventsSince(db, 0)).at(-1)!.seq;
		let text = '';
		while (!text.includes('event: seq')) text += decoder.decode((await reader.read()).value);
		await reader.cancel();

		expect(text).not.toContain('Hidden');
		expect(text).toContain(`event: seq\ndata: {"seq":${hiddenSeq}}`);
	});
});
