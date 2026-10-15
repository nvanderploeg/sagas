import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { addQuestTicket, removeQuestTicket } from '#lib/server/domain/quests.ts';
import {
	deleteTicket,
	moveTicket,
	resolveTicketKey,
	setParent,
	updateTicket,
	type TicketPatch
} from '#lib/server/domain/tickets.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { int, optionalInt, perform, signedIn, text } from '#lib/server/ui/form.ts';
import { readTicketPage, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const db = getDb();
	const found = resolveTicketKey(db, params.key);
	if (!found) error(404, 'No Ticket has that key');
	if (found.key !== params.key) redirect(307, `/t/${found.key}`);
	try {
		const { seq, value } = readAtSeq(db, (tx) => readTicketPage(tx, found.id));
		return { seq, page: toJson(value) };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No Ticket has that key');
		throw e;
	}
};

export const actions: Actions = {
	// Patches only the fields the form carries; an empty assignee or Substate clears it.
	update: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('update', () => {
			const patch: TicketPatch = {};
			if (form.has('title')) patch.title = text(form, 'title');
			if (form.has('description')) patch.description = text(form, 'description');
			if (form.has('ownerId')) patch.ownerId = int(form, 'ownerId');
			if (form.has('assigneeId')) patch.assigneeId = optionalInt(form, 'assigneeId');
			if (form.has('stateId')) patch.stateId = int(form, 'stateId');
			if (form.has('substateId')) patch.substateId = optionalInt(form, 'substateId');
			const ticket = updateTicket(getDb(), actor, int(form, 'ticketId'), patch);
			return { key: ticket.key };
		});
	},

	parent: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('parent', () => {
			setParent(getDb(), actor, int(form, 'ticketId'), optionalInt(form, 'parentId'));
		});
	},

	move: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('move', () => {
			const ticket = moveTicket(getDb(), actor, int(form, 'ticketId'), {
				projectId: int(form, 'projectId'),
				stateId: optionalInt(form, 'stateId') ?? undefined,
				substateId: optionalInt(form, 'substateId')
			});
			return { key: ticket.key };
		});
	},

	addQuest: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('quests', () => {
			addQuestTicket(getDb(), actor, int(form, 'questId'), int(form, 'ticketId'));
		});
	},

	removeQuest: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('quests', () => {
			removeQuestTicket(getDb(), actor, int(form, 'questId'), int(form, 'ticketId'));
		});
	},

	delete: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const result = perform('delete', () => {
			const db = getDb();
			const page = readTicketPage(db, int(form, 'ticketId'));
			deleteTicket(db, actor, page.ticket.id);
			const project = page.projects.find((p) => p.id === page.ticket.projectId);
			return { board: project?.key ?? '' };
		});
		if ('board' in result) redirect(303, result.board ? `/p/${result.board}` : '/');
		return result;
	}
};
