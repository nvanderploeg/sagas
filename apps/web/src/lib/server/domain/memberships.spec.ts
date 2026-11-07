import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '#lib/server/db/client.ts';
import { testDb } from '#lib/server/test/db.ts';
import { seedUser, TODO } from '#lib/server/test/fixtures.ts';
import { requireRealmRole, setAccessEnforced, visibleRealmIds } from './access.ts';
import { DomainError } from './errors.ts';
import { createLabour, readLabour } from './labours.ts';
import {
	acceptOffer,
	declineOffer,
	listMembers,
	listOffers,
	offerMembership,
	removeMember,
	setMemberRole,
	withdrawOffer
} from './memberships.ts';
import { createRealm } from './realms.ts';

let db: Db;
let ada: { id: number };
let bob: { id: number };
let cy: { id: number };
let realmId: number;

const code = async (action: () => unknown) => {
	try {
		await action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	return 'ok';
};

beforeEach(async () => {
	setAccessEnforced(true);
	db = await testDb();
	ada = { id: await seedUser(db, 'ada') };
	bob = { id: await seedUser(db, 'bob') };
	cy = { id: await seedUser(db, 'cy') };
	realmId = (await createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO })).id;
});

afterEach(() => setAccessEnforced(false));

describe('a private Realm', () => {
	it("makes its creator the Owner and is invisible to anyone else, as if it didn't exist", async () => {
		expect(await code(() => requireRealmRole(db, ada, realmId, 'owner'))).toBe('ok');
		expect(await code(() => requireRealmRole(db, bob, realmId, 'viewer'))).toBe('not_found');
		expect(await visibleRealmIds(db, ada)).toEqual([realmId]);
		expect(await visibleRealmIds(db, bob)).toEqual([]);
	});

	it('refuses a role below the one needed as forbidden, once the Realm is visible', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'viewer');
		await acceptOffer(db, bob, realmId);

		expect(await code(() => requireRealmRole(db, bob, realmId, 'viewer'))).toBe('ok');
		expect(await code(() => requireRealmRole(db, bob, realmId, 'editor'))).toBe('forbidden');
	});
});

describe('Offers', () => {
	it('grant nothing until accepted', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'editor');

		expect(await code(() => requireRealmRole(db, bob, realmId, 'viewer'))).toBe('not_found');
		expect((await listOffers(db, bob.id)).map((o) => [o.realmKey, o.role, o.invitedBy])).toEqual([
			['AM', 'editor', ada.id]
		]);

		await acceptOffer(db, bob, realmId);

		expect(await code(() => requireRealmRole(db, bob, realmId, 'editor'))).toBe('ok');
		expect(await listOffers(db, bob.id)).toEqual([]);
	});

	it('can be made only by an Owner', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'editor');
		await acceptOffer(db, bob, realmId);

		expect(await code(() => offerMembership(db, bob, realmId, cy.id, 'viewer'))).toBe('forbidden');
		expect(await code(() => offerMembership(db, cy, realmId, cy.id, 'owner'))).toBe('not_found');
	});

	it('leave an existing Membership or Offer as it is', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'viewer');

		const again = await offerMembership(db, ada, realmId, bob.id, 'owner');

		expect(again.role).toBe('viewer');
	});

	it('are deleted by the invitee declining or an Owner withdrawing', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'viewer');
		await offerMembership(db, ada, realmId, cy.id, 'viewer');

		await declineOffer(db, bob, realmId);
		await withdrawOffer(db, ada, realmId, cy.id);

		expect(await listOffers(db, bob.id)).toEqual([]);
		expect(await listOffers(db, cy.id)).toEqual([]);
		expect(await code(() => acceptOffer(db, bob, realmId))).toBe('not_found');
	});

	it('show to Owners in the member list and to nobody else', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'editor');
		await offerMembership(db, ada, realmId, cy.id, 'viewer');
		await acceptOffer(db, cy, realmId);

		const owner = (await listMembers(db, ada, realmId)).map((m) => [m.username, m.status]);
		const viewer = (await listMembers(db, cy, realmId)).map((m) => [m.username, m.status]);

		expect(owner).toEqual([
			['ada', 'active'],
			['bob', 'pending'],
			['cy', 'active']
		]);
		expect(viewer).toEqual([
			['ada', 'active'],
			['cy', 'active']
		]);
	});
});

describe('the last Owner', () => {
	it('cannot be demoted or leave', async () => {
		expect(await code(() => setMemberRole(db, ada, realmId, ada.id, 'editor'))).toBe('conflict');
		expect(await code(() => removeMember(db, ada, realmId, ada.id))).toBe('conflict');
	});

	it('can leave once another Owner exists', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'editor');
		await acceptOffer(db, bob, realmId);
		await setMemberRole(db, ada, realmId, bob.id, 'owner');

		await removeMember(db, ada, realmId, ada.id);

		expect(await code(() => requireRealmRole(db, ada, realmId, 'viewer'))).toBe('not_found');
	});
});

describe('removing a member', () => {
	it("clears their Assignee, hands their Owner to the earliest remaining Owner, and leaves others' alone", async () => {
		await offerMembership(db, ada, realmId, bob.id, 'editor');
		await acceptOffer(db, bob, realmId);
		const mine = await createLabour(db, ada, {
			realmId,
			title: 'Mine',
			ownerId: bob.id,
			assigneeId: bob.id
		});
		const other = await createLabour(db, ada, {
			realmId,
			title: 'Other',
			ownerId: ada.id,
			assigneeId: ada.id
		});

		await removeMember(db, ada, realmId, bob.id);

		expect(await readLabour(db, mine.id)).toMatchObject({ ownerId: ada.id, assigneeId: null });
		expect(await readLabour(db, other.id)).toMatchObject({ ownerId: ada.id, assigneeId: ada.id });
	});

	it('is the Owner’s call unless it is oneself', async () => {
		await offerMembership(db, ada, realmId, bob.id, 'editor');
		await acceptOffer(db, bob, realmId);
		await offerMembership(db, ada, realmId, cy.id, 'editor');
		await acceptOffer(db, cy, realmId);

		expect(await code(() => removeMember(db, bob, realmId, cy.id))).toBe('forbidden');
		expect(await code(() => removeMember(db, bob, realmId, bob.id))).toBe('ok');
	});
});
