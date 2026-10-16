import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { events, labours, mentions } from '#lib/server/db/schema.ts';
import { addComment, deleteComment, editComment } from '#lib/server/domain/comments.ts';
import { deleteLabour, labourKeyOf, moveLabour, updateLabour } from '#lib/server/domain/labours.ts';
import { deleteRealm, renameRealmKey } from '#lib/server/domain/realms.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { readAppraisal } from './appraisals.ts';

let db: Db;
let actor: Actor;
let ada: number;
let bob: number;
let amId: number;
let target: { id: number };

const T1 = new Date('2030-01-01T00:00:00.000Z');
const T2 = new Date('2030-02-01T00:00:00.000Z');
const T3 = new Date('2030-03-01T00:00:00.000Z');

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T1);
	db = testDb();
	actor = seedActor(db);
	ada = seedUser(db, 'ada');
	bob = seedUser(db, 'bob');
	amId = seedRealm(db, 'AM').id;
	target = seedLabour(db, { realmId: amId, title: 'Target', ownerId: ada });
});

afterEach(() => {
	vi.useRealTimers();
	db.$client.close();
});

function expectDomainError(action: () => unknown, code: DomainError['code']) {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
}

const rowsFrom = (sourceId: number) =>
	db
		.select()
		.from(mentions)
		.where(eq(mentions.sourceLabourId, sourceId))
		.orderBy(asc(mentions.id))
		.all();

const allRows = () => db.select().from(mentions).orderBy(asc(mentions.id)).all();

const labourTargets = (sourceId: number) =>
	rowsFrom(sourceId)
		.map((row) => row.labourId)
		.filter((id) => id !== null);

const userTargets = (sourceId: number) =>
	rowsFrom(sourceId)
		.map((row) => row.userId)
		.filter((id) => id !== null);

const source = (description: string, ownerId = ada) =>
	seedLabour(db, { realmId: amId, title: 'Source', description, ownerId });

const eventCount = () => db.select().from(events).all().length;

const updatedAtOf = (labourId: number) =>
	db.select().from(labours).where(eq(labours.id, labourId)).get()!.updatedAt;

