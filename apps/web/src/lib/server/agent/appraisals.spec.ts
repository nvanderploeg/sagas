import { createHash } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { comments, events, labours } from '#lib/server/db/schema.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { addComment, deleteComment, editComment } from '#lib/server/domain/comments.ts';
import { moveLabour, rankLabour, updateLabour } from '#lib/server/domain/labours.ts';
import { createState, listStates } from '#lib/server/domain/states.ts';
import type { Actor } from '#lib/server/domain/write.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedActor, seedLabour, seedRealm, seedUser } from '#lib/server/test/fixtures.ts';
import { appraise, listUnappraised, readAppraisal, type AppraiseItem } from './appraisals.ts';
import {
	defineAttribute,
	readRealmAgent,
	readValues,
	setValues,
	type AttributeInput
} from './attributes.ts';
import { contentHash } from './content.ts';
import { readLinks } from './links.ts';

let db: Db;
let actor: Actor;
let other: Actor;

beforeEach(() => {
	db = testDb();
	actor = seedActor(db);
	other = { id: seedUser(db, 'other') };
});

afterEach(() => {
	db.$client.close();
});

const day = (n: number) => new Date(Date.UTC(2030, 0, n));

function expectDomainError(action: () => unknown, code: DomainError['code']): DomainError {
	let thrown: unknown;
	try {
		action();
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(DomainError);
	expect((thrown as DomainError).code).toBe(code);
	return thrown as DomainError;
}

const IMPACT: AttributeInput = {
	key: 'impact',
	kind: 'scale',
	label: 'Impact',
	rubric: 'How much it matters',
	spec: { min: 1, max: 5 }
};
const NOTES: AttributeInput = { key: 'notes', kind: 'text', label: 'Notes', rubric: 'Free notes' };
const AREAS: AttributeInput = {
	key: 'areas',
	kind: 'tags',
	label: 'Areas',
	rubric: 'Where it lands',
	spec: {
		members: [
			{ key: 'ui', label: 'UI' },
			{ key: 'api', label: 'API' }
		],
		max: null
	}
};

const define = (realmId: number, input: AttributeInput, now = day(1)) =>
	defineAttribute(db, actor, realmId, input, now);

const reviseRubric = (realmId: number, key: string, kind: 'scale' | 'text', now: Date) =>
	defineAttribute(db, actor, realmId, { key, kind, rubric: `Rubric at ${now.toISOString()}` }, now);

const version = (realmId: number) => readRealmAgent(db, realmId).version;

const closedOf = (realmId: number) => listStates(db, realmId).find((s) => s.isClosed)!;

// Independent of contentHash: built from the stored rows, in the contract's key order.
function expectedHash(labourId: number): string {
	const row = db.select().from(labours).where(eq(labours.id, labourId)).get()!;
	const bodies = db
		.select({ body: comments.body })
		.from(comments)
		.where(eq(comments.labourId, labourId))
		.orderBy(asc(comments.id))
		.all()
		.map((c) => c.body);
	return sha256(
		JSON.stringify({
			title: row.title,
			description: row.description,
			labels: row.labels,
			comments: bodies
		})
	);
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function stamped(labourId: number, now = day(2), by = actor) {
	return appraise(db, by, [{ labourId, stamp: contentHash(db, labourId) }], now);
}

describe('contentHash', () => {
	it('is the SHA-256 of title, description, labels and comment bodies, in that key order', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, {
			realmId: realm.id,
			title: 'Fix login',
			description: 'Broken on mobile',
			labels: ['bug', 'ui']
		});
		addComment(db, actor, labour.id, 'first');
		addComment(db, actor, labour.id, 'second');

		expect(contentHash(db, labour.id)).toBe(
			sha256(
				'{"title":"Fix login","description":"Broken on mobile","labels":["bug","ui"],"comments":["first","second"]}'
			)
		);
	});

	it('hashes a bare Labour with an empty description, no Labels and no Comments', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Bare' });

		expect(contentHash(db, labour.id)).toBe(
			sha256('{"title":"Bare","description":"","labels":[],"comments":[]}')
		);
	});

	it('is 64 lowercase hex characters', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(contentHash(db, labour.id)).toMatch(/^[0-9a-f]{64}$/);
	});

	it('hashes Labels as stored, sorted', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'T', labels: ['zeta', 'alpha'] });

		expect(contentHash(db, labour.id)).toBe(
			sha256('{"title":"T","description":"","labels":["alpha","zeta"],"comments":[]}')
		);
	});

	it('orders Comment bodies by Comment id, so editing one keeps its place', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'T' });
		const first = addComment(db, actor, labour.id, 'one');
		addComment(db, actor, labour.id, 'two');

		editComment(db, actor, first.id, 'one, revised');

		expect(contentHash(db, labour.id)).toBe(
			sha256('{"title":"T","description":"","labels":[],"comments":["one, revised","two"]}')
		);
	});

	it('is the same for two Labours with the same content', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id, title: 'Same', description: 'd' });
		const b = seedLabour(db, { realmId: realm.id, title: 'Same', description: 'd' });

		expect(contentHash(db, a.id)).toBe(contentHash(db, b.id));
	});

	it('ignores Comments on other Labours', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id, title: 'A' });
		const b = seedLabour(db, { realmId: realm.id, title: 'B' });
		const before = contentHash(db, a.id);

		addComment(db, actor, b.id, 'elsewhere');

		expect(contentHash(db, a.id)).toBe(before);
	});

	it('refuses an unknown Labour as not_found', () => {
		expectDomainError(() => contentHash(db, 999), 'not_found');
	});

	describe.each<[string, (id: number) => void]>([
		['the title', (id) => updateLabour(db, actor, id, { title: 'Renamed' })],
		['the description', (id) => updateLabour(db, actor, id, { description: 'Changed' })],
		['a Label added', (id) => updateLabour(db, actor, id, { addLabels: ['bug'] })],
		['a Comment added', (id) => void addComment(db, actor, id, 'a note')]
	])('changes when %s changes', (_name, change) => {
		it('moves the hash to the hash of the new content', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id, title: 'Original' });
			const before = contentHash(db, labour.id);

			change(labour.id);

			const after = contentHash(db, labour.id);
			expect(after).not.toBe(before);
			expect(after).toBe(expectedHash(labour.id));
		});
	});

	it('changes when a Label is removed', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, labels: ['bug'] });
		const before = contentHash(db, labour.id);

		updateLabour(db, actor, labour.id, { removeLabels: ['bug'] });

		expect(contentHash(db, labour.id)).not.toBe(before);
		expect(contentHash(db, labour.id)).toBe(expectedHash(labour.id));
	});

	it('changes when a Comment is edited', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const comment = addComment(db, actor, labour.id, 'before');
		const before = contentHash(db, labour.id);

		editComment(db, actor, comment.id, 'after');

		expect(contentHash(db, labour.id)).not.toBe(before);
		expect(contentHash(db, labour.id)).toBe(expectedHash(labour.id));
	});

	it('changes when a Comment is deleted, and returns to the hash from before it was added', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const bare = contentHash(db, labour.id);
		const comment = addComment(db, actor, labour.id, 'gone soon');
		expect(contentHash(db, labour.id)).not.toBe(bare);

		deleteComment(db, actor, comment.id);

		expect(contentHash(db, labour.id)).toBe(bare);
	});

	describe('does not change on', () => {
		it('a move to another Realm', () => {
			const am = seedRealm(db, 'AM');
			const bl = seedRealm(db, 'BL');
			const labour = seedLabour(db, { realmId: am.id, title: 'Mover', labels: ['x'] });
			addComment(db, actor, labour.id, 'note');
			const before = contentHash(db, labour.id);

			moveLabour(db, actor, labour.id, { realmId: bl.id });

			expect(contentHash(db, labour.id)).toBe(before);
		});

		it('a State change, including Closed', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			const before = contentHash(db, labour.id);
			const doing = createState(db, actor, realm.id, {
				key: 'doing',
				label: 'Doing',
				color: '#000000',
				icon: 'play'
			});

			updateLabour(db, actor, labour.id, { stateId: doing.id });
			expect(contentHash(db, labour.id)).toBe(before);
			updateLabour(db, actor, labour.id, { stateId: closedOf(realm.id).id });
			expect(contentHash(db, labour.id)).toBe(before);
		});

		it('a Rank change', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			seedLabour(db, { realmId: realm.id });
			const before = contentHash(db, labour.id);

			rankLabour(db, actor, labour.id, 'bottom');
			rankLabour(db, actor, labour.id, 'top');

			expect(contentHash(db, labour.id)).toBe(before);
		});

		it('an Assignee or Owner change', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			const before = contentHash(db, labour.id);

			updateLabour(db, actor, labour.id, { assigneeId: other.id });
			updateLabour(db, actor, labour.id, { ownerId: other.id });

			expect(contentHash(db, labour.id)).toBe(before);
		});

		it('any agent layer write', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			const peer = seedLabour(db, { realmId: realm.id });
			define(realm.id, IMPACT);
			const before = contentHash(db, labour.id);

			appraise(
				db,
				actor,
				[
					{
						labourId: labour.id,
						brief: 'Brief',
						refs: [{ href: 'https://example.com' }],
						values: { impact: 4 },
						links: [{ type: 'evidence', to: peer.id }],
						stamp: before
					}
				],
				day(2)
			);

			expect(contentHash(db, labour.id)).toBe(before);
		});
	});
});

