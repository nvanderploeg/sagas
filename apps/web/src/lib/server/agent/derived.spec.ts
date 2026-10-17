import { asc, eq } from 'drizzle-orm';
import { generateNKeysBetween } from 'fractional-indexing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import {
	comments,
	derivedBuilds,
	events,
	labourInputs,
	labours,
	mentions
} from '#lib/server/db/schema.ts';
import { addComment, editComment } from '#lib/server/domain/comments.ts';
import { createLabour, moveLabour } from '#lib/server/domain/labours.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise } from './appraisals.ts';
import { defineAttribute } from './attributes.ts';
import { DERIVED_VERSIONS, rebuildDerived } from './derived.ts';
import { inputHash } from './vectors/input.ts';

let db: Db;
let actor: Actor;
let ada: number;
let bob: number;
let amId: number;
let target: { id: number };

const T1 = new Date('2030-01-01T00:00:00.000Z');
const T2 = new Date('2030-02-01T00:00:00.000Z');
const T3 = new Date('2030-03-01T00:00:00.000Z');
const BUILT = new Date('2031-01-01T00:00:00.000Z');
const REBUILT = new Date('2032-01-01T00:00:00.000Z');

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

type TextRow = {
	id: number;
	title: string;
	brief: string;
	description: string;
	comments: string;
	notes: string;
};

const textRows = () =>
	db.$client
		.prepare(
			'SELECT rowid AS id, title, brief, description, comments, notes FROM labour_text ORDER BY rowid'
		)
		.all() as TextRow[];

const wipeText = () => db.$client.prepare('DELETE FROM labour_text').run();

const mentionRows = () => db.select().from(mentions).orderBy(asc(mentions.id)).all();

const shape = (rows: (typeof mentions.$inferSelect)[]) =>
	rows
		.map(
			(row) =>
				`${row.sourceLabourId}|${row.commentId}|${row.labourId}|${row.userId}|${row.authorId}|${row.firstSeenAt.getTime()}`
		)
		.sort();

const row = (
	sourceLabourId: number,
	commentId: number | null,
	labourId: number | null,
	userId: number | null,
	authorId: number,
	firstSeenAt: Date
) => `${sourceLabourId}|${commentId}|${labourId}|${userId}|${authorId}|${firstSeenAt.getTime()}`;

const buildRecords = () => db.select().from(derivedBuilds).orderBy(asc(derivedBuilds.name)).all();

const eventCount = () => db.select().from(events).all().length;

function setBody(labourId: number, description: string) {
	db.update(labours).set({ description }).where(eq(labours.id, labourId)).run();
}

// Text in every column of labour_text, Mentions of both kinds and of Comments, written through
// the board and agent writes at three different times.
function buildWorld() {
	const bl = seedRealm(db, 'BL');
	const other = seedLabour(db, { realmId: bl.id, title: 'Other realm', ownerId: bob });
	defineAttribute(db, actor, amId, { key: 'repro', kind: 'text', label: 'Repro', rubric: 'Steps' });
	defineAttribute(db, actor, amId, {
		key: 'context',
		kind: 'text',
		label: 'Context',
		rubric: 'Where seen',
		index: 0
	});
	defineAttribute(db, actor, amId, {
		key: 'severity',
		kind: 'scale',
		label: 'Severity',
		rubric: 'How bad',
		spec: { min: 1, max: 5 }
	});

	vi.setSystemTime(T1);
	const main = createLabour(db, actor, {
		realmId: amId,
		title: 'Boss HP feels wrong',
		description: 'see AM-1 and @ada',
		ownerId: bob
	});
	vi.setSystemTime(T2);
	const first = addComment(db, { id: ada }, main.id, 'cc @bob, relates to AM-1');
	const second = addComment(db, actor, main.id, 'plain second comment');
	vi.setSystemTime(T3);
	editComment(db, { id: ada }, first.id, 'cc @bob, relates to AM-1 and BL-1');
	appraise(db, actor, [
		{
			labourId: main.id,
			brief: 'Players say the boss is a sponge',
			values: { repro: 'Fight the boss', context: 'Stream clip', severity: 4 }
		}
	]);
	const bare = seedLabour(db, { realmId: amId, title: 'Bare', ownerId: ada });
	return { bl, other, main, first, second, bare };
}

describe('DERIVED_VERSIONS', () => {
	it('starts every structure at version 1', () => {
		expect(DERIVED_VERSIONS).toEqual({ labour_text: 1, mentions: 1, embedding_inputs: 1 });
	});
});