describe('Labour keys', () => {
	it.each([
		['AM-1'],
		['see AM-1.'],
		['(/l/AM-1)'],
		['am-1'],
		['Am-1'],
		['AM-1, AM-1'],
		['x.AM-1'],
		['[AM-1]'],
		['#AM-1'],
		['a/AM-1'],
		['AM-1:'],
		['AM-1-2'],
		['AM-1.5'],
		['line one\nAM-1\nline three']
	])('mentions AM-1 in %j', (text) => {
		const labour = source(text);

		expect(labourTargets(labour.id)).toEqual([target.id]);
	});

	it.each([
		['XAM-1x'],
		['XAM-1'],
		['xAM-1'],
		['1AM-1'],
		['_AM-1'],
		['-AM-1'],
		['x-AM-1'],
		['AM-1x'],
		['AM-1a'],
		['AM-1_'],
		['AM-1_x'],
		['AM-11'],
		['AM-10'],
		['AM-01'],
		['AM-0'],
		['AM1'],
		['AM -1'],
		['AM-']
	])('does not mention AM-1 in %j', (text) => {
		const labour = source(text);

		expect(rowsFrom(labour.id)).toEqual([]);
	});

	it('mentions AM-12, not AM-1, in AM-12', () => {
		const made = Array.from({ length: 11 }, () => seedLabour(db, { realmId: amId }));
		const twelfth = made[10];
		expect(labourKeyOf(db, twelfth)).toBe('AM-12');

		const labour = source('see AM-12');

		expect(labourTargets(labour.id)).toEqual([twelfth.id]);
	});

	it('reads Realm keys of 2 to 6 letters and digits', () => {
		const long = seedRealm(db, 'ABCDEF');
		const withDigits = seedRealm(db, 'P2');
		const longTarget = seedLabour(db, { realmId: long.id });
		const digitTarget = seedLabour(db, { realmId: withDigits.id });

		const labour = source('ABCDEF-1 and P2-1');

		expect(labourTargets(labour.id).sort()).toEqual([longTarget.id, digitTarget.id].sort());
	});

	it('does not read a longer run of letters as a shorter Realm key', () => {
		const long = seedRealm(db, 'ABCDEF');
		seedLabour(db, { realmId: long.id });

		const labour = source('ABCDEFG-1');

		expect(rowsFrom(labour.id)).toEqual([]);
	});

	it('resolves a Labour through the key it held before a move', () => {
		const bl = seedRealm(db, 'BL');
		moveLabour(db, actor, target.id, { realmId: bl.id });

		const labour = source('old key AM-1');
		const other = source('new key BL-1');

		expect(labourTargets(labour.id)).toEqual([target.id]);
		expect(labourTargets(other.id)).toEqual([target.id]);
	});

	it('resolves a Labour through the key it held before a Realm key rename', () => {
		renameRealmKey(db, actor, amId, 'ZZ');

		const labour = source('old AM-1');
		const other = source('new zz-1');

		expect(labourTargets(labour.id)).toEqual([target.id]);
		expect(labourTargets(other.id)).toEqual([target.id]);
	});

	it('counts a Labour named by two of its keys as one Mention', () => {
		const bl = seedRealm(db, 'BL');
		moveLabour(db, actor, target.id, { realmId: bl.id });

		const labour = source('AM-1 is now BL-1');

		expect(rowsFrom(labour.id)).toHaveLength(1);
	});

	it('skips a key no Labour has held', () => {
		const labour = source('AM-999 and ZZ-1');

		expect(rowsFrom(labour.id)).toEqual([]);
	});

	it('skips a Labour naming itself, by current key or Alias', () => {
		const labour = source('placeholder');
		const bl = seedRealm(db, 'BL');
		const oldKey = labourKeyOf(db, labour);
		const newKey = moveLabour(db, actor, labour.id, { realmId: bl.id }).key;
		expect(newKey).toBe('BL-1');

		updateLabour(db, actor, labour.id, { description: `${oldKey} ${newKey} and AM-1` });

		expect(labourTargets(labour.id)).toEqual([target.id]);
	});

	it('makes one Mention of a Labour named twice in one text', () => {
		const labour = source('AM-1 and am-1 and AM-1 again');

		expect(rowsFrom(labour.id)).toHaveLength(1);
	});

	it('makes a Mention per text: the description and each Comment count separately', () => {
		const labour = source('AM-1');
		addComment(db, actor, labour.id, 'also AM-1');
		addComment(db, actor, labour.id, 'and AM-1 once more, AM-1');

		const rows = rowsFrom(labour.id);

		expect(rows).toHaveLength(3);
		expect(rows.filter((row) => row.commentId === null)).toHaveLength(1);
		expect(new Set(rows.map((row) => row.commentId)).size).toBe(3);
	});

	it('sets exactly one of labourId and userId on every row', () => {
		const labour = source('AM-1 and @ada and @bob');
		addComment(db, actor, labour.id, 'AM-1 @ada');

		const rows = rowsFrom(labour.id);

		expect(rows).toHaveLength(5);
		for (const row of rows) {
			expect((row.labourId === null) !== (row.userId === null)).toBe(true);
			expect(row.sourceLabourId).toBe(labour.id);
		}
	});
});

