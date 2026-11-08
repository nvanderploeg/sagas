import { beforeEach, describe, expect, it } from 'vitest';
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

beforeEach(async () => {
	db = await testDb();
	actor = await seedActor(db);
	labourId = (await seedLabour(db, { realmId: (await seedRealm(db)).id })).id;
});

describe('Comments', () => {
	it('records the author and lists oldest first', async () => {
		const other = { id: await seedUser(db, 'other') };

		await addComment(db, actor, labourId, 'first');
		await addComment(db, other, labourId, 'second');

		expect((await listComments(db, labourId)).map((c) => [c.authorId, c.body])).toEqual([
			[actor.id, 'first'],
			[other.id, 'second']
		]);
	});

	it('keeps each Labour its own', async () => {
		const elsewhere = (await seedLabour(db, { realmId: (await seedRealm(db, 'BL')).id })).id;

		await addComment(db, actor, labourId, 'here');

		expect(await listComments(db, elsewhere)).toEqual([]);
	});

	it('records one labour.commented Event carrying the Comment', async () => {
		const before = (await eventsSince(db, 0)).length;

		const comment = await addComment(db, actor, labourId, 'noted');

		const recorded = (await eventsSince(db, 0)).slice(before);
		expect(recorded).toHaveLength(1);
		expect(recorded[0]).toMatchObject({
			type: 'labour.commented',
			data: { comment: JSON.parse(JSON.stringify(comment)) }
		});
	});

	it('refuses a blank or over-long body, and a missing Labour, recording nothing', async () => {
		const before = (await eventsSince(db, 0)).length;
		const refused = async (run: () => unknown) => {
			try {
				await run();
			} catch (error) {
				return (error as DomainError).code;
			}
		};

		expect(await refused(() => addComment(db, actor, labourId, '  \n'))).toBe('invalid');
		expect(await refused(() => addComment(db, actor, labourId, 'x'.repeat(COMMENT_MAX + 1)))).toBe(
			'invalid'
		);
		expect(await refused(() => addComment(db, actor, 9999, 'hi'))).toBe('not_found');

		expect(await eventsSince(db, 0)).toHaveLength(before);
	});

	it('goes with the Labour', async () => {
		await addComment(db, actor, labourId, 'gone soon');

		await deleteLabour(db, actor, labourId);

		expect(await listComments(db, labourId)).toEqual([]);
	});

	it('lets only the author edit, and records an Event only for a real change', async () => {
		const other = { id: await seedUser(db, 'other') };
		const { id } = await addComment(db, actor, labourId, 'draft');
		const before = (await eventsSince(db, 0)).length;

		const edited = await editComment(db, actor, id, 'final');
		await editComment(db, actor, id, 'final');

		expect(edited).toMatchObject({ body: 'final' });
		expect(edited.updatedAt).toBeInstanceOf(Date);
		expect((await eventsSince(db, 0)).slice(before).map((e) => e.type)).toEqual([
			'labour.comment_edited'
		]);
		await expect(editComment(db, other, id, 'mine now')).rejects.toThrow(/author/);
		expect((await listComments(db, labourId))[0].body).toBe('final');
	});

	it('lets only the author delete, and records the deletion', async () => {
		const other = { id: await seedUser(db, 'other') };
		const { id } = await addComment(db, actor, labourId, 'oops');

		await expect(deleteComment(db, other, id)).rejects.toThrow(/author/);
		await deleteComment(db, actor, id);

		expect(await listComments(db, labourId)).toEqual([]);
		expect((await eventsSince(db, 0)).at(-1)).toMatchObject({
			type: 'labour.comment_deleted',
			data: { id, labourId }
		});
		await expect(deleteComment(db, actor, id)).rejects.toThrow(/not found/);
	});
});