describe('rebuildDerived: what it rebuilds', () => {
	it('builds every structure on the first run and says so', () => {
		const names = rebuildDerived(db, BUILT);

		expect([...names].sort()).toEqual(['embedding_inputs', 'labour_text', 'mentions']);
		expect(buildRecords()).toMatchObject([
			{ name: 'embedding_inputs', version: DERIVED_VERSIONS.embedding_inputs, builtAt: BUILT },
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: BUILT },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: BUILT }
		]);
	});

	it('does nothing on the second run', () => {
		buildWorld();
		rebuildDerived(db, BUILT);
		const text = textRows();
		const rows = mentionRows();

		const names = rebuildDerived(db, REBUILT);

		expect(names).toEqual([]);
		expect(buildRecords().map((record) => record.builtAt)).toEqual([BUILT, BUILT, BUILT]);
		expect(textRows()).toEqual(text);
		expect(mentionRows()).toEqual(rows);
	});

	it('rebuilds only the structure whose recorded version is below the code version', () => {
		buildWorld();
		rebuildDerived(db, BUILT);
		wipeText();
		db.delete(mentions).run();
		db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'mentions')).run();

		const names = rebuildDerived(db, REBUILT);

		expect(names).toEqual(['mentions']);
		expect(mentionRows().length).toBeGreaterThan(0);
		expect(textRows()).toEqual([]);
		expect(buildRecords()).toMatchObject([
			{ name: 'embedding_inputs', builtAt: BUILT },
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: BUILT },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: REBUILT }
		]);
	});

	it('rebuilds labour_text alone when only its version is stale', () => {
		buildWorld();
		rebuildDerived(db, BUILT);
		wipeText();
		db.delete(mentions).run();
		db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'labour_text')).run();

		const names = rebuildDerived(db, REBUILT);

		expect(names).toEqual(['labour_text']);
		expect(textRows().length).toBeGreaterThan(0);
		expect(mentionRows()).toEqual([]);
		expect(buildRecords()).toMatchObject([
			{ name: 'embedding_inputs', builtAt: BUILT },
			{ name: 'labour_text', version: DERIVED_VERSIONS.labour_text, builtAt: REBUILT },
			{ name: 'mentions', version: DERIVED_VERSIONS.mentions, builtAt: BUILT }
		]);
	});

	it('rebuilds a structure whose record is missing', () => {
		buildWorld();
		rebuildDerived(db, BUILT);
		db.delete(derivedBuilds).where(eq(derivedBuilds.name, 'mentions')).run();

		expect(rebuildDerived(db, REBUILT)).toEqual(['mentions']);
	});

	it('leaves a structure recorded at a higher version alone', () => {
		rebuildDerived(db, BUILT);
		db.update(derivedBuilds).set({ version: 99 }).run();
		wipeText();

		expect(rebuildDerived(db, REBUILT)).toEqual([]);
		expect(textRows()).toEqual([]);
	});

	it('defaults the build time to now', () => {
		vi.setSystemTime(T3);

		rebuildDerived(db);

		expect(buildRecords().map((record) => record.builtAt)).toEqual([T3, T3, T3]);
	});

	it('records no Event and moves no updatedAt', () => {
		buildWorld();
		const eventsBefore = eventCount();
		const stamps = db
			.select({ id: labours.id, updatedAt: labours.updatedAt })
			.from(labours)
			.orderBy(asc(labours.id))
			.all();
		db.delete(mentions).run();
		wipeText();

		rebuildDerived(db, BUILT);

		expect(eventCount()).toBe(eventsBefore);
		expect(
			db
				.select({ id: labours.id, updatedAt: labours.updatedAt })
				.from(labours)
				.orderBy(asc(labours.id))
				.all()
		).toEqual(stamps);
	});
});

describe('rebuildDerived: labour_text', () => {
	it('rebuilds exactly what the writes kept current', () => {
		buildWorld();
		const live = textRows();
		expect(live.length).toBeGreaterThanOrEqual(4);
		const main = live.find((r) => r.title === 'Boss HP feels wrong')!;
		expect(main).toMatchObject({
			description: 'see AM-1 and @ada',
			brief: 'Players say the boss is a sponge',
			comments: 'cc @bob, relates to AM-1 and BL-1\n\nplain second comment',
			notes: 'Stream clip\n\nFight the boss'
		});
		wipeText();

		expect(rebuildDerived(db, BUILT)).toContain('labour_text');

		expect(textRows()).toEqual(live);
	});

	it('replaces rows that drifted and drops rows with no Labour', () => {
		buildWorld();
		const live = textRows();
		wipeText();
		const insert = db.$client.prepare(
			'INSERT INTO labour_text(rowid, title, brief, description, comments, notes) VALUES (?, ?, ?, ?, ?, ?)'
		);
		insert.run(target.id, 'stale title', 'stale', 'stale', 'stale', 'stale');
		insert.run(999_999, 'ghost', '', '', '', '');

		rebuildDerived(db, BUILT);

		expect(textRows()).toEqual(live);
	});

	it('picks up text written around the board', () => {
		rebuildDerived(db, BUILT);
		db.update(labours)
			.set({ title: 'Changed behind its back' })
			.where(eq(labours.id, target.id))
			.run();
		db.update(derivedBuilds).set({ version: 0 }).where(eq(derivedBuilds.name, 'labour_text')).run();

		rebuildDerived(db, REBUILT);

		expect(textRows().find((r) => r.id === target.id)?.title).toBe('Changed behind its back');
	});
});