describe('@username', () => {
	it.each([
		['@ada'],
		['hi @ada'],
		['hi @ada, thanks'],
		['(@ada)'],
		['cc:@ada'],
		['@ADA'],
		['@Ada!'],
		['@ada.'],
		['@@ada'],
		['line\n@ada'],
		['@ada-'],
		['@ada_'],
		['@ada--'],
		['@ada_-_'],
		['@ada-.']
	])('mentions ada in %j', (text) => {
		const labour = source(text);

		expect(userTargets(labour.id)).toEqual([ada]);
	});

	it.each([
		['write ada@bob.com'],
		['a@ada'],
		['1@ada'],
		['_@ada'],
		['file.@ada'],
		['@adax'],
		['@ad'],
		['@ada-bob'],
		['@ada_bob'],
		['@']
	])('does not mention anyone in %j', (text) => {
		const labour = source(text);

		expect(rowsFrom(labour.id)).toEqual([]);
	});

	it('does not mention a User whose name is a single character', () => {
		seedUser(db, 'a');

		const labour = source('hello @a');

		expect(rowsFrom(labour.id)).toEqual([]);
	});

	it('mentions several Users once each', () => {
		const labour = source('@ada @bob @ADA again');

		expect(userTargets(labour.id).sort()).toEqual([ada, bob].sort());
	});

	it('prefers a User named exactly, trailing dash included, over the trimmed name', () => {
		const dashed = seedUser(db, 'ada-');

		const labour = source('ping @ada-');

		expect(userTargets(labour.id)).toEqual([dashed]);
	});

	it('mentions a User whose name is 32 characters', () => {
		const longName = `u${'x'.repeat(31)}`;
		const long = seedUser(db, longName);

		const labour = source(`@${longName}`);

		expect(userTargets(labour.id)).toEqual([long]);
	});

	it('skips a name that is not a User', () => {
		const labour = source('@nobody and @ada');

		expect(userTargets(labour.id)).toEqual([ada]);
	});

	it('mentions Users from a Comment, attributed to the Comment author', () => {
		const labour = source('plain');

		const comment = addComment(db, { id: bob }, labour.id, 'thanks @ada');

		expect(rowsFrom(labour.id)).toMatchObject([
			{ userId: ada, labourId: null, commentId: comment.id, authorId: bob }
		]);
	});

	it('keeps Labour and User Mentions of one text side by side', () => {
		const labour = source('AM-1 reported by @ada');

		expect(labourTargets(labour.id)).toEqual([target.id]);
		expect(userTargets(labour.id)).toEqual([ada]);
	});
});

