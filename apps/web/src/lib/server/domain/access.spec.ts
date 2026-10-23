import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { appraise } from '#lib/server/agent/appraisals.ts';
import { defineAttribute } from '#lib/server/agent/attributes.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedUser, TODO } from '#lib/server/test/fixtures.ts';
import { setAccessEnforced } from './access.ts';
import { DomainError } from './errors.ts';
import { addComment } from './comments.ts';
import {
	createLabour,
	deleteLabour,
	moveLabour,
	rankLabour,
	setParent,
	updateLabour
} from './labours.ts';
import { eq } from 'drizzle-orm';
import { labours } from '#lib/server/db/schema.ts';
import { acceptOffer, offerMembership } from './memberships.ts';
import { addQuestLabour, createQuest, updateQuest } from './quests.ts';
import { createRealm, deleteRealm, renameRealmKey, updateRealm } from './realms.ts';
import { deletePulse } from '#lib/server/agent/sentiment.ts';
import { pulses } from '#lib/server/db/schema.ts';
import { addQuestLabourWithChildren } from './quests.ts';
import { createState } from './states.ts';
import type { Role } from './access.ts';

let db: Db;
const people: Record<string, { id: number }> = {};
let realmId: number;
let labourId: number;

const code = (action: () => unknown) => {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	return 'ok';
};

function join(name: string, role: Role) {
	offerMembership(db, people.owner, realmId, people[name].id, role);
	acceptOffer(db, people[name], realmId);
}

beforeEach(() => {
	setAccessEnforced(true);
	db = testDb();
	for (const name of ['owner', 'editor', 'viewer', 'stranger']) {
		people[name] = { id: seedUser(db, name) };
	}
	realmId = createRealm(db, people.owner, { name: 'Amber', key: 'AM', initialState: TODO }).id;
	join('editor', 'editor');
	join('viewer', 'viewer');
	labourId = createLabour(db, people.owner, {
		realmId,
		title: 'First',
		ownerId: people.owner.id
	}).id;
});

afterEach(() => setAccessEnforced(false));

describe('Labour writes', () => {
	const writes: [string, (who: { id: number }) => unknown][] = [
		['create', (who) => createLabour(db, who, { realmId, title: 'New', ownerId: people.owner.id })],
		['update', (who) => updateLabour(db, who, labourId, { title: 'Renamed' })],
		['rank', (who) => rankLabour(db, who, labourId, 'top')],
		['comment', (who) => addComment(db, who, labourId, 'hello')],
		['appraise', (who) => appraise(db, who, [{ labourId, brief: 'A brief.' }])]
	];

	it.each(writes)('%s: an editor may, a viewer is forbidden, a stranger sees nothing', (_, run) => {
		expect(code(() => run(people.editor))).toBe('ok');
		expect(code(() => run(people.viewer))).toBe('forbidden');
		expect(code(() => run(people.stranger))).toBe('not_found');
	});

	it('delete follows the same rule', () => {
		expect(code(() => deleteLabour(db, people.stranger, labourId))).toBe('not_found');
		expect(code(() => deleteLabour(db, people.viewer, labourId))).toBe('forbidden');
		expect(code(() => deleteLabour(db, people.editor, labourId))).toBe('ok');
	});

	it('refuses an Owner or Assignee who is not a member', () => {
		expect(
			code(() =>
				createLabour(db, people.editor, { realmId, title: 'x', ownerId: people.stranger.id })
			)
		).toBe('invalid');
		expect(
			code(() => updateLabour(db, people.editor, labourId, { assigneeId: people.stranger.id }))
		).toBe('invalid');
		expect(
			code(() => updateLabour(db, people.editor, labourId, { assigneeId: people.viewer.id }))
		).toBe('ok');
	});

	it('needs editor access in both Realms to move a Labour', () => {
		const other = createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});

		expect(code(() => moveLabour(db, people.editor, labourId, { realmId: other.id }))).toBe(
			'not_found'
		);
	});

	it("needs editor access to a parent's Realm", () => {
		const other = createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});
		const theirs = createLabour(db, people.stranger, {
			realmId: other.id,
			title: 'Theirs',
			ownerId: people.stranger.id
		});

		expect(code(() => setParent(db, people.editor, labourId, theirs.id))).toBe('not_found');
	});
});

describe('Realm configuration', () => {
	const configs: [string, (who: { id: number }) => unknown][] = [
		['rename', (who) => updateRealm(db, who, realmId, { name: 'New name' })],
		['rekey', (who) => renameRealmKey(db, who, realmId, 'AMB')],
		[
			'add a State',
			(who) =>
				createState(db, who, realmId, {
					...TODO,
					key: `s${Math.random()}`.slice(0, 8).replace('.', '')
				})
		],
		[
			'define an Attribute',
			(who) =>
				defineAttribute(db, who, realmId, {
					key: 'impact',
					kind: 'text',
					label: 'Impact',
					rubric: 'How much it matters.'
				} as never)
		]
	];

	it.each(configs)('%s: only an Owner', (_, run) => {
		expect(code(() => run(people.stranger))).toBe('not_found');
		expect(code(() => run(people.viewer))).toBe('forbidden');
		expect(code(() => run(people.editor))).toBe('forbidden');
		expect(code(() => run(people.owner))).toBe('ok');
	});

	it('delete: only an Owner', () => {
		expect(code(() => deleteRealm(db, people.editor, realmId))).toBe('forbidden');
		expect(code(() => deleteRealm(db, people.owner, realmId))).toBe('ok');
	});
});

describe('Quests', () => {
	it('change only for their Owner, and adding a Labour needs editor access to its Realm', () => {
		const quest = createQuest(db, people.editor, { name: 'Q', ownerId: people.editor.id });

		expect(code(() => updateQuest(db, people.owner, quest.id, { name: 'Z' }))).toBe('forbidden');
		expect(code(() => addQuestLabour(db, people.editor, quest.id, labourId))).toBe('ok');

		const viewerQuest = createQuest(db, people.viewer, { name: 'V', ownerId: people.viewer.id });
		expect(code(() => addQuestLabour(db, people.viewer, viewerQuest.id, labourId))).toBe(
			'forbidden'
		);
	});
});

describe('Quests with children', () => {
	it('refuse a child in a Realm the caller cannot edit, which addQuestLabours would refuse too', () => {
		const other = createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});
		const child = createLabour(db, people.stranger, {
			realmId: other.id,
			title: 'Child',
			ownerId: people.stranger.id
		});
		setParent(db, people.stranger, child.id, null);
		db.update(labours).set({ parentId: labourId }).where(eq(labours.id, child.id)).run();
		const quest = createQuest(db, people.editor, { name: 'Q', ownerId: people.editor.id });

		expect(code(() => addQuestLabourWithChildren(db, people.editor, quest.id, labourId))).toBe(
			'not_found'
		);
	});
});

describe('deleting a Pulse', () => {
	const affinity = () => {
		const { attribute } = defineAttribute(db, people.owner, realmId, {
			key: 'mood',
			kind: 'text',
			label: 'Mood',
			rubric: 'How it feels.'
		} as never);
		return db
			.insert(pulses)
			.values({
				userId: people.viewer.id,
				authorId: people.viewer.id,
				attributeId: attribute.id,
				rawKey: 'mood',
				amount: 1,
				mood: 1
			})
			.returning({ id: pulses.id })
			.get().id;
	};

	it("leaves a User's Affinity Pulse to that User alone", () => {
		const id = affinity();

		expect(code(() => deletePulse(db, people.owner, id))).toBe('not_found');
		expect(code(() => deletePulse(db, people.viewer, id))).toBe('ok');
	});
});
