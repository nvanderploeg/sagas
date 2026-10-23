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

const code = (action: () => unknown) => {
	try {
		action();
	} catch (error) {
		if (error instanceof DomainError) return error.code;
		throw error;
	}
	return 'ok';
};

beforeEach(() => {
	setAccessEnforced(true);
	db = testDb();
	ada = { id: seedUser(db, 'ada') };
	bob = { id: seedUser(db, 'bob') };
	cy = { id: seedUser(db, 'cy') };
	realmId = createRealm(db, ada, { name: 'Amber', key: 'AM', initialState: TODO }).id;
});

afterEach(() => setAccessEnforced(false));

describe('a private Realm', () => {
	it("makes its creator the Owner and is invisible to anyone else, as if it didn't exist", () => {
		expect(code(() => requireRealmRole(db, ada, realmId, 'owner'))).toBe('ok');
		expect(code(() => requireRealmRole(db, bob, realmId, 'viewer'))).toBe('not_found');
		expect(visibleRealmIds(db, ada)).toEqual([realmId]);
		expect(visibleRealmIds(db, bob)).toEqual([]);
	});

	it('refuses a role below the one needed as forbidden, once the Realm is visible', () => {
		offerMembership(db, ada, realmId, bob.id, 'viewer');
		acceptOffer(db, bob, realmId);

		expect(code(() => requireRealmRole(db, bob, realmId, 'viewer'))).toBe('ok');
		expect(code(() => requireRealmRole(db, bob, realmId, 'editor'))).toBe('forbidden');
	});
});

describe('Offers', () => {
	it('grant nothing until accepted', () => {
		offerMembership(db, ada, realmId, bob.id, 'editor');

		expect(code(() => requireRealmRole(db, bob, realmId, 'viewer'))).toBe('not_found');
		expect(listOffers(db, bob.id).map((o) => [o.realmKey, o.role, o.invitedBy])).toEqual([
			['AM', 'editor', ada.id]
		]);

		acceptOffer(db, bob, realmId);

		expect(code(() => requireRealmRole(db, bob, realmId, 'editor'))).toBe('ok');
		expect(listOffers(db, bob.id)).toEqual([]);
	});

	it('can be made only by an Owner', () => {
		offerMembership(db, ada, realmId, bob.id, 'editor');
		acceptOffer(db, bob, realmId);

		expect(code(() => offerMembership(db, bob, realmId, cy.id, 'viewer'))).toBe('forbidden');
		expect(code(() => offerMembership(db, cy, realmId, cy.id, 'owner'))).toBe('not_found');
	});

	it('leave an existing Membership or Offer as it is', () => {
		offerMembership(db, ada, realmId, bob.id, 'viewer');

		const again = offerMembership(db, ada, realmId, bob.id, 'owner');

		expect(again.role).toBe('viewer');
	});

	it('are deleted by the invitee declining or an Owner withdrawing', () => {
		offerMembership(db, ada, realmId, bob.id, 'viewer');
		offerMembership(db, ada, realmId, cy.id, 'viewer');

		declineOffer(db, bob, realmId);
		withdrawOffer(db, ada, realmId, cy.id);

		expect(listOffers(db, bob.id)).toEqual([]);
		expect(listOffers(db, cy.id)).toEqual([]);
		expect(code(() => acceptOffer(db, bob, realmId))).toBe('not_found');
	});

	it('show to Owners in the member list and to nobody else', () => {
		offerMembership(db, ada, realmId, bob.id, 'editor');
		offerMembership(db, ada, realmId, cy.id, 'viewer');
		acceptOffer(db, cy, realmId);

		const owner = listMembers(db, ada, realmId).map((m) => [m.username, m.status]);
		const viewer = listMembers(db, cy, realmId).map((m) => [m.username, m.status]);

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
	it('cannot be demoted or leave', () => {
		expect(code(() => setMemberRole(db, ada, realmId, ada.id, 'editor'))).toBe('conflict');
		expect(code(() => removeMember(db, ada, realmId, ada.id))).toBe('conflict');
	});

	it('can leave once another Owner exists', () => {
		offerMembership(db, ada, realmId, bob.id, 'editor');
		acceptOffer(db, bob, realmId);
		setMemberRole(db, ada, realmId, bob.id, 'owner');

		removeMember(db, ada, realmId, ada.id);

		expect(code(() => requireRealmRole(db, ada, realmId, 'viewer'))).toBe('not_found');
	});
});

describe('removing a member', () => {
	it("clears their Assignee, hands their Owner to the earliest remaining Owner, and leaves others' alone", () => {
		offerMembership(db, ada, realmId, bob.id, 'editor');
		acceptOffer(db, bob, realmId);
		const mine = createLabour(db, ada, {
			realmId,
			title: 'Mine',
			ownerId: bob.id,
			assigneeId: bob.id
		});
		const other = createLabour(db, ada, {
			realmId,
			title: 'Other',
			ownerId: ada.id,
			assigneeId: ada.id
		});

		removeMember(db, ada, realmId, bob.id);

		expect(readLabour(db, mine.id)).toMatchObject({ ownerId: ada.id, assigneeId: null });
		expect(readLabour(db, other.id)).toMatchObject({ ownerId: ada.id, assigneeId: ada.id });
	});

	it('is the Owner’s call unless it is oneself', () => {
		offerMembership(db, ada, realmId, bob.id, 'editor');
		acceptOffer(db, bob, realmId);
		offerMembership(db, ada, realmId, cy.id, 'editor');
		acceptOffer(db, cy, realmId);

		expect(code(() => removeMember(db, bob, realmId, cy.id))).toBe('forbidden');
		expect(code(() => removeMember(db, bob, realmId, bob.id))).toBe('ok');
	});
});
