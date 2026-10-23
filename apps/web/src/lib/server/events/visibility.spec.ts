import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { setAccessEnforced } from '#lib/server/domain/access.ts';
import { addComment } from '#lib/server/domain/comments.ts';
import { createLabour, moveLabour } from '#lib/server/domain/labours.ts';
import { acceptOffer, offerMembership } from '#lib/server/domain/memberships.ts';
import { addQuestLabour, createQuest } from '#lib/server/domain/quests.ts';
import { createRealm } from '#lib/server/domain/realms.ts';
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

const seen = (viewer: { id: number }) =>
	eventsSince(db, 0)
		.map((event) => eventForViewer(db, event, viewer))
		.filter((event) => event !== null)
		.map((event) => event.type);

beforeEach(() => {
	setAccessEnforced(true);
	db = testDb();
	ada = { id: seedUser(db, 'ada') };
	bob = { id: seedUser(db, 'bob') };
	secret = createRealm(db, ada, { name: 'Secret', key: 'SE', initialState: TODO }).id;
	shared = createRealm(db, ada, { name: 'Shared', key: 'SH', initialState: TODO }).id;
	offerMembership(db, ada, shared, bob.id, 'editor');
	acceptOffer(db, bob, shared);
});

afterEach(() => setAccessEnforced(false));

describe('eventForViewer', () => {
	it("hides a private Realm's Events, its Labours and Comments from a non-member", () => {
		const labour = createLabour(db, ada, { realmId: secret, title: 'Hidden', ownerId: ada.id });
		addComment(db, ada, labour.id, 'private note');

		const types = seen(bob);

		expect(types).toContain('realm.created');
		expect(eventsSince(db, 0).filter((e) => e.type === 'realm.created')).toHaveLength(2);
		expect(types.filter((t) => t === 'realm.created')).toHaveLength(1);
		expect(types).not.toContain('labour.created');
		expect(types).not.toContain('labour.commented');
		expect(seen(ada)).toContain('labour.commented');
	});

	it('shows a Labour moved out of sight as deleted, and one moved in as moved', () => {
		const labour = createLabour(db, ada, { realmId: shared, title: 'Travels', ownerId: ada.id });

		moveLabour(db, ada, labour.id, { realmId: secret });
		const out = eventsSince(db, 0)
			.filter((e) => e.type === 'labour.moved')
			.map((e) => eventForViewer(db, e, bob));
		expect(out.map((e) => [e?.type, e && 'id' in e.data ? e.data.id : null])).toEqual([
			['labour.deleted', labour.id]
		]);
	});

	it('trims a Quest to the Labours in Realms the viewer can see, and recounts its progress', () => {
		const open = createLabour(db, ada, { realmId: shared, title: 'Open', ownerId: ada.id });
		const hidden = createLabour(db, ada, { realmId: secret, title: 'Hidden', ownerId: ada.id });
		const quest = createQuest(db, ada, { name: 'Q', ownerId: ada.id });
		addQuestLabour(db, ada, quest.id, open.id);
		addQuestLabour(db, ada, quest.id, hidden.id);

		const last = eventsSince(db, 0)
			.filter((e) => e.type === 'quest.labours_added')
			.at(-1)!;
		const forBob = eventForViewer(db, last, bob)!;
		const forAda = eventForViewer(db, last, ada)!;

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
		createLabour(db, ada, { realmId: secret, title: 'Hidden', ownerId: ada.id });
		const after = eventsSince(db, 0).at(-1)!.seq;

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

		createLabour(db, ada, { realmId: secret, title: 'Hidden', ownerId: ada.id });
		const hiddenSeq = eventsSince(db, 0).at(-1)!.seq;
		let text = '';
		while (!text.includes('event: seq')) text += decoder.decode((await reader.read()).value);
		await reader.cancel();

		expect(text).not.toContain('Hidden');
		expect(text).toContain(`event: seq\ndata: {"seq":${hiddenSeq}}`);
	});
});