describe('appraise: batch shape', () => {
	it('returns one result per item, in item order, with the Labour id', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		const c = seedLabour(db, { realmId: realm.id });

		const results = appraise(
			db,
			actor,
			[
				{ labourId: c.id, stamp: contentHash(db, c.id) },
				{ labourId: a.id, brief: 'just a brief' },
				{ labourId: b.id, stamp: 'not-the-hash' }
			],
			day(2)
		);

		expect(results).toEqual([
			{ labourId: c.id, stamped: true },
			{ labourId: a.id, stamped: false },
			{ labourId: b.id, stamped: false }
		]);
	});

	it('accepts an item that names nothing, and writes nothing for it', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		const results = appraise(db, actor, [{ labourId: labour.id }], day(2));

		expect(results).toEqual([{ labourId: labour.id, stamped: false }]);
		expect(readAppraisal(db, labour.id)).toMatchObject({
			brief: '',
			refs: [],
			setBy: null,
			setAt: null,
			stamp: null,
			unappraised: true,
			values: [],
			links: []
		});
	});

	it('accepts an item that names only a stamp', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		const results = stamped(labour.id);

		expect(results).toEqual([{ labourId: labour.id, stamped: true }]);
	});

	it('accepts 50 items', () => {
		const realm = seedRealm(db, 'AM');
		const items: AppraiseItem[] = Array.from({ length: 50 }, (_, i) => ({
			labourId: seedLabour(db, { realmId: realm.id, title: `L${i}` }).id,
			brief: `brief ${i}`
		}));

		const results = appraise(db, actor, items, day(2));

		expect(results).toHaveLength(50);
		expect(readAppraisal(db, items[49].labourId).brief).toBe('brief 49');
	});

	it('refuses 51 items as invalid, writing none', () => {
		const realm = seedRealm(db, 'AM');
		const items: AppraiseItem[] = Array.from({ length: 51 }, (_, i) => ({
			labourId: seedLabour(db, { realmId: realm.id, title: `L${i}` }).id,
			brief: 'x'
		}));

		expectDomainError(() => appraise(db, actor, items, day(2)), 'invalid');

		expect(readAppraisal(db, items[0].labourId).brief).toBe('');
	});

	it('refuses an empty batch as invalid', () => {
		expectDomainError(() => appraise(db, actor, [], day(2)), 'invalid');
	});

	it('refuses the same Labour twice in one batch as invalid, writing neither item', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{ labourId: labour.id, brief: 'first' },
						{ labourId: labour.id, brief: 'second' }
					],
					day(2)
				),
			'invalid'
		);

		expect(readAppraisal(db, labour.id).brief).toBe('');
	});

	it('refuses an unknown Labour as not_found', () => {
		expectDomainError(
			() => appraise(db, actor, [{ labourId: 999, brief: 'x' }], day(2)),
			'not_found'
		);
	});
});

