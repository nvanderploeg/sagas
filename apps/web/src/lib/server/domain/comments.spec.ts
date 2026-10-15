import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { eventsSince } from '#lib/server/events/log.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { addComment, COMMENT_MAX, deleteComment, editComment, listComments } from './comments.ts';
import { DomainError } from './errors.ts';
import { deleteLabour } from './labours.ts';
import type { Actor } from './write.ts';

let db: Db;
let actor: Actor;
let labourId: number;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	labourId = seedLabour(db, { realmId: seedRealm(db).id }).id;
});

afterEach(() => {
	db.$client.close();
});

describe('Comments', () => {
	it('records the author and lists oldest first', () => {
		const other = { id: seedUser(db, 'other') };

		addComment(db, actor, labourId, 'first');
		addComment(db, other, labourId, 'second');

		expect(listComments(db, labourId).map((c) => [c.authorId, c.body])).toEqual([
			[actor.id, 'first'],
			[other.id, 'second']
		]);
	});

	it('keeps each Labour its own', () => {
		const elsewhere = seedLabour(db, { realmId: seedRealm(db, 'BL').id }).id;

		addComment(db, actor, labourId, 'here');

		expect(listComments(db, elsewhere)).toEqual([]);
	});

	it('records one labour.commented Event carrying the Comment', () => {
		const before = eventsSince(db, 0).length;

		const comment = addComment(db, actor, labourId, 'noted');

		const recorded = eventsSince(db, 0).slice(before);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			type: 'labour.commented',
			data: { comment: JSON.parse(JSON.stringify(comment)) }
		});
	});

	it('refuses a blank or over-long body, and a missing Labour, recording nothing', () => {
		const before = eventsSince(db, 0).length;
		const refused = (run: () => unknown) => {
			try {
				run();
			} catch (error) {
				return (error as DomainError).code;
			}
		};

		expect(refused(() => addComment(db, actor, labourId, '  \n'))).toBe('invalid');
		expect(refused(() => addComment(db, actor, labourId, 'x'.repeat(COMMENT_MAX + 1)))).toBe(
			'invalid'
		);
		expect(refused(() => addComment(db, actor, 9999, 'hi'))).toBe('not_found');

		expect(eventsSince(db, 0)).toHaveLength(before);
	});

	it('goes with the Labour', () => {
		addComment(db, actor, labourId, 'gone soon');

		deleteLabour(db, actor, labourId);

		expect(listComments(db, labourId)).toEqual([]);
	});

	it('lets only the author edit, and records an Event only for a real change', () => {
		const other = { id: seedUser(db, 'other') };
		const { id } = addComment(db, actor, labourId, 'draft');
		const before = eventsSince(db, 0).length;

		const edited = editComment(db, actor, id, 'final');
		editComment(db, actor, id, 'final');

		expect(edited).toMatchObject({ body: 'final' });
		expect(edited.updatedAt).toBeInstanceOf(Date);
		expect(
			eventsSince(db, 0)
				.slice(before)
				.map((e) => e.type)
		).toEqual(['labour.comment_edited']);
		expect(() => editComment(db, other, id, 'mine now')).toThrow(/author/);
		expect(listComments(db, labourId)[0].body).toBe('final');
	});

	it('lets only the author delete, and records the deletion', () => {
		const other = { id: seedUser(db, 'other') };
		const { id } = addComment(db, actor, labourId, 'oops');

		expect(() => deleteComment(db, other, id)).toThrow(/author/);
		deleteComment(db, actor, id);

		expect(listComments(db, labourId)).toEqual([]);
		expect(eventsSince(db, 0).at(-1)).toMatchObject({
			type: 'labour.comment_deleted',
			data: { id, labourId }
		});
		expect(() => deleteComment(db, actor, id)).toThrow(/not found/);
	});
});
