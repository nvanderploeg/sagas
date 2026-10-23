import { error, isActionFailure, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	deleteRealm,
	readRealm,
	renameRealmKey,
	setInitialState,
	updateRealm
} from '#lib/server/domain/realms.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	setNextStates,
	updateState,
	updateSubstate,
	type StyleUpdate
} from '#lib/server/domain/states.ts';
import { memberRole } from '#lib/server/domain/access.ts';
import {
	listMembers,
	offerMembership,
	removeMember,
	requireRole,
	setMemberRole,
	withdrawOffer
} from '#lib/server/domain/memberships.ts';
import { findUserByName } from '#lib/server/auth/users.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import { findRealmByKey, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

function realmFor(locals: App.Locals, key: string) {
	const realm = findRealmByKey(getDb(), key, signedIn(locals));
	if (!realm) error(404, 'No Realm has that key');
	return realm;
}

export const load: PageServerLoad = ({ params, locals }) => {
	const realm = realmFor(locals, params.key);
	if (realm.key !== params.key) redirect(307, `/r/${realm.key}/settings`);
	try {
		const viewer = signedIn(locals);
		const { seq, value } = readAtSeq(getDb(), (tx) => ({ realm: readRealm(tx, realm.id) }));
		return {
			seq,
			settings: toJson(value),
			members: toJson(listMembers(getDb(), viewer, realm.id)),
			role: memberRole(getDb(), realm.id, viewer.id),
			me: viewer.id
		};
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No Realm has that key');
		throw e;
	}
};

function keyFor(label: string, taken: string[]): string {
	const base =
		label
			.toLowerCase()
			.normalize('NFKD')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^[^a-z]+/, '')
			.replace(/-+$/, '')
			.slice(0, 28) || 'state';
	let key = base;
	for (let n = 2; taken.includes(key); n++) key = `${base}-${n}`;
	return key;
}

function style(form: FormData): StyleUpdate {
	const update: StyleUpdate = {};
	if (form.has('label')) update.label = text(form, 'label');
	if (form.has('color')) update.color = text(form, 'color');
	if (form.has('icon')) update.icon = text(form, 'icon');
	return update;
}

function newStyle(form: FormData, taken: string[]) {
	const label = text(form, 'label');
	return {
		key: keyFor(label, taken),
		label,
		color: text(form, 'color'),
		icon: text(form, 'icon')
	};
}

export const actions: Actions = {
	rename: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		return perform('rename', () => {
			updateRealm(getDb(), actor, realm.id, { name: text(form, 'name') });
		});
	},

	rekey: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		const result = perform('rekey', () => {
			const renamed = renameRealmKey(getDb(), actor, realm.id, text(form, 'key'));
			return { key: renamed.key };
		});
		if ('key' in result && result.key !== params.key) {
			redirect(303, `/r/${result.key}/settings`);
		}
		return result;
	},

	initial: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		return perform('initial', () => {
			setInitialState(getDb(), actor, realm.id, int(form, 'stateId'));
		});
	},

	addState: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		return perform('addState', () => {
			const db = getDb();
			const taken = readRealm(db, realm.id).states.map((s) => s.key);
			createState(db, actor, realm.id, newStyle(form, taken));
		});
	},

	updateState: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`state:${text(form, 'stateId')}`, () => {
			const id = int(form, 'stateId');
			updateState(getDb(), actor, id, style(form));
		});
	},

	setOpen: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`state:${text(form, 'stateId')}`, () => {
			updateState(getDb(), actor, int(form, 'stateId'), { open: text(form, 'open') === 'true' });
		});
	},

	setNext: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`state:${text(form, 'stateId')}`, () => {
			const next = form.getAll('next').map((v) => {
				const id = Number(v);
				if (!Number.isInteger(id)) throw new DomainError('invalid', 'next must be State ids');
				return id;
			});
			setNextStates(getDb(), actor, int(form, 'stateId'), next);
		});
	},

	moveState: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`state:${text(form, 'stateId')}`, () => {
			const id = int(form, 'stateId');
			moveState(getDb(), actor, id, int(form, 'index'));
		});
	},

	deleteState: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`state:${text(form, 'stateId')}`, () => {
			const id = int(form, 'stateId');
			deleteState(getDb(), actor, id);
		});
	},

	addSubstate: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		return perform(`substates:${text(form, 'stateId')}`, () => {
			const id = int(form, 'stateId');
			const db = getDb();
			const state = readRealm(db, realm.id).states.find((s) => s.id === id);
			const taken = state?.substates.map((s) => s.key) ?? [];
			createSubstate(db, actor, id, newStyle(form, taken));
		});
	},

	updateSubstate: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`substate:${text(form, 'substateId')}`, () => {
			const id = int(form, 'substateId');
			updateSubstate(getDb(), actor, id, style(form));
		});
	},

	moveSubstate: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`substate:${text(form, 'substateId')}`, () => {
			const id = int(form, 'substateId');
			moveSubstate(getDb(), actor, id, int(form, 'index'));
		});
	},

	deleteSubstate: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`substate:${text(form, 'substateId')}`, () => {
			const id = int(form, 'substateId');
			deleteSubstate(getDb(), actor, id);
		});
	},

	defaultSubstate: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform(`substate:${text(form, 'substateId')}`, () => {
			const id = int(form, 'substateId');
			setDefaultSubstate(getDb(), actor, int(form, 'stateId'), id);
		});
	},

	offer: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		return perform('members', () => {
			const db = getDb();
			const user = findUserByName(db, text(form, 'username'));
			if (!user) throw new DomainError('not_found', 'No User has that username');
			offerMembership(db, actor, realm.id, user.id, requireRole(text(form, 'role')));
		});
	},

	setRole: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		return perform('members', () => {
			setMemberRole(getDb(), actor, realm.id, int(form, 'userId'), requireRole(text(form, 'role')));
		});
	},

	removeMember: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = realmFor(locals, params.key);
		const userId = int(form, 'userId');
		const result = perform('members', () => {
			const db = getDb();
			if (form.get('pending') === 'true') withdrawOffer(db, actor, realm.id, userId);
			else removeMember(db, actor, realm.id, userId);
		});
		if (!isActionFailure(result) && userId === actor.id) redirect(303, '/');
		return result;
	},

	deleteRealm: async ({ locals, params }) => {
		const actor = signedIn(locals);
		const realm = realmFor(locals, params.key);
		const result = perform('deleteRealm', () => deleteRealm(getDb(), actor, realm.id));
		if (!isActionFailure(result)) redirect(303, '/');
		return result;
	}
};