describe('appraise: brief', () => {
	it('stores the Brief trimmed', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(db, actor, [{ labourId: labour.id, brief: '  Needs a design pass \n' }], day(2));

		expect(readAppraisal(db, labour.id).brief).toBe('Needs a design pass');
	});

	it('accepts 400 characters, and counts them after trimming', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(db, actor, [{ labourId: labour.id, brief: `  ${'a'.repeat(400)}  ` }], day(2));

		expect(readAppraisal(db, labour.id).brief).toBe('a'.repeat(400));
	});

	it('refuses 401 characters as invalid', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(
			() => appraise(db, actor, [{ labourId: labour.id, brief: 'a'.repeat(401) }], day(2)),
			'invalid'
		);
	});

	it('replaces the previous Brief', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: labour.id, brief: 'old' }], day(2));

		appraise(db, actor, [{ labourId: labour.id, brief: 'new' }], day(3));

		expect(readAppraisal(db, labour.id).brief).toBe('new');
	});

	it('clears the Brief with an empty string', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: labour.id, brief: 'something' }], day(2));

		appraise(db, actor, [{ labourId: labour.id, brief: '' }], day(3));

		expect(readAppraisal(db, labour.id).brief).toBe('');
	});

	it('leaves the Brief alone when the item does not name it', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: labour.id, brief: 'kept' }], day(2));

		appraise(db, actor, [{ labourId: labour.id, refs: [{ href: 'https://a.test' }] }], day(3));

		expect(readAppraisal(db, labour.id).brief).toBe('kept');
	});
});

describe('appraise: refs', () => {
	const href = (n: number) => `https://example.com/${n}`;

	it('stores References in order, a missing, null or empty label as null', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(
			db,
			actor,
			[
				{
					labourId: labour.id,
					refs: [
						{ href: href(1), label: 'Spec' },
						{ href: href(2) },
						{ href: href(3), label: null },
						{ href: href(4), label: '' }
					]
				}
			],
			day(2)
		);

		expect(readAppraisal(db, labour.id).refs).toEqual([
			{ href: href(1), label: 'Spec' },
			{ href: href(2), label: null },
			{ href: href(3), label: null },
			{ href: href(4), label: null }
		]);
	});

	it('trims href and label', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(
			db,
			actor,
			[{ labourId: labour.id, refs: [{ href: '  src/a.ts  ', label: '  The file ' }] }],
			day(2)
		);

		expect(readAppraisal(db, labour.id).refs).toEqual([{ href: 'src/a.ts', label: 'The file' }]);
	});

	it('replaces the whole list, and clears it with an empty array', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(
			db,
			actor,
			[{ labourId: labour.id, refs: [{ href: href(1) }, { href: href(2) }] }],
			day(2)
		);

		appraise(db, actor, [{ labourId: labour.id, refs: [{ href: href(3) }] }], day(3));
		expect(readAppraisal(db, labour.id).refs).toEqual([{ href: href(3), label: null }]);

		appraise(db, actor, [{ labourId: labour.id, refs: [] }], day(4));
		expect(readAppraisal(db, labour.id).refs).toEqual([]);
	});

	it('leaves References alone when the item does not name them', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: labour.id, refs: [{ href: href(1) }] }], day(2));

		appraise(db, actor, [{ labourId: labour.id, brief: 'x' }], day(3));

		expect(readAppraisal(db, labour.id).refs).toEqual([{ href: href(1), label: null }]);
	});

	it('accepts 20 References and refuses 21 as invalid', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(
			db,
			actor,
			[{ labourId: labour.id, refs: Array.from({ length: 20 }, (_, i) => ({ href: href(i) })) }],
			day(2)
		);
		expect(readAppraisal(db, labour.id).refs).toHaveLength(20);

		expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{ labourId: labour.id, refs: Array.from({ length: 21 }, (_, i) => ({ href: href(i) })) }
					],
					day(3)
				),
			'invalid'
		);
		expect(readAppraisal(db, labour.id).refs).toHaveLength(20);
	});

	it('accepts an href of 500 characters and refuses 501 as invalid', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(db, actor, [{ labourId: labour.id, refs: [{ href: 'h'.repeat(500) }] }], day(2));
		expect(readAppraisal(db, labour.id).refs[0].href).toHaveLength(500);

		expectDomainError(
			() =>
				appraise(db, actor, [{ labourId: labour.id, refs: [{ href: 'h'.repeat(501) }] }], day(3)),
			'invalid'
		);
	});

	it.each(['', '   '])('refuses an empty href %j as invalid', (empty) => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(
			() => appraise(db, actor, [{ labourId: labour.id, refs: [{ href: empty }] }], day(2)),
			'invalid'
		);
	});

	it('accepts a label of 120 characters and refuses 121 as invalid', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(
			db,
			actor,
			[{ labourId: labour.id, refs: [{ href: href(1), label: 'l'.repeat(120) }] }],
			day(2)
		);
		expect(readAppraisal(db, labour.id).refs[0].label).toHaveLength(120);

		expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[{ labourId: labour.id, refs: [{ href: href(1), label: 'l'.repeat(121) }] }],
					day(3)
				),
			'invalid'
		);
	});

	it('refuses the same href twice in one list as invalid, whatever the labels', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{
							labourId: labour.id,
							refs: [
								{ href: href(1), label: 'one' },
								{ href: href(1), label: 'two' }
							]
						}
					],
					day(2)
				),
			'invalid'
		);
	});

	it('accepts the same href on different Labours', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });

		appraise(
			db,
			actor,
			[
				{ labourId: a.id, refs: [{ href: href(1) }] },
				{ labourId: b.id, refs: [{ href: href(1) }] }
			],
			day(2)
		);

		expect(readAppraisal(db, a.id).refs).toHaveLength(1);
		expect(readAppraisal(db, b.id).refs).toHaveLength(1);
	});
});