describe('refreshing', () => {
	it('records a description Mention at creation with the Labour createdAt and the acting User', () => {
		vi.setSystemTime(T2);

		const labour = source('AM-1', bob);

		expect(rowsFrom(labour.id)).toMatchObject([
			{
				sourceLabourId: labour.id,
				commentId: null,
				labourId: target.id,
				userId: null,
				authorId: actor.id
			}
		]);
		expect(rowsFrom(labour.id)[0].firstSeenAt).toEqual(labour.createdAt);
		expect(rowsFrom(labour.id)[0].firstSeenAt).toEqual(T2);
	});

	it('records a new description target at update with the update time and the updating User', () => {
		const labour = source('AM-1', bob);
		vi.setSystemTime(T2);

		updateLabour(db, { id: bob }, labour.id, { description: 'AM-1 and @ada' });

		const [kept, added] = rowsFrom(labour.id);
		expect(kept).toMatchObject({ labourId: target.id, authorId: actor.id });
		expect(kept.firstSeenAt).toEqual(T1);
		expect(added).toMatchObject({ userId: ada, authorId: bob });
		expect(added.firstSeenAt).toEqual(T2);
		expect(added.firstSeenAt).toEqual(updatedAtOf(labour.id));
	});

	it('keeps the row, firstSeenAt and authorId of a target the new description still names', () => {
		const labour = source('AM-1 first');
		const before = rowsFrom(labour.id);
		vi.setSystemTime(T2);

		updateLabour(db, { id: bob }, labour.id, { description: 'a different sentence about am-1' });

		expect(rowsFrom(labour.id)).toEqual(before);
	});

	it('deletes the row of a target the new description no longer names', () => {
		const labour = source('AM-1 and @ada');

		updateLabour(db, actor, labour.id, { description: 'just @ada' });

		expect(labourTargets(labour.id)).toEqual([]);
		expect(userTargets(labour.id)).toEqual([ada]);
	});

	it('deletes every description Mention when the description is cleared, and no Comment one', () => {
		const labour = source('AM-1');
		const comment = addComment(db, actor, labour.id, 'AM-1');

		updateLabour(db, actor, labour.id, { description: '' });

		expect(rowsFrom(labour.id)).toMatchObject([{ commentId: comment.id }]);
	});

	it('leaves Mentions alone when an update changes only the title', () => {
		const labour = source('AM-1 @ada');
		const before = rowsFrom(labour.id);
		vi.setSystemTime(T2);

		updateLabour(db, { id: bob }, labour.id, { title: 'Retitled' });

		expect(rowsFrom(labour.id)).toEqual(before);
	});

	it('records a Comment Mention at add with the Comment createdAt and author', () => {
		const labour = source('plain');
		vi.setSystemTime(T2);

		const comment = addComment(db, { id: bob }, labour.id, 'see AM-1');

		expect(rowsFrom(labour.id)).toMatchObject([
			{ commentId: comment.id, labourId: target.id, authorId: bob }
		]);
		expect(rowsFrom(labour.id)[0].firstSeenAt).toEqual(comment.createdAt);
		expect(rowsFrom(labour.id)[0].firstSeenAt).toEqual(T2);
	});

	it('records a new target at Comment edit with the Comment updatedAt and its author', () => {
		const labour = source('plain');
		const comment = addComment(db, { id: bob }, labour.id, 'see AM-1');
		vi.setSystemTime(T2);

		const edited = editComment(db, { id: bob }, comment.id, 'see AM-1 and @ada');

		const [kept, added] = rowsFrom(labour.id);
		expect(kept).toMatchObject({ labourId: target.id, authorId: bob });
		expect(kept.firstSeenAt).toEqual(T1);
		expect(added).toMatchObject({ userId: ada, commentId: comment.id, authorId: bob });
		expect(added.firstSeenAt).toEqual(T2);
		expect(added.firstSeenAt).toEqual(edited.updatedAt);
	});

	it('keeps the row of a target a Comment edit still names and deletes the one it drops', () => {
		const labour = source('plain');
		const comment = addComment(db, actor, labour.id, 'AM-1 and @ada');
		const [keptBefore] = rowsFrom(labour.id);
		vi.setSystemTime(T2);

		editComment(db, actor, comment.id, 'reworded: am-1');

		expect(rowsFrom(labour.id)).toEqual([keptBefore]);
	});

	it('refreshes only the edited Comment', () => {
		const labour = source('AM-1');
		const first = addComment(db, actor, labour.id, 'AM-1');
		const second = addComment(db, actor, labour.id, 'AM-1');
		const before = rowsFrom(labour.id);

		editComment(db, actor, second.id, 'nothing here now');

		expect(rowsFrom(labour.id)).toEqual(before.filter((row) => row.commentId !== second.id));
		expect(rowsFrom(labour.id).map((row) => row.commentId)).toEqual([null, first.id]);
	});

	it('deletes a Comment Mentions with the Comment and no others', () => {
		const labour = source('AM-1 @ada');
		const doomed = addComment(db, actor, labour.id, 'AM-1 @ada');
		const kept = addComment(db, actor, labour.id, 'AM-1');

		deleteComment(db, actor, doomed.id);

		const shape = rowsFrom(labour.id)
			.map((row) => `${row.commentId}:${row.labourId}:${row.userId}`)
			.sort();
		expect(shape).toEqual(
			[`null:${target.id}:null`, `null:null:${ada}`, `${kept.id}:${target.id}:null`].sort()
		);
	});

	it('gains a Mention of a Labour created after the text only when the text is next written', () => {
		const labour = source('look at AM-3');
		const comment = addComment(db, actor, labour.id, 'and AM-3');
		const later = seedLabour(db, { realmId: amId });
		expect(labourKeyOf(db, later)).toBe('AM-3');
		expect(rowsFrom(labour.id)).toEqual([]);

		updateLabour(db, actor, labour.id, { description: 'look at AM-3 again' });
		expect(rowsFrom(labour.id)).toMatchObject([{ labourId: later.id, commentId: null }]);

		editComment(db, actor, comment.id, 'and AM-3 too');
		expect(rowsFrom(labour.id)).toMatchObject([
			{ labourId: later.id, commentId: null },
			{ labourId: later.id, commentId: comment.id }
		]);
	});

	it('gains a Mention of a User created after the text only when the text is next written', () => {
		const labour = source('hello @carol');
		const comment = addComment(db, actor, labour.id, 'cc @carol');
		const carol = seedUser(db, 'carol');
		expect(rowsFrom(labour.id)).toEqual([]);

		updateLabour(db, actor, labour.id, { description: 'hello @carol, again' });
		expect(rowsFrom(labour.id)).toMatchObject([{ userId: carol, commentId: null }]);

		editComment(db, actor, comment.id, 'cc @carol please');
		expect(rowsFrom(labour.id)).toMatchObject([
			{ userId: carol, commentId: null },
			{ userId: carol, commentId: comment.id }
		]);
	});

	it('keeps Mentions when the mentioned Labour moves', () => {
		const labour = source('AM-1');
		const bl = seedRealm(db, 'BL');
		const before = rowsFrom(labour.id);

		moveLabour(db, actor, target.id, { realmId: bl.id });

		expect(rowsFrom(labour.id)).toEqual(before);
	});

	it('leaves the Mentions as they were when a write is refused', () => {
		const labour = source('AM-1');
		const comment = addComment(db, actor, labour.id, 'AM-1 @ada');
		const before = allRows();

		expectDomainError(
			() => updateLabour(db, actor, labour.id, { title: '   ', description: '@bob' }),
			'invalid'
		);
		expectDomainError(
			() => updateLabour(db, actor, labour.id, { description: `@bob ${'x'.repeat(50_001)}` }),
			'invalid'
		);
		expectDomainError(() => addComment(db, actor, labour.id, '   '), 'invalid');
		expectDomainError(() => editComment(db, { id: bob }, comment.id, '@bob'), 'forbidden');
		expectDomainError(() => deleteComment(db, { id: bob }, comment.id), 'forbidden');

		expect(allRows()).toEqual(before);
	});

	it('records no Event and moves no updatedAt beyond the board write itself', () => {
		const labour = source('plain');
		const stamped = updatedAtOf(labour.id);
		vi.setSystemTime(T2);

		const beforeAdd = eventCount();
		addComment(db, actor, labour.id, 'AM-1 @ada');
		expect(eventCount()).toBe(beforeAdd + 1);
		expect(updatedAtOf(labour.id)).toEqual(stamped);

		const beforeUpdate = eventCount();
		updateLabour(db, actor, labour.id, { description: 'AM-1 @ada @bob' });
		expect(eventCount()).toBe(beforeUpdate + 1);
		expect(updatedAtOf(labour.id)).toEqual(T2);
	});
});

