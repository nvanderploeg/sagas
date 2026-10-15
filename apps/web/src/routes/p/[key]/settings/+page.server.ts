import { error, isActionFailure, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import {
	deleteProject,
	readProject,
	renameProjectKey,
	setInitialState,
	updateProject
} from '#lib/server/domain/projects.ts';
import {
	createState,
	createSubstate,
	deleteState,
	deleteSubstate,
	moveState,
	moveSubstate,
	setDefaultSubstate,
	updateState,
	updateSubstate,
	type StyleUpdate
} from '#lib/server/domain/states.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import { findProjectByKey, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

function projectFor(key: string) {
	const project = findProjectByKey(getDb(), key);
	if (!project) error(404, 'No Project has that key');
	return project;
}

export const load: PageServerLoad = ({ params }) => {
	const project = projectFor(params.key);
	if (project.key !== params.key) redirect(307, `/p/${project.key}/settings`);
	try {
		const { seq, value } = readAtSeq(getDb(), (tx) => ({ project: readProject(tx, project.id) }));
		return { seq, settings: toJson(value) };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No Project has that key');
		throw e;
	}
};

// A State or Substate key from its label, unique among `taken`.
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
		const project = projectFor(params.key);
		return perform('rename', () => {
			updateProject(getDb(), actor, project.id, { name: text(form, 'name') });
		});
	},

	rekey: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const project = projectFor(params.key);
		const result = perform('rekey', () => {
			const renamed = renameProjectKey(getDb(), actor, project.id, text(form, 'key'));
			return { key: renamed.key };
		});
		if ('key' in result && result.key !== params.key) {
			redirect(303, `/p/${result.key}/settings`);
		}
		return result;
	},

	initial: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const project = projectFor(params.key);
		return perform('initial', () => {
			setInitialState(getDb(), actor, project.id, int(form, 'stateId'));
		});
	},

	addState: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const project = projectFor(params.key);
		return perform('addState', () => {
			const db = getDb();
			const taken = readProject(db, project.id).states.map((s) => s.key);
			createState(db, actor, project.id, newStyle(form, taken));
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
		const project = projectFor(params.key);
		return perform(`substates:${text(form, 'stateId')}`, () => {
			const id = int(form, 'stateId');
			const db = getDb();
			const state = readProject(db, project.id).states.find((s) => s.id === id);
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

	deleteProject: async ({ locals, params }) => {
		const actor = signedIn(locals);
		const project = projectFor(params.key);
		const result = perform('deleteProject', () => deleteProject(getDb(), actor, project.id));
		if (!isActionFailure(result)) redirect(303, '/');
		return result;
	}
};