describe('appraise: setBy and setAt', () => {
	it('records who last wrote the Brief and when', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(db, other, [{ labourId: labour.id, brief: 'hi' }], day(2));

		expect(readAppraisal(db, labour.id)).toMatchObject({ setBy: other.id, setAt: day(2) });
	});

	it('records who last wrote the References and when', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		appraise(db, other, [{ labourId: labour.id, refs: [{ href: 'a' }] }], day(2));

		expect(readAppraisal(db, labour.id)).toMatchObject({ setBy: other.id, setAt: day(2) });
	});

	it('rewrites them on each later Brief or References write, clearing included', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(db, actor, [{ labourId: labour.id, brief: 'one' }], day(2));

		appraise(db, other, [{ labourId: labour.id, refs: [] }], day(3));
		expect(readAppraisal(db, labour.id)).toMatchObject({ setBy: other.id, setAt: day(3) });

		appraise(db, actor, [{ labourId: labour.id, brief: '' }], day(4));
		expect(readAppraisal(db, labour.id)).toMatchObject({ setBy: actor.id, setAt: day(4) });
	});

	it('leaves them null when only values, links or a stamp are written', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const peer = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);

		appraise(
			db,
			actor,
			[
				{
					labourId: labour.id,
					values: { impact: 2 },
					links: [{ type: 'relates', to: peer.id }],
					stamp: contentHash(db, labour.id)
				}
			],
			day(2)
		);

		expect(readAppraisal(db, labour.id)).toMatchObject({ setBy: null, setAt: null });
	});

	it('leaves them unchanged when only values, links or a stamp are written later', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const peer = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		appraise(db, actor, [{ labourId: labour.id, brief: 'mine' }], day(2));

		appraise(
			db,
			other,
			[
				{
					labourId: labour.id,
					values: { impact: 2 },
					links: [{ type: 'relates', to: peer.id }],
					stamp: contentHash(db, labour.id)
				}
			],
			day(3)
		);

		expect(readAppraisal(db, labour.id)).toMatchObject({ setBy: actor.id, setAt: day(2) });
	});
});

describe('appraise: values', () => {
	it('sets values exactly as setValues does, stamping setBy and setAt', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		define(realm.id, NOTES);
		define(realm.id, AREAS);

		appraise(
			db,
			other,
			[{ labourId: labour.id, values: { impact: 4, notes: '  wide  ', areas: ['ui', 'api'] } }],
			day(2)
		);

		expect(readAppraisal(db, labour.id).values).toEqual(readValues(db, labour.id));
		expect(readValues(db, labour.id)).toEqual([
			{ key: 'impact', kind: 'scale', value: 4, setBy: other.id, setAt: day(2), stale: false },
			{ key: 'notes', kind: 'text', value: 'wide', setBy: other.id, setAt: day(2), stale: false },
			{
				key: 'areas',
				kind: 'tags',
				value: ['api', 'ui'],
				setBy: other.id,
				setAt: day(2),
				stale: false
			}
		]);
	});

	it('clears a value with null', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		setValues(db, actor, labour.id, { impact: 3 }, day(2));

		appraise(db, actor, [{ labourId: labour.id, values: { impact: null } }], day(3));

		expect(readValues(db, labour.id)).toEqual([]);
	});

	it('rewrites setBy and setAt on a re-set value, which makes a stale one current', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		setValues(db, actor, labour.id, { impact: 3 }, day(2));
		reviseRubric(realm.id, 'impact', 'scale', day(3));
		expect(readValues(db, labour.id)[0].stale).toBe(true);

		appraise(db, other, [{ labourId: labour.id, values: { impact: 3 } }], day(4));

		expect(readValues(db, labour.id)).toEqual([
			{ key: 'impact', kind: 'scale', value: 3, setBy: other.id, setAt: day(4), stale: false }
		]);
	});

	it('refuses an unknown Attribute key as invalid', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expectDomainError(
			() => appraise(db, actor, [{ labourId: labour.id, values: { nope: 1 } }], day(2)),
			'invalid'
		);
	});

	it('refuses a value outside the Attribute spec as invalid', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);

		expectDomainError(
			() => appraise(db, actor, [{ labourId: labour.id, values: { impact: 6 } }], day(2)),
			'invalid'
		);
	});

	it("refuses another Realm's Attribute key as invalid", () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: am.id });
		define(bl.id, IMPACT);

		expectDomainError(
			() => appraise(db, actor, [{ labourId: labour.id, values: { impact: 3 } }], day(2)),
			'invalid'
		);
	});

	it('leaves values alone when the item does not name them', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		setValues(db, actor, labour.id, { impact: 3 }, day(2));

		appraise(db, other, [{ labourId: labour.id, brief: 'x' }], day(3));

		expect(readValues(db, labour.id)).toEqual([
			{ key: 'impact', kind: 'scale', value: 3, setBy: actor.id, setAt: day(2), stale: false }
		]);
	});
});

describe('appraise: Realm version', () => {
	it('bumps a Realm once for a batch that sets values on two of its Labours', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		const before = version(realm.id);

		appraise(
			db,
			actor,
			[
				{ labourId: a.id, values: { impact: 1 } },
				{ labourId: b.id, values: { impact: 2 } }
			],
			day(2)
		);

		expect(version(realm.id)).toBe(before + 1);
	});

	it('bumps a Realm once however many values one Labour sets', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		define(realm.id, NOTES);
		const before = version(realm.id);

		appraise(db, actor, [{ labourId: labour.id, values: { impact: 1, notes: 'n' } }], day(2));

		expect(version(realm.id)).toBe(before + 1);
	});

	it('bumps each of two Realms once', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		define(am.id, IMPACT);
		define(bl.id, IMPACT);
		const [beforeAm, beforeBl] = [version(am.id), version(bl.id)];

		appraise(
			db,
			actor,
			[
				{ labourId: a.id, values: { impact: 1 } },
				{ labourId: b.id, values: { impact: 2 } }
			],
			day(2)
		);

		expect(version(am.id)).toBe(beforeAm + 1);
		expect(version(bl.id)).toBe(beforeBl + 1);
	});

	it('bumps only the Realm whose values changed', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		define(am.id, IMPACT);
		define(bl.id, IMPACT);
		const beforeBl = version(bl.id);

		appraise(
			db,
			actor,
			[
				{ labourId: a.id, values: { impact: 1 } },
				{ labourId: b.id, brief: 'no values here' }
			],
			day(2)
		);

		expect(version(bl.id)).toBe(beforeBl);
	});

	it('bumps when a value is cleared', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		setValues(db, actor, labour.id, { impact: 2 }, day(2));
		const before = version(realm.id);

		appraise(db, actor, [{ labourId: labour.id, values: { impact: null } }], day(3));

		expect(version(realm.id)).toBe(before + 1);
	});

	it('does not bump for a Brief, References, Links or a stamp', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		const before = version(realm.id);

		appraise(
			db,
			actor,
			[
				{
					labourId: a.id,
					brief: 'b',
					refs: [{ href: 'x' }],
					links: [{ type: 'evidence', to: b.id }],
					stamp: contentHash(db, a.id)
				},
				{ labourId: b.id, stamp: contentHash(db, b.id) }
			],
			day(2)
		);

		expect(version(realm.id)).toBe(before);
	});
});

