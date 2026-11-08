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

const code = async (action: () => unknown) => {
	try {
		await action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	return 'ok';
};

async function join(name: string, role: Role) {
	await offerMembership(db, people.owner, realmId, people[name].id, role);
	await acceptOffer(db, people[name], realmId);
}

beforeEach(async () => {
	setAccessEnforced(true);
	db = await testDb();
	for (const name of ['owner', 'editor', 'viewer', 'stranger']) {
		people[name] = { id: await seedUser(db, name) };
	}
	realmId = (await createRealm(db, people.owner, { name: 'Amber', key: 'AM', initialState: TODO }))
		.id;
	await join('editor', 'editor');
	await join('viewer', 'viewer');
	labourId = (
		await createLabour(db, people.owner, {
			realmId,
			title: 'First',
			ownerId: people.owner.id
		})
	).id;
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

	it.each(writes)(
		'%s: an editor may, a viewer is forbidden, a stranger sees nothing',
		async (_, run) => {
			expect(await code(() => run(people.editor))).toBe('ok');
			expect(await code(() => run(people.viewer))).toBe('forbidden');
			expect(await code(() => run(people.stranger))).toBe('not_found');
		}
	);

	it('delete follows the same rule', async () => {
		expect(await code(() => deleteLabour(db, people.stranger, labourId))).toBe('not_found');
		expect(await code(() => deleteLabour(db, people.viewer, labourId))).toBe('forbidden');
		expect(await code(() => deleteLabour(db, people.editor, labourId))).toBe('ok');
	});

	it('refuses an Owner or Assignee who is not a member', async () => {
		expect(
			await code(() =>
				createLabour(db, people.editor, { realmId, title: 'x', ownerId: people.stranger.id })
			)
		).toBe('invalid');
		expect(
			await code(() =>
				updateLabour(db, people.editor, labourId, { assigneeId: people.stranger.id })
			)
		).toBe('invalid');
		expect(
			await code(() => updateLabour(db, people.editor, labourId, { assigneeId: people.viewer.id }))
		).toBe('ok');
	});

	it('needs editor access in both Realms to move a Labour', async () => {
		const other = await createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});

		expect(await code(() => moveLabour(db, people.editor, labourId, { realmId: other.id }))).toBe(
			'not_found'
		);
	});

	it("needs editor access to a parent's Realm", async () => {
		const other = await createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});
		const theirs = await createLabour(db, people.stranger, {
			realmId: other.id,
			title: 'Theirs',
			ownerId: people.stranger.id
		});

		expect(await code(() => setParent(db, people.editor, labourId, theirs.id))).toBe('not_found');
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

	it.each(configs)('%s: only an Owner', async (_, run) => {
		expect(await code(() => run(people.stranger))).toBe('not_found');
		expect(await code(() => run(people.viewer))).toBe('forbidden');
		expect(await code(() => run(people.editor))).toBe('forbidden');
		expect(await code(() => run(people.owner))).toBe('ok');
	});

	it('delete: only an Owner', async () => {
		expect(await code(() => deleteRealm(db, people.editor, realmId))).toBe('forbidden');
		expect(await code(() => deleteRealm(db, people.owner, realmId))).toBe('ok');
	});
});

describe('Quests', () => {
	const spec = (name: string, ownerId: number) => ({ realmId, name, ownerId });

	it("follow their Realm's roles: an editor changes them, a viewer cannot, a stranger sees nothing", async () => {
		const quest = await createQuest(db, people.editor, spec('Q', people.editor.id));

		expect(await code(() => updateQuest(db, people.owner, quest.id, { name: 'Z' }))).toBe('ok');
		expect(await code(() => updateQuest(db, people.viewer, quest.id, { name: 'Y' }))).toBe(
			'forbidden'
		);
		expect(await code(() => updateQuest(db, people.stranger, quest.id, { name: 'X' }))).toBe(
			'not_found'
		);
		expect(await code(() => createQuest(db, people.viewer, spec('V', people.viewer.id)))).toBe(
			'forbidden'
		);
		expect(await code(() => createQuest(db, people.stranger, spec('S', people.stranger.id)))).toBe(
			'not_found'
		);
	});

	it('are owned by a member of their Realm', async () => {
		expect(await code(() => createQuest(db, people.owner, spec('Q', people.stranger.id)))).toBe(
			'invalid'
		);
	});

	it('may list Labours of another Realm the caller can only read, and none they cannot see', async () => {
		const other = await createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});
		const theirs = await createLabour(db, people.stranger, {
			realmId: other.id,
			title: 'Theirs',
			ownerId: people.stranger.id
		});
		const quest = await createQuest(db, people.editor, spec('Q', people.editor.id));

		expect(await code(() => addQuestLabour(db, people.editor, quest.id, theirs.id))).toBe(
			'not_found'
		);

		await offerMembership(db, people.stranger, other.id, people.editor.id, 'viewer');
		await acceptOffer(db, people.editor, other.id);

		expect(await code(() => addQuestLabour(db, people.editor, quest.id, theirs.id))).toBe('ok');
	});
});

describe('Quests with children', () => {
	it('refuse a child in a Realm the caller cannot edit, which addQuestLabours would refuse too', async () => {
		const other = await createRealm(db, people.stranger, {
			name: 'Other',
			key: 'OT',
			initialState: TODO
		});
		const child = await createLabour(db, people.stranger, {
			realmId: other.id,
			title: 'Child',
			ownerId: people.stranger.id
		});
		await setParent(db, people.stranger, child.id, null);
		await db.update(labours).set({ parentId: labourId }).where(eq(labours.id, child.id));
		const quest = await createQuest(db, people.editor, {
			realmId,
			name: 'Q',
			ownerId: people.editor.id
		});

		expect(
			await code(() => addQuestLabourWithChildren(db, people.editor, quest.id, labourId))
		).toBe('not_found');
	});
});

describe('deleting a Pulse', () => {
	const affinity = async () => {
		const { attribute } = await defineAttribute(db, people.owner, realmId, {
			key: 'mood',
			kind: 'text',
			label: 'Mood',
			rubric: 'How it feels.'
		} as never);
		return (
			await db
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
		)[0].id;
	};

	it("leaves a User's Affinity Pulse to that User alone", async () => {
		const id = await affinity();

		expect(await code(() => deletePulse(db, people.owner, id))).toBe('not_found');
		expect(await code(() => deletePulse(db, people.viewer, id))).toBe('ok');
	});
});
