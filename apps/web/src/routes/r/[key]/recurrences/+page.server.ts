import { error, redirect } from '@sveltejs/kit';
import { getDb } from '#lib/server/db/index.ts';
import { memberRole } from '#lib/server/domain/access.ts';
import { DomainError } from '#lib/server/domain/errors.ts';
import { readLabour } from '#lib/server/domain/labours.ts';
import { listQuests } from '#lib/server/domain/quests.ts';
import {
	createRecurrence,
	deleteRecurrence,
	listRecurrences,
	updateRecurrence
} from '#lib/server/domain/recurrences.ts';
import type { Unit } from '#lib/server/domain/schedule.ts';
import { checked, int, perform, signedIn, text } from '#lib/server/ui/form.ts';
import { findRealmByKey, toJson } from '#lib/server/ui/reads.ts';
import type { Actions, PageServerLoad } from './$types';

async function realmFor(locals: App.Locals, key: string) {
	const realm = await findRealmByKey(getDb(), key, signedIn(locals));
	if (!realm) error(404, 'No Realm has that key');
	return realm;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	const viewer = signedIn(locals);
	const realm = await realmFor(locals, params.key);
	if (realm.key !== params.key) redirect(307, `/r/${realm.key}/recurrences`);
	const db = getDb();
	const recurrences = await Promise.all(
		(await listRecurrences(db, realm.id)).map(async (recurrence) => ({
			...recurrence,
			labour: recurrence.labourId === null ? null : await labourSummary(recurrence.labourId)
		}))
	);
	const quests = (await listQuests(db))
		.filter((quest) => quest.realmId === realm.id)
		.map(({ id, name }) => ({ id, name }));
	return {
		realm: { id: realm.id, key: realm.key, name: realm.name },
		recurrences: toJson(recurrences),
		quests,
		canEdit: ['owner', 'editor'].includes((await memberRole(db, realm.id, viewer.id)) ?? '')
	};
};

async function labourSummary(id: number) {
	try {
		const { key, title, closed } = await readLabour(getDb(), id);
		return { key, title, closed };
	} catch (e) {
		if (e instanceof DomainError && e.code === 'not_found') return null;
		throw e;
	}
}

function unit(form: FormData): Unit {
	return text(form, 'unit') as Unit;
}

function every(form: FormData): number {
	return int(form, 'every');
}

function questIds(form: FormData): number[] {
	return form.getAll('questIds').map((value) => Number(value));
}

export const actions: Actions = {
	create: async ({ request, locals, params }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		const realm = await realmFor(locals, params.key);
		return perform('create', async () => {
			await createRecurrence(getDb(), actor, {
				realmId: realm.id,
				title: text(form, 'title'),
				description: text(form, 'description'),
				ownerId: actor.id,
				unit: unit(form),
				every: every(form),
				startsOn: text(form, 'startsOn') || undefined,
				timezone: text(form, 'timezone') || undefined,
				questIds: questIds(form)
			});
		});
	},

	update: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('update', async () => {
			await updateRecurrence(getDb(), actor, int(form, 'id'), {
				title: text(form, 'title'),
				description: text(form, 'description'),
				unit: unit(form),
				every: every(form),
				startsOn: text(form, 'startsOn'),
				timezone: text(form, 'timezone'),
				questIds: questIds(form),
				paused: checked(form, 'paused')
			});
		});
	},

	delete: async ({ request, locals }) => {
		const actor = signedIn(locals);
		const form = await request.formData();
		return perform('delete', async () => {
			await deleteRecurrence(getDb(), actor, int(form, 'id'));
		});
	}
};