describe('appraise: all or nothing', () => {
	const bad: [string, (valid: number, peer: number) => AppraiseItem, DomainError['code']][] = [
		[
			'a Brief over 400 characters',
			(_v, p) => ({ labourId: p, brief: 'a'.repeat(401) }),
			'invalid'
		],
		[
			'a duplicate href',
			(_v, p) => ({ labourId: p, refs: [{ href: 'x' }, { href: 'x' }] }),
			'invalid'
		],
		['an unknown value key', (_v, p) => ({ labourId: p, values: { nope: 1 } }), 'invalid'],
		['a value out of range', (_v, p) => ({ labourId: p, values: { impact: 99 } }), 'invalid'],
		[
			'a Link naming both ends',
			(v, p) => ({ labourId: p, links: [{ type: 'evidence', to: v, from: v }] }),
			'invalid'
		],
		[
			'a Link naming neither end',
			(_v, p) => ({ labourId: p, links: [{ type: 'evidence' }] }),
			'invalid'
		],
		[
			'a Link to itself',
			(_v, p) => ({ labourId: p, links: [{ type: 'evidence', to: p }] }),
			'invalid'
		],
		[
			'a Link note over 500 characters',
			(v, p) => ({ labourId: p, links: [{ type: 'evidence', to: v, note: 'n'.repeat(501) }] }),
			'invalid'
		],
		[
			'a Link to an unknown Labour',
			(_v, p) => ({ labourId: p, links: [{ type: 'evidence', to: 9999 }] }),
			'not_found'
		],
		['an unknown Labour', () => ({ labourId: 9999, brief: 'x' }), 'not_found'],
		['the first Labour again', (v) => ({ labourId: v, brief: 'again' }), 'invalid']
	];

	it.each(bad)('writes nothing of an earlier item when a later one has %s', (_name, make, code) => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const first = seedLabour(db, { realmId: am.id });
		const second = seedLabour(db, { realmId: bl.id });
		const target = seedLabour(db, { realmId: am.id });
		define(am.id, IMPACT);
		define(bl.id, IMPACT);
		const versions = [version(am.id), version(bl.id)];

		expectDomainError(
			() =>
				appraise(
					db,
					actor,
					[
						{
							labourId: first.id,
							brief: 'would be kept',
							refs: [{ href: 'https://a.test' }],
							values: { impact: 3 },
							links: [{ type: 'evidence', to: target.id }],
							stamp: contentHash(db, first.id)
						},
						make(first.id, second.id)
					],
					day(2)
				),
			code
		);

		expect(readAppraisal(db, first.id)).toMatchObject({
			brief: '',
			refs: [],
			setBy: null,
			setAt: null,
			stamp: null,
			unappraised: true,
			values: [],
			links: []
		});
		expect(readAppraisal(db, second.id)).toMatchObject({ brief: '', values: [], links: [] });
		expect(readLinks(db, target.id)).toEqual([]);
		expect([version(am.id), version(bl.id)]).toEqual(versions);
	});

	it('does not disturb what was already stored', () => {
		const realm = seedRealm(db, 'AM');
		const a = seedLabour(db, { realmId: realm.id });
		const b = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		appraise(db, actor, [{ labourId: a.id, brief: 'stored', values: { impact: 2 } }], day(2));
		const before = readAppraisal(db, a.id);

		expectDomainError(
			() =>
				appraise(
					db,
					other,
					[
						{ labourId: a.id, brief: 'replacement', values: { impact: 5 } },
						{ labourId: b.id, brief: 'x'.repeat(401) }
					],
					day(3)
				),
			'invalid'
		);

		expect(readAppraisal(db, a.id)).toEqual(before);
	});
});

describe('appraise: stamp', () => {
	it('stamps with the current hash, the actor and now when the stamp matches', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Stamped' });
		const hash = expectedHash(labour.id);

		const [result] = appraise(db, other, [{ labourId: labour.id, stamp: hash }], day(2));

		expect(result).toEqual({ labourId: labour.id, stamped: true });
		expect(readAppraisal(db, labour.id)).toMatchObject({
			stamp: { contentHash: hash, appraisedBy: other.id, appraisedAt: day(2) },
			unappraised: false,
			stale: false
		});
	});

	it('stamps in the same item as the other writes, which are not part of the hash', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		const hash = contentHash(db, labour.id);

		const [result] = appraise(
			db,
			actor,
			[{ labourId: labour.id, brief: 'b', values: { impact: 2 }, stamp: hash }],
			day(2)
		);

		expect(result.stamped).toBe(true);
		expect(readAppraisal(db, labour.id)).toMatchObject({ brief: 'b', stale: false });
	});

	it('reports stamped false and writes no stamp when the stamp differs', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		const [result] = appraise(db, actor, [{ labourId: labour.id, stamp: 'f'.repeat(64) }], day(2));

		expect(result).toEqual({ labourId: labour.id, stamped: false });
		expect(readAppraisal(db, labour.id)).toMatchObject({ stamp: null, unappraised: true });
	});

	it('reports stamped false for an empty stamp', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		const [result] = appraise(db, actor, [{ labourId: labour.id, stamp: '' }], day(2));

		expect(result.stamped).toBe(false);
		expect(readAppraisal(db, labour.id).stamp).toBeNull();
	});

	it('still writes every other field of the item when the stamp differs', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const peer = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT);
		const stale = contentHash(db, labour.id);
		updateLabour(db, actor, labour.id, { title: 'Edited after reading' });
		const before = version(realm.id);

		const [result] = appraise(
			db,
			actor,
			[
				{
					labourId: labour.id,
					brief: 'written anyway',
					refs: [{ href: 'https://a.test', label: 'A' }],
					values: { impact: 3 },
					links: [{ type: 'evidence', to: peer.id, note: 'still lands' }],
					stamp: stale
				}
			],
			day(2)
		);

		expect(result.stamped).toBe(false);
		const view = readAppraisal(db, labour.id);
		expect(view.brief).toBe('written anyway');
		expect(view.refs).toEqual([{ href: 'https://a.test', label: 'A' }]);
		expect(view.values).toMatchObject([{ key: 'impact', value: 3 }]);
		expect(view.links).toMatchObject([{ type: 'evidence', to: peer.id, note: 'still lands' }]);
		expect(view.stamp).toBeNull();
		expect(version(realm.id)).toBe(before + 1);
	});

	it('leaves an earlier stamp as it was when a later stamp differs', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id, day(2), actor);
		const first = readAppraisal(db, labour.id).stamp;
		updateLabour(db, actor, labour.id, { description: 'new content' });

		const [result] = appraise(
			db,
			other,
			[{ labourId: labour.id, stamp: first!.contentHash }],
			day(3)
		);

		expect(result.stamped).toBe(false);
		expect(readAppraisal(db, labour.id).stamp).toEqual(first);
		expect(readAppraisal(db, labour.id).stale).toBe(true);
	});

	it('leaves an earlier stamp as it was when the item has no stamp', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id, day(2), actor);
		const first = readAppraisal(db, labour.id).stamp;

		const [result] = appraise(db, other, [{ labourId: labour.id, brief: 'x' }], day(3));

		expect(result.stamped).toBe(false);
		expect(readAppraisal(db, labour.id).stamp).toEqual(first);
	});

	it('re-stamps with the new hash, actor and time once the content has changed', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id, day(2), actor);
		updateLabour(db, actor, labour.id, { title: 'Changed' });
		expect(readAppraisal(db, labour.id).stale).toBe(true);

		const [result] = stamped(labour.id, day(3), other);

		expect(result.stamped).toBe(true);
		expect(readAppraisal(db, labour.id)).toMatchObject({
			stamp: { contentHash: expectedHash(labour.id), appraisedBy: other.id, appraisedAt: day(3) },
			stale: false
		});
	});

	it('re-stamps unchanged content, moving appraisedBy and appraisedAt', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id, day(2), actor);

		stamped(labour.id, day(5), other);

		expect(readAppraisal(db, labour.id).stamp).toEqual({
			contentHash: expectedHash(labour.id),
			appraisedBy: other.id,
			appraisedAt: day(5)
		});
	});
});

