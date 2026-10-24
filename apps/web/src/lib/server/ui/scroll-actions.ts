import { error, isActionFailure, redirect, type RequestEvent } from '@sveltejs/kit';
import { getDb } from '../db/index.ts';
import { DomainError } from '../domain/errors.ts';
import {
	createScroll,
	deleteScroll,
	getScroll,
	moveScroll,
	updateScroll,
	type ChildChoice,
	type ScrollPatch
} from '../domain/scrolls.ts';
import { int, optionalInt, perform, placement, signedIn, text } from './form.ts';
import { findRealmByKey } from './reads.ts';

const CHOICE = /^choice-(\d+)$/;

function realmFor(event: RequestEvent) {
	const realm = findRealmByKey(getDb(), event.params.key ?? '', signedIn(event.locals));
	if (!realm) error(404, 'No Realm has that key');
	return realm;
}

function scrollIn(realmId: number, form: FormData): number {
	const id = int(form, 'scrollId');
	if (getScroll(getDb(), id).realmId !== realmId)
		throw new DomainError('not_found', 'Scroll not found');
	return id;
}

const pageOf = (key: string, path: string | null) =>
	path === null ? `/r/${key}/s` : `/r/${key}/s/${path}`;

export const scrollActions = {
	create: async (event: RequestEvent) => {
		const actor = signedIn(event.locals);
		const form = await event.request.formData();
		const realm = realmFor(event);
		let path = '';
		const result = perform('create', () => {
			path = createScroll(getDb(), actor, {
				realmId: realm.id,
				title: text(form, 'title'),
				slug: text(form, 'slug').trim() || undefined,
				parentId: optionalInt(form, 'parentId')
			}).path;
		});
		if (isActionFailure(result)) return result;
		redirect(303, `${pageOf(realm.key, path)}?edit`);
	},

	update: async (event: RequestEvent) => {
		const actor = signedIn(event.locals);
		const form = await event.request.formData();
		const realm = realmFor(event);
		return perform('update', () => {
			const patch: ScrollPatch = {};
			if (form.has('title')) patch.title = text(form, 'title');
			if (form.has('slug')) patch.slug = text(form, 'slug');
			if (form.has('body')) patch.body = text(form, 'body');
			if (form.has('version')) patch.version = int(form, 'version');
			const scroll = updateScroll(getDb(), actor, scrollIn(realm.id, form), patch);
			return { path: scroll.path, version: scroll.version };
		});
	},

	move: async (event: RequestEvent) => {
		const actor = signedIn(event.locals);
		const form = await event.request.formData();
		const realm = realmFor(event);
		return perform('move', () => {
			const scroll = moveScroll(getDb(), actor, scrollIn(realm.id, form), {
				parentId: form.has('parentId') ? optionalInt(form, 'parentId') : undefined,
				placement: form.has('placement') ? placement(form) : undefined
			});
			return { path: scroll.path };
		});
	},

	rank: async (event: RequestEvent) => {
		const actor = signedIn(event.locals);
		const form = await event.request.formData();
		const realm = realmFor(event);
		return perform('rank', () => {
			moveScroll(getDb(), actor, scrollIn(realm.id, form), { placement: placement(form) });
		});
	},

	// `choice-<child id>` is `move` or `delete` for each direct child.
	delete: async (event: RequestEvent) => {
		const actor = signedIn(event.locals);
		const form = await event.request.formData();
		const realm = realmFor(event);
		let parentPath: string | null = null;
		const result = perform('delete', () => {
			const db = getDb();
			const id = scrollIn(realm.id, form);
			const parentId = getScroll(db, id).parentId;
			const choices = new Map<number, ChildChoice>();
			for (const [name, value] of form) {
				const match = CHOICE.exec(name);
				if (!match) continue;
				if (value !== 'move' && value !== 'delete') {
					throw new DomainError('invalid', `${name} must be move or delete`);
				}
				choices.set(Number(match[1]), value);
			}
			deleteScroll(db, actor, id, choices);
			parentPath = parentId === null ? null : getScroll(db, parentId).path;
		});
		if (isActionFailure(result)) return result;
		redirect(303, pageOf(realm.key, parentPath));
	}
};