describe('rebuildDerived: embedding_inputs', () => {
	const inputRows = () => db.select().from(labourInputs).orderBy(asc(labourInputs.labourId)).all();
	const redoInputs = () => {
		db.delete(derivedBuilds).where(eq(derivedBuilds.name, 'embedding_inputs')).run();
		return rebuildDerived(db, REBUILT);
	};

	it('rebuilds exactly what the writes kept current', () => {
		buildWorld();
		rebuildDerived(db, BUILT);
		const live = inputRows();
		expect(live).toHaveLength(db.select().from(labours).all().length);
		db.delete(labourInputs).run();

		expect(redoInputs()).toEqual(['embedding_inputs']);

		expect(inputRows()).toEqual(live);
	});

	it('hashes the title, Brief and description as they stand', () => {
		const { main } = buildWorld();
		rebuildDerived(db, BUILT);
		setBody(main.id, 'Edited behind its back');

		redoInputs();

		expect(inputRows().find((r) => r.labourId === main.id)?.inputHash).toBe(
			inputHash({
				title: 'Boss HP feels wrong',
				brief: 'Players say the boss is a sponge',
				description: 'Edited behind its back'
			})
		);
	});

	it('fills every Labour, past the first chunk', () => {
		const base = db.select().from(labours).where(eq(labours.id, target.id)).get()!;
		const ranks = generateNKeysBetween(base.rank, null, 1_200);
		db.insert(labours)
			.values(
				ranks.map((rank, i) => ({
					realmId: amId,
					number: 1_000 + i,
					title: `Bulk ${i}`,
					ownerId: ada,
					stateId: base.stateId,
					rank
				}))
			)
			.run();
		db.delete(labourInputs).run();

		rebuildDerived(db, BUILT);

		expect(inputRows()).toHaveLength(1_201);
	});
});

