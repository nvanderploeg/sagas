import { z } from 'zod';
import { DomainError } from '../../domain/errors.ts';
import {
	acceptOffer,
	declineOffer,
	listMembers,
	listOffers,
	offerMembership,
	removeMember,
	setMemberRole,
	withdrawOffer,
	type Member
} from '../../domain/memberships.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { realmRef, userRef, type Tools } from '../tool.ts';

const role = z
	.enum(['owner', 'editor', 'viewer'])
	.describe(
		'owner manages the Realm and its members; editor works on Labours; viewer can only read'
	);

export function registerMemberTools({ db, actor, define }: Tools): void {
	const present = (member: Member) => ({
		user: member.username,
		role: member.role,
		status: member.status,
		invitedBy: member.invitedBy === null ? null : (refs.username(db, member.invitedBy) ?? null),
		createdAt: member.createdAt.toISOString(),
		acceptedAt: member.acceptedAt?.toISOString() ?? null
	});

	define(
		'list_members',
		{
			kind: 'read',
			description:
				"List a Realm's members with their roles. An Owner also sees pending Offers (status `pending`).",
			input: { realm: realmRef }
		},
		({ realm }) => {
			const members = listMembers(db, actor, refs.realmId(db, realm, actor)).map(present);
			return reply({ members }, `${count(members.length, 'member')}`);
		}
	);

	define(
		'offer_membership',
		{
			kind: 'write',
			description:
				'Owner only. Offer a User a role in a Realm. They see nothing of it until they accept (accept_offer). An existing Membership or Offer is left as it is: change an active role with set_member_role.',
			input: { realm: realmRef, user: userRef, role }
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const member = offerMembership(
				db,
				actor,
				realmId,
				refs.userId(db, args.user, actor),
				args.role
			);
			return reply({ member: present(member) }, `${member.username} is ${member.status}`);
		}
	);

	define(
		'withdraw_offer',
		{
			kind: 'write',
			description: 'Owner only. Withdraw a pending Offer made to a User.',
			input: { realm: realmRef, user: userRef }
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			withdrawOffer(db, actor, realmId, refs.userId(db, args.user, actor));
			return reply({}, 'Offer withdrawn');
		}
	);

	define(
		'set_member_role',
		{
			kind: 'write',
			description:
				"Owner only. Change an active member's role. A Realm always keeps at least one Owner.",
			input: { realm: realmRef, user: userRef, role }
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const member = setMemberRole(
				db,
				actor,
				realmId,
				refs.userId(db, args.user, actor),
				args.role
			);
			return reply({ member: present(member) }, `${member.username} is ${member.role}`);
		}
	);

	define(
		'remove_member',
		{
			kind: 'destroy',
			description:
				'Remove a member from a Realm; pass "me" to leave it. An Owner may remove anyone, the last Owner cannot go. Their Assignee clears on the Realm\'s Labours and the Labours they owned pass to the Realm\'s earliest Owner.',
			input: { realm: realmRef, user: userRef }
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			removeMember(db, actor, realmId, refs.userId(db, args.user, actor));
			return reply({}, 'Member removed');
		}
	);

	define(
		'list_offers',
		{
			kind: 'read',
			description:
				'List the Offers made to you: Realms whose Owner invited you, each with the role offered. Answer with accept_offer or decline_offer.',
			input: {}
		},
		() => {
			const offers = listOffers(db, actor.id).map((offer) => ({
				realm: offer.realmKey,
				name: offer.realmName,
				role: offer.role,
				invitedBy: offer.invitedBy === null ? null : (refs.username(db, offer.invitedBy) ?? null),
				createdAt: offer.createdAt.toISOString()
			}));
			return reply({ offers }, offers.length === 0 ? 'No Offers' : count(offers.length, 'Offer'));
		}
	);

	// An Offer's Realm is not visible yet, so it is found among your own Offers.
	const offered = (ref: string | number) => {
		const wanted = typeof ref === 'number' ? ref : ref.trim().toUpperCase();
		const found = listOffers(db, actor.id).find(
			(offer) => offer.realmId === wanted || offer.realmKey === wanted
		);
		if (found === undefined) throw new DomainError('not_found', 'You have no Offer for that Realm');
		return found.realmId;
	};

	define(
		'accept_offer',
		{
			kind: 'write',
			description: 'Accept an Offer to join a Realm, by its key from list_offers.',
			input: { realm: realmRef }
		},
		({ realm }) => {
			const member = acceptOffer(db, actor, offered(realm));
			return reply({ member: present(member) }, `Joined as ${member.role}`);
		}
	);

	define(
		'decline_offer',
		{
			kind: 'destroy',
			description: 'Decline an Offer to join a Realm.',
			input: { realm: realmRef }
		},
		({ realm }) => {
			declineOffer(db, actor, offered(realm));
			return reply({}, 'Offer declined');
		}
	);
}