describe('readAppraisal', () => {
	it('reads a Labour with no agent layer as empty and unappraised', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Fresh' });

		expect(readAppraisal(db, labour.id)).toEqual({
			labourId: labour.id,
			brief: '',
			refs: [],
			setBy: null,
			setAt: null,
			contentHash: expectedHash(labour.id),
			stamp: null,
			unappraised: true,
			stale: false,
			values: [],
			links: []
		});
	});

	it('reads the whole agent layer: Brief, References, values and Links from either end', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const labour = seedLabour(db, { realmId: am.id });
		const out = seedLabour(db, { realmId: bl.id });
		const into = seedLabour(db, { realmId: am.id });
		define(am.id, IMPACT);
		appraise(
			db,
			actor,
			[
				{
					labourId: labour.id,
					brief: 'Summary',
					refs: [{ href: 'https://a.test', label: 'A' }],
					values: { impact: 5 },
					links: [{ type: 'evidence', to: out.id, note: 'supports' }],
					stamp: contentHash(db, labour.id)
				},
				{ labourId: into.id, links: [{ type: 'blocks', to: labour.id }] }
			],
			day(2)
		);

		const view = readAppraisal(db, labour.id);

		expect(view).toMatchObject({
			labourId: labour.id,
			brief: 'Summary',
			refs: [{ href: 'https://a.test', label: 'A' }],
			setBy: actor.id,
			setAt: day(2),
			contentHash: expectedHash(labour.id),
			stamp: { contentHash: expectedHash(labour.id), appraisedBy: actor.id, appraisedAt: day(2) },
			unappraised: false,
			stale: false
		});
		expect(view.values).toEqual(readValues(db, labour.id));
		expect(view.links).toEqual(readLinks(db, labour.id));
		expect(view.links.map((l) => [l.type, l.from, l.to])).toEqual([
			['evidence', labour.id, out.id],
			['blocks', into.id, labour.id]
		]);
	});

	it('refuses an unknown Labour as not_found', () => {
		expectDomainError(() => readAppraisal(db, 999), 'not_found');
	});

	it('is not stale while it has never been stamped, even after the content changes', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		updateLabour(db, actor, labour.id, { title: 'Changed' });

		expect(readAppraisal(db, labour.id)).toMatchObject({ unappraised: true, stale: false });
	});

	describe.each<[string, (id: number) => void]>([
		['the title changes', (id) => updateLabour(db, actor, id, { title: 'Renamed' })],
		['the description changes', (id) => updateLabour(db, actor, id, { description: 'More' })],
		['a Label is added', (id) => updateLabour(db, actor, id, { addLabels: ['bug'] })],
		['a Comment is added', (id) => void addComment(db, actor, id, 'late news')]
	])('goes stale when %s', (_name, change) => {
		it('shows the stamp unchanged and the current hash moved on', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			stamped(labour.id);
			const stamp = readAppraisal(db, labour.id).stamp;

			change(labour.id);

			const view = readAppraisal(db, labour.id);
			expect(view.stale).toBe(true);
			expect(view.unappraised).toBe(false);
			expect(view.stamp).toEqual(stamp);
			expect(view.contentHash).toBe(expectedHash(labour.id));
			expect(view.contentHash).not.toBe(stamp!.contentHash);
		});
	});

	it('goes stale when a Label is removed', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, labels: ['bug'] });
		stamped(labour.id);

		updateLabour(db, actor, labour.id, { removeLabels: ['bug'] });

		expect(readAppraisal(db, labour.id).stale).toBe(true);
	});

	it('goes stale when a Comment is edited or deleted', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		const comment = addComment(db, actor, labour.id, 'before');
		stamped(labour.id);

		editComment(db, actor, comment.id, 'after');
		expect(readAppraisal(db, labour.id).stale).toBe(true);

		stamped(labour.id, day(3));
		expect(readAppraisal(db, labour.id).stale).toBe(false);

		deleteComment(db, actor, comment.id);
		expect(readAppraisal(db, labour.id).stale).toBe(true);
	});

	it('is current again after a change is reverted', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id, title: 'Original' });
		stamped(labour.id);

		updateLabour(db, actor, labour.id, { title: 'Detour' });
		updateLabour(db, actor, labour.id, { title: 'Original' });

		expect(readAppraisal(db, labour.id).stale).toBe(false);
	});

	describe('stays current after', () => {
		it('a move to another Realm', () => {
			const am = seedRealm(db, 'AM');
			const bl = seedRealm(db, 'BL');
			const labour = seedLabour(db, { realmId: am.id });
			stamped(labour.id);

			moveLabour(db, actor, labour.id, { realmId: bl.id });

			expect(readAppraisal(db, labour.id)).toMatchObject({ stale: false, unappraised: false });
		});

		it('a State change and closing', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			stamped(labour.id);
			const doing = createState(db, actor, realm.id, {
				key: 'doing',
				label: 'Doing',
				color: '#000000',
				icon: 'play'
			});

			updateLabour(db, actor, labour.id, { stateId: doing.id });
			updateLabour(db, actor, labour.id, { stateId: closedOf(realm.id).id });

			expect(readAppraisal(db, labour.id)).toMatchObject({ stale: false, unappraised: false });
		});

		it('a Rank, Assignee or Owner change', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			seedLabour(db, { realmId: realm.id });
			stamped(labour.id);

			rankLabour(db, actor, labour.id, 'bottom');
			updateLabour(db, actor, labour.id, { assigneeId: other.id, ownerId: other.id });

			expect(readAppraisal(db, labour.id).stale).toBe(false);
		});

		it('an agent write that does not stamp', () => {
			const realm = seedRealm(db, 'AM');
			const labour = seedLabour(db, { realmId: realm.id });
			const peer = seedLabour(db, { realmId: realm.id });
			define(realm.id, IMPACT);
			stamped(labour.id);

			appraise(
				db,
				other,
				[
					{
						labourId: labour.id,
						brief: 'rewritten',
						refs: [{ href: 'x' }],
						values: { impact: 1 },
						links: [{ type: 'relates', to: peer.id }]
					}
				],
				day(3)
			);

			expect(readAppraisal(db, labour.id)).toMatchObject({ stale: false, unappraised: false });
		});
	});
});