describe('rebuildDerived: mentions', () => {
	const redoMentions = () => {
		db.delete(derivedBuilds).where(eq(derivedBuilds.name, 'mentions')).run();
		return rebuildDerived(db, REBUILT);
	};

	it('keeps every existing row whose text still names the target, id and all', () => {
		buildWorld();
		const before = mentionRows();
		expect(before.length).toBeGreaterThanOrEqual(5);
		vi.setSystemTime(new Date('2040-01-01T00:00:00.000Z'));

		redoMentions();

		expect(mentionRows()).toEqual(before);
	});

	it('keeps the firstSeenAt and authorId a row was given, not what a rebuild would seed', () => {
		const { main } = buildWorld();
		const descriptionRow = mentionRows().find(
			(r) => r.sourceLabourId === main.id && r.commentId === null && r.labourId === target.id
		)!;
		db.update(mentions)
			.set({ authorId: bob, firstSeenAt: T3 })
			.where(eq(mentions.id, descriptionRow.id))
			.run();

		redoMentions();

		expect(mentionRows().find((r) => r.id === descriptionRow.id)).toMatchObject({
			authorId: bob,
			firstSeenAt: T3
		});
	});

	it('seeds missing rows from the Comment, or from the Labour and its Owner', () => {
		const { main, first, other } = buildWorld();
		db.delete(mentions).run();

		redoMentions();

		expect(shape(mentionRows())).toEqual(
			[
				row(main.id, null, target.id, null, bob, T1),
				row(main.id, null, null, ada, bob, T1),
				row(main.id, first.id, target.id, null, ada, T2),
				row(main.id, first.id, null, bob, ada, T2),
				row(main.id, first.id, other.id, null, ada, T2)
			].sort()
		);
	});

	it('seeds from createdAt, not the time of a later edit', () => {
		const { main, first, other } = buildWorld();
		const added = mentionRows().find((r) => r.commentId === first.id && r.labourId === other.id)!;
		expect(added.firstSeenAt).toEqual(T3);
		db.delete(mentions).where(eq(mentions.id, added.id)).run();

		redoMentions();

		const reseeded = mentionRows().find(
			(r) => r.commentId === first.id && r.labourId === other.id
		)!;
		expect(reseeded.firstSeenAt).toEqual(T2);
		expect(reseeded.authorId).toBe(ada);
		expect(reseeded.sourceLabourId).toBe(main.id);
	});

	it('deletes a row whose text no longer names the target', () => {
		const { main, first } = buildWorld();
		const before = mentionRows();
		setBody(main.id, 'only @ada now');
		db.update(comments).set({ body: 'nothing to see' }).where(eq(comments.id, first.id)).run();

		redoMentions();

		expect(shape(mentionRows())).toEqual(
			shape(before.filter((r) => r.commentId === null && r.userId === ada))
		);
	});

	it('keeps, deletes and adds in one pass', () => {
		const source = seedLabour(db, {
			realmId: amId,
			title: 'Source',
			description: 'AM-1 and @bob',
			ownerId: ada
		});
		const own = mentionRows().filter((r) => r.sourceLabourId === source.id);
		expect(own).toHaveLength(2);
		const targetRow = own.find((r) => r.labourId === target.id)!;
		const userRow = own.find((r) => r.userId === bob)!;
		db.delete(mentions).where(eq(mentions.id, userRow.id)).run();
		db.update(mentions).set({ firstSeenAt: T3 }).where(eq(mentions.id, targetRow.id)).run();
		db.insert(mentions)
			.values({
				sourceLabourId: source.id,
				commentId: null,
				labourId: null,
				userId: ada,
				authorId: bob,
				firstSeenAt: T3
			})
			.run();

		redoMentions();

		expect(shape(mentionRows().filter((r) => r.sourceLabourId === source.id))).toEqual(
			[
				row(source.id, null, target.id, null, actor.id, T3),
				row(source.id, null, null, bob, ada, T1)
			].sort()
		);
		expect(mentionRows().some((r) => r.id === targetRow.id)).toBe(true);
	});

	it('does not keep a description row for a target only a Comment names', () => {
		const source = seedLabour(db, { realmId: amId, title: 'Source', ownerId: ada });
		addComment(db, { id: bob }, source.id, 'AM-1');
		const [commentRow] = mentionRows().filter((r) => r.sourceLabourId === source.id);
		db.insert(mentions)
			.values({
				sourceLabourId: source.id,
				commentId: null,
				labourId: target.id,
				userId: null,
				authorId: ada,
				firstSeenAt: T1
			})
			.run();

		redoMentions();

		expect(mentionRows().filter((r) => r.sourceLabourId === source.id)).toEqual([commentRow]);
	});

	it('adds a Mention of a Labour or User created after the text', () => {
		const labour = seedLabour(db, {
			realmId: amId,
			title: 'Early',
			description: 'depends on AM-3 and @carol',
			ownerId: bob
		});
		const later = seedLabour(db, { realmId: amId, title: 'Later', ownerId: ada });
		const carol = seedUser(db, 'carol');
		expect(mentionRows().filter((r) => r.sourceLabourId === labour.id)).toEqual([]);

		redoMentions();

		expect(shape(mentionRows())).toEqual(
			[
				row(labour.id, null, later.id, null, bob, T1),
				row(labour.id, null, null, carol, bob, T1)
			].sort()
		);
	});

	it('applies the extraction rules: aliases, own key, unknown targets and duplicates', () => {
		const bl = seedRealm(db, 'BL');
		seedUser(db, 'carol');
		moveLabour(db, actor, target.id, { realmId: bl.id });
		const source = seedLabour(db, { realmId: amId, title: 'Source', ownerId: bob });
		const moved = moveLabour(db, actor, source.id, { realmId: bl.id });
		setBody(
			source.id,
			`AM-1 am-1 BL-1 ${moved.key} AM-2 AM-999 XAM-1x @ada @ADA @nobody a@carol.com @bob_`
		);
		const comment = addComment(db, actor, source.id, 'plain');
		db.update(comments).set({ body: 'AM-1 @ada' }).where(eq(comments.id, comment.id)).run();
		db.delete(mentions).run();

		redoMentions();

		expect(shape(mentionRows())).toEqual(
			[
				row(source.id, null, target.id, null, bob, T1),
				row(source.id, null, null, ada, bob, T1),
				row(source.id, null, null, bob, bob, T1),
				row(source.id, comment.id, target.id, null, actor.id, T1),
				row(source.id, comment.id, null, ada, actor.id, T1)
			].sort()
		);
	});

	it('rebuilds from nothing when every structure is empty', () => {
		db.delete(mentions).run();
		wipeText();

		expect(rebuildDerived(db, BUILT).sort()).toEqual([
			'embedding_inputs',
			'labour_text',
			'mentions'
		]);
		expect(mentionRows()).toEqual([]);
		expect(textRows().map((r) => r.id)).toEqual([target.id]);
	});
});
