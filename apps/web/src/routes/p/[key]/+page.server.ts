import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { readBoard } from '#lib/server/domain/projects.ts';
import { createTicket, rankTicket, readTicket, updateTicket } from '#lib/server/domain/tickets.ts';
import { readAtSeq } from '#lib/server/events/log.ts';
import { int, perform, placement, signedIn, text } from '#lib/server/ui/form.ts';
import { findProjectByKey, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

function projectFor(key: string) {
	const project = findProjectByKey(getDb(), key);
	if (!project) error(404, 'No Project has that key');
	return project;
}

export const load: PageServerLoad = ({ params }) => {
	const project = projectFor(params.key);
	if (project.key !== params.key) redirect(307, `/p/${project.key}`);
	try {
		const { seq, value } = readAtSeq(getDb(), (tx) => readBoard(tx, project.id));
		return { seq, board: toJson(value) };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') error(404, 'No Project has that key');
		throw e;
	}
};

export const actions: Actions = {
	create: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const project = projectFor(params.key);
		return perform('create', () => {
			const ticket = createTicket(getDb(), actor, {
				projectId: project.id,
				title: text(form, 'title'),
				ownerId: actor.id,
				stateId: int(form, 'stateId'),
				placement: 'bottom'
			});
			return { id: ticket.id, key: ticket.key };
		});
	},

	// A new State moves the Ticket there; the same State only ranks it.
	move: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const db = getDb();
		return perform('move', () => {
			const id = int(form, 'ticketId');
			const stateId = int(form, 'stateId');
			const where = placement(form);
			if (readTicket(db, id).stateId === stateId) rankTicket(db, actor, id, where);
			else updateTicket(db, actor, id, { stateId, placement: where });
		});
	}
};