describe('appraise: isolation from the board', () => {
	it('records no Event and changes no column of any Labour row', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a = seedLabour(db, { realmId: am.id });
		const b = seedLabour(db, { realmId: bl.id });
		define(am.id, IMPACT);
		define(bl.id, IMPACT);
		const eventsBefore = db.select().from(events).all();
		const laboursBefore = db.select().from(labours).orderBy(asc(labours.id)).all();

		appraise(
			db,
			actor,
			[
				{
					labourId: a.id,
					brief: 'b',
					refs: [{ href: 'r' }],
					values: { impact: 3 },
					links: [
						{ type: 'evidence', to: b.id },
						{ type: 'blocks', from: b.id },
						{ type: 'relates', to: b.id, note: 'n' }
					],
					stamp: contentHash(db, a.id)
				},
				{
					labourId: b.id,
					values: { impact: 1 },
					links: [{ type: 'evidence', to: a.id, remove: true }]
				}
			],
			new Date(Date.UTC(2031, 5, 1))
		);

		expect(db.select().from(events).all()).toEqual(eventsBefore);
		expect(db.select().from(labours).orderBy(asc(labours.id)).all()).toEqual(laboursBefore);
	});
});

describe('listUnappraised', () => {
	const page = { offset: 0, limit: 50 };
	const list = (filter: { realmId?: number; includeClosed?: boolean } = {}, p = page) =>
		listUnappraised(db, filter, p);
	const close = (realmId: number, id: number) =>
		updateLabour(db, actor, id, { stateId: closedOf(realmId).id });

	it('lists a Labour never stamped as unappraised', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });

		expect(list()).toEqual({ items: [{ labourId: labour.id, reason: 'unappraised' }], total: 1 });
	});

	it('does not list a Labour whose stamp is current', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id);

		expect(list()).toEqual({ items: [], total: 0 });
	});

	it('lists a Labour written to with a wrong stamp as unappraised', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		appraise(
			db,
			actor,
			[{ labourId: labour.id, brief: 'read, not stamped', stamp: 'wrong' }],
			day(2)
		);

		expect(list().items).toEqual([{ labourId: labour.id, reason: 'unappraised' }]);
	});

	it('lists a stamped Labour as content once its content has changed', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id);

		addComment(db, actor, labour.id, 'new info');

		expect(list().items).toEqual([{ labourId: labour.id, reason: 'content' }]);
	});

	it('drops a Labour from the list when it is stamped against its current content', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id);
		updateLabour(db, actor, labour.id, { title: 'Changed' });
		expect(list().total).toBe(1);

		stamped(labour.id, day(3));

		expect(list()).toEqual({ items: [], total: 0 });
	});

	it('does not list a stamped Labour after a move or a Rank change', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const moved = seedLabour(db, { realmId: am.id });
		const ranked = seedLabour(db, { realmId: bl.id });
		const unread = seedLabour(db, { realmId: bl.id });
		stamped(moved.id);
		stamped(ranked.id);

		moveLabour(db, actor, moved.id, { realmId: bl.id });
		rankLabour(db, actor, ranked.id, 'bottom');

		expect(list({ includeClosed: true })).toEqual({
			items: [{ labourId: unread.id, reason: 'unappraised' }],
			total: 1
		});
	});

	it('does not list a stamped Labour after it is closed', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		stamped(labour.id);

		close(realm.id, labour.id);

		expect(list({ includeClosed: true })).toEqual({ items: [], total: 0 });
	});

	it('lists a stamped Labour as values when a value was set before its Attribute was revised', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		setValues(db, actor, labour.id, { impact: 3 }, day(2));
		stamped(labour.id, day(2));
		expect(list().total).toBe(0);

		reviseRubric(realm.id, 'impact', 'scale', day(3));

		expect(list().items).toEqual([{ labourId: labour.id, reason: 'values' }]);
	});

	it('does not list a Labour with no value for the revised Attribute', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		stamped(labour.id, day(2));

		reviseRubric(realm.id, 'impact', 'scale', day(3));

		expect(list().total).toBe(0);
	});

	it('stops listing a values Labour once the stale value is set again', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		setValues(db, actor, labour.id, { impact: 3 }, day(2));
		stamped(labour.id, day(2));
		reviseRubric(realm.id, 'impact', 'scale', day(3));
		expect(list().total).toBe(1);

		appraise(db, actor, [{ labourId: labour.id, values: { impact: 3 } }], day(4));

		expect(list().total).toBe(0);
	});

	it('stops listing a values Labour once the stale value is cleared', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		setValues(db, actor, labour.id, { impact: 3 }, day(2));
		stamped(labour.id, day(2));
		reviseRubric(realm.id, 'impact', 'scale', day(3));

		appraise(db, actor, [{ labourId: labour.id, values: { impact: null } }], day(4));

		expect(list().total).toBe(0);
	});

	it('names one reason per Labour, the first that applies: unappraised before content', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		setValues(db, actor, labour.id, { impact: 3 }, day(2));
		reviseRubric(realm.id, 'impact', 'scale', day(3));

		expect(list().items).toEqual([{ labourId: labour.id, reason: 'unappraised' }]);
	});

	it('names content before values for a Labour with both', () => {
		const realm = seedRealm(db, 'AM');
		const labour = seedLabour(db, { realmId: realm.id });
		define(realm.id, IMPACT, day(1));
		setValues(db, actor, labour.id, { impact: 3 }, day(2));
		stamped(labour.id, day(2));
		reviseRubric(realm.id, 'impact', 'scale', day(3));
		updateLabour(db, actor, labour.id, { title: 'Changed' });

		expect(list()).toEqual({ items: [{ labourId: labour.id, reason: 'content' }], total: 1 });
	});

	it('orders all unappraised, then all content, then all values, newest Labour first in each', () => {
		const realm = seedRealm(db, 'AM');
		define(realm.id, IMPACT, day(1));
		const l = Array.from({ length: 6 }, (_, i) =>
			seedLabour(db, { realmId: realm.id, title: `L${i}` })
		);
		for (const i of [1, 2, 4, 5]) setValues(db, actor, l[i].id, { impact: 2 }, day(2));
		for (const i of [1, 2, 4, 5]) stamped(l[i].id, day(2));
		reviseRubric(realm.id, 'impact', 'scale', day(3));
		for (const i of [1, 4]) updateLabour(db, actor, l[i].id, { title: `Edited ${i}` });

		expect(list().items).toEqual([
			{ labourId: l[3].id, reason: 'unappraised' },
			{ labourId: l[0].id, reason: 'unappraised' },
			{ labourId: l[4].id, reason: 'content' },
			{ labourId: l[1].id, reason: 'content' },
			{ labourId: l[5].id, reason: 'values' },
			{ labourId: l[2].id, reason: 'values' }
		]);
		expect(list().total).toBe(6);
	});

	it('limits to one Realm with realmId, and counts only that Realm in total', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const a1 = seedLabour(db, { realmId: am.id });
		const a2 = seedLabour(db, { realmId: am.id });
		const b1 = seedLabour(db, { realmId: bl.id });

		expect(list({ realmId: am.id })).toEqual({
			items: [
				{ labourId: a2.id, reason: 'unappraised' },
				{ labourId: a1.id, reason: 'unappraised' }
			],
			total: 2
		});
		expect(list({ realmId: bl.id })).toEqual({
			items: [{ labourId: b1.id, reason: 'unappraised' }],
			total: 1
		});
		expect(list().total).toBe(3);
	});

	it('lists nothing for a Realm with no Labours', () => {
		const realm = seedRealm(db, 'AM');

		expect(list({ realmId: realm.id })).toEqual({ items: [], total: 0 });
	});

	it('leaves out Closed Labours by default and when includeClosed is false', () => {
		const realm = seedRealm(db, 'AM');
		const open = seedLabour(db, { realmId: realm.id });
		const closed = seedLabour(db, { realmId: realm.id });
		close(realm.id, closed.id);

		expect(list()).toEqual({ items: [{ labourId: open.id, reason: 'unappraised' }], total: 1 });
		expect(list({ includeClosed: false }).total).toBe(1);
	});

	it('includes Closed Labours when includeClosed is true, whatever their reason', () => {
		const realm = seedRealm(db, 'AM');
		const never = seedLabour(db, { realmId: realm.id });
		const changed = seedLabour(db, { realmId: realm.id });
		stamped(changed.id);
		updateLabour(db, actor, changed.id, { title: 'Edited' });
		close(realm.id, never.id);
		close(realm.id, changed.id);

		expect(list({ includeClosed: true })).toEqual({
			items: [
				{ labourId: never.id, reason: 'unappraised' },
				{ labourId: changed.id, reason: 'content' }
			],
			total: 2
		});
		expect(list().total).toBe(0);
	});

	it('combines the Realm filter with includeClosed', () => {
		const am = seedRealm(db, 'AM');
		const bl = seedRealm(db, 'BL');
		const closedAm = seedLabour(db, { realmId: am.id });
		seedLabour(db, { realmId: bl.id });
		close(am.id, closedAm.id);

		expect(list({ realmId: am.id, includeClosed: true }).items).toEqual([
			{ labourId: closedAm.id, reason: 'unappraised' }
		]);
		expect(list({ realmId: am.id }).total).toBe(0);
	});

	it('pages the ordered list, with total counting every page', () => {
		const realm = seedRealm(db, 'AM');
		const l = Array.from({ length: 5 }, () => seedLabour(db, { realmId: realm.id }));
		const newestFirst = l.map((x) => x.id).reverse();

		const first = list({}, { offset: 0, limit: 2 });
		const second = list({}, { offset: 2, limit: 2 });
		const last = list({}, { offset: 4, limit: 2 });

		expect(first.items.map((i) => i.labourId)).toEqual(newestFirst.slice(0, 2));
		expect(second.items.map((i) => i.labourId)).toEqual(newestFirst.slice(2, 4));
		expect(last.items.map((i) => i.labourId)).toEqual(newestFirst.slice(4));
		expect([first.total, second.total, last.total]).toEqual([5, 5, 5]);
	});

	it('pages across the boundary between reason groups', () => {
		const realm = seedRealm(db, 'AM');
		const old = seedLabour(db, { realmId: realm.id });
		stamped(old.id);
		updateLabour(db, actor, old.id, { title: 'Edited' });
		const fresh = seedLabour(db, { realmId: realm.id });

		expect(list({}, { offset: 0, limit: 1 }).items).toEqual([
			{ labourId: fresh.id, reason: 'unappraised' }
		]);
		expect(list({}, { offset: 1, limit: 1 })).toEqual({
			items: [{ labourId: old.id, reason: 'content' }],
			total: 2
		});
	});

	it('returns no items, and the full total, for an offset past the end', () => {
		const realm = seedRealm(db, 'AM');
		seedLabour(db, { realmId: realm.id });
		seedLabour(db, { realmId: realm.id });

		expect(list({}, { offset: 10, limit: 5 })).toEqual({ items: [], total: 2 });
	});
});