describe('removal', () => {
	it('removes the Mentions a deleted Labour made', () => {
		const labour = source('AM-1 @ada');
		addComment(db, actor, labour.id, 'AM-1');

		deleteLabour(db, actor, labour.id);

		expect(allRows()).toEqual([]);
	});

	it('removes the Mentions of a deleted Labour', () => {
		const labour = source('AM-1');
		const keeper = source('@ada');

		deleteLabour(db, actor, target.id);

		expect(rowsFrom(labour.id)).toEqual([]);
		expect(rowsFrom(keeper.id)).toHaveLength(1);
	});

	it('removes the Mentions made by and of the Labours of a deleted Realm', () => {
		const bl = seedRealm(db, 'BL');
		const inBl = seedLabour(db, { realmId: bl.id, description: 'AM-1 @ada' });
		const fromAm = source('BL-1');
		const untouched = source('AM-1 @bob');

		deleteRealm(db, actor, bl.id);

		expect(rowsFrom(inBl.id)).toEqual([]);
		expect(rowsFrom(fromAm.id)).toEqual([]);
		expect(rowsFrom(untouched.id)).toHaveLength(2);
	});
});

describe('readAppraisal mentions', () => {
	function insertMention(row: {
		sourceLabourId: number;
		commentId?: number | null;
		labourId?: number | null;
		userId?: number | null;
		authorId: number;
		firstSeenAt: Date;
	}) {
		return db
			.insert(mentions)
			.values({ commentId: null, labourId: null, userId: null, ...row })
			.returning()
			.get();
	}

	it('is empty when nothing mentions the Labour', () => {
		expect(readAppraisal(db, target.id).mentions).toEqual([]);
	});

	it('lists a description Mention and a Comment Mention of the Labour', () => {
		const fromDescription = source('AM-1');
		vi.setSystemTime(T2);
		const host = source('plain');
		const comment = addComment(db, { id: bob }, host.id, 'AM-1');

		const found = readAppraisal(db, target.id).mentions;

		expect(found).toEqual([
			{ sourceLabourId: host.id, commentId: comment.id, authorId: bob, firstSeenAt: T2 },
			{ sourceLabourId: fromDescription.id, commentId: null, authorId: actor.id, firstSeenAt: T1 }
		]);
		expect(found[0].firstSeenAt).toBeInstanceOf(Date);
	});

	it('leaves out Mentions of Users and Mentions the Labour itself makes', () => {
		source('@ada');
		const other = source('plain');
		updateLabour(db, actor, target.id, { description: `@ada and ${labourKeyOf(db, other)}` });

		expect(readAppraisal(db, target.id).mentions).toEqual([]);
		expect(readAppraisal(db, other.id).mentions).toHaveLength(1);
	});

	it('orders newest firstSeenAt first, whatever the row ids', () => {
		const a = source('plain');
		const b = source('plain');
		const c = source('plain');
		insertMention({ sourceLabourId: a.id, labourId: target.id, authorId: ada, firstSeenAt: T2 });
		insertMention({ sourceLabourId: b.id, labourId: target.id, authorId: ada, firstSeenAt: T3 });
		insertMention({ sourceLabourId: c.id, labourId: target.id, authorId: ada, firstSeenAt: T1 });

		expect(readAppraisal(db, target.id).mentions.map((m) => m.sourceLabourId)).toEqual([
			b.id,
			a.id,
			c.id
		]);
	});

	it('breaks a firstSeenAt tie with the higher row id first', () => {
		const a = source('plain');
		const b = source('plain');
		const c = source('plain');
		insertMention({ sourceLabourId: b.id, labourId: target.id, authorId: ada, firstSeenAt: T2 });
		insertMention({ sourceLabourId: c.id, labourId: target.id, authorId: ada, firstSeenAt: T2 });
		insertMention({ sourceLabourId: a.id, labourId: target.id, authorId: ada, firstSeenAt: T2 });

		expect(readAppraisal(db, target.id).mentions.map((m) => m.sourceLabourId)).toEqual([
			a.id,
			c.id,
			b.id
		]);
	});

	it('returns at most the 10 newest', () => {
		const sources = Array.from({ length: 12 }, () => source('plain'));
		sources.forEach((labour, index) => {
			insertMention({
				sourceLabourId: labour.id,
				labourId: target.id,
				authorId: ada,
				firstSeenAt: new Date(T1.getTime() + index * 1000)
			});
		});

		const found = readAppraisal(db, target.id).mentions;

		expect(found).toHaveLength(10);
		expect(found.map((m) => m.sourceLabourId)).toEqual(
			sources
				.slice(2)
				.reverse()
				.map((labour) => labour.id)
		);
	});
});
