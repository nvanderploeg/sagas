import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { addComment, listComments } from '#lib/server/domain/comments.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { currentVia, withVia } from './via.ts';

let db: Db;
let author: number;
let labourId: number;

beforeEach(() => {
	db = testDb();
	author = seedUser(db, 'ada');
	labourId = seedLabour(db, { realmId: seedRealm(db, 'AM').id }).id;
});

describe('currentVia', () => {
	it('is the token name inside withVia and null outside', () => {
		expect(currentVia()).toBeNull();
		expect(withVia({ name: 'norm-mint-main' }, currentVia)).toBe('norm-mint-main');
		expect(withVia(undefined, currentVia)).toBeNull();
	});

	it('is recorded on a Comment written through a token, and not on one written without', () => {
		withVia({ name: 'norm-mint-main' }, () =>
			addComment(db, { id: author }, labourId, 'from agent')
		);
		addComment(db, { id: author }, labourId, 'from browser');

		expect(listComments(db, labourId).map((c) => c.via)).toEqual(['norm-mint-main', null]);
	});
});
