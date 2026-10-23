import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { addComment, deleteComment, editComment } from '#lib/server/domain/comments.ts';
import { addQuestLabour, removeQuestLabour } from '#lib/server/domain/quests.ts';
import {
	deleteLabour,
	moveLabour,
	resolveLabourKey,
	setParent,
	updateLabour,
	type LabourPatch
} from '#lib/server/domain/labours.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { int, optionalInt, perform, signedIn, text } from '#lib/server/ui/form.ts';
import { canSeeRealm } from '#lib/server/domain/access.ts';
import { readLabourPage, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, locals }) => {
	const viewer = signedIn(locals);
	const db = getDb();
	const found = resolveLabourKey(db, params.key);
	if (!found || !canSeeRealm(db, viewer, found.realmId)) error(404, 'No Labour has that key');
	if (found.key !== params.key) redirect(307, `/l/${found.key}`);
	try {
		const { seq, value } = readAtSeq(db, (tx) => readLabourPage(tx, viewer, found.id));
		return { seq, page: toJson(value) };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No Labour has that key');
		throw e;
	}
};

// A comma- or space-separated field, so a form with no JavaScript can carry the set.
function labels(form: FormData): string[] {
	return text(form, 'labels')
		.split(/[\s,]+/)
		.filter((label) => label !== '');
}

export const actions: Actions = {
	// Patches only the fields the form carries; an empty assignee or Substate clears it.
	update: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('update', () => {
			const patch: LabourPatch = {};
			if (form.has('title')) patch.title = text(form, 'title');
			if (form.has('description')) patch.description = text(form, 'description');
			if (form.has('ownerId')) patch.ownerId = int(form, 'ownerId');
			if (form.has('assigneeId')) patch.assigneeId = optionalInt(form, 'assigneeId');
			if (form.has('stateId')) patch.stateId = int(form, 'stateId');
			if (form.has('labels')) patch.labels = labels(form);
			if (form.has('substateId')) patch.substateId = optionalInt(form, 'substateId');
			const labour = updateLabour(getDb(), actor, int(form, 'labourId'), patch);
			return { key: labour.key };
		});
	},

	comment: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('comment', () => {
			addComment(getDb(), actor, int(form, 'labourId'), text(form, 'body'));
		});
	},

	editComment: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('comment', () => {
			editComment(getDb(), actor, int(form, 'commentId'), text(form, 'body'));
		});
	},

	deleteComment: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('comment', () => {
			deleteComment(getDb(), actor, int(form, 'commentId'));
		});
	},

	parent: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('parent', () => {
			setParent(getDb(), actor, int(form, 'labourId'), optionalInt(form, 'parentId'));
		});
	},

	move: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('move', () => {
			const labour = moveLabour(getDb(), actor, int(form, 'labourId'), {
				realmId: int(form, 'realmId'),
				stateId: optionalInt(form, 'stateId') ?? undefined,
				substateId: optionalInt(form, 'substateId')
			});
			return { key: labour.key };
		});
	},

	addQuest: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('quests', () => {
			addQuestLabour(getDb(), actor, int(form, 'questId'), int(form, 'labourId'));
		});
	},

	removeQuest: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('quests', () => {
			removeQuestLabour(getDb(), actor, int(form, 'questId'), int(form, 'labourId'));
		});
	},

	delete: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const result = perform('delete', () => {
			const db = getDb();
			const page = readLabourPage(db, actor, int(form, 'labourId'));
			deleteLabour(db, actor, page.labour.id);
			const realm = page.realms.find((p) => p.id === page.labour.realmId);
			return { board: realm?.key ?? '' };
		});
		if ('board' in result) redirect(303, result.board ? `/r/${result.board}` : '/');
		return result;
	}
};
