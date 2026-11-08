import { z } from 'zod';
import type { AuthUser } from '../auth/users.ts';
import type { Credential } from '../auth/credentials.ts';
import { unauthorizedResponse } from '../auth/access.ts';
import type { Db } from '../db/client.ts';
import { canSeeLabour, visibleRealmIds } from '../domain/access.ts';
import { addComment, listComments } from '../domain/comments.ts';
import { DomainError, type DomainErrorCode } from '../domain/errors.ts';
import { queryLabours } from '../domain/labour-query.ts';
import { readLabour, updateLabour } from '../domain/labours.ts';
import { getLabour } from '../domain/lookup.ts';
import { listRealms } from '../domain/realms.ts';
import { readLinks } from '../agent/links.ts';
import { Presenter } from '../mcp/present.ts';
import * as refs from '../mcp/refs.ts';
import { filterAsync } from '#lib/server/async.ts';

export type RestAuth = { user: AuthUser; credential: Credential };

export type RestRequest = {
	method: string;
	origin: string;
	segments: string[];
	query: URLSearchParams;
	body: () => Promise<unknown>;
};

const STATUS: Record<DomainErrorCode, number> = {
	invalid: 400,
	not_found: 404,
	forbidden: 403,
	conflict: 409
};

const fail = (status: number, error: string) => Response.json({ error }, { status });

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const refText = z.string().trim().min(1);

const patchBody = z.strictObject({
	title: z.string().optional(),
	description: z.string().optional(),
	assignee: refText.nullable().optional(),
	state: refText.optional(),
	substate: refText.nullable().optional(),
	labels: z.array(z.string()).optional()
});

const commentBody = z.strictObject({ body: z.string() });

async function parse<S extends z.ZodType>(schema: S, req: RestRequest): Promise<z.output<S>> {
	let raw: unknown;
	try {
		raw = await req.body();
	} catch {
		throw new DomainError('invalid', 'Body must be JSON');
	}
	const parsed = schema.safeParse(raw);
	if (parsed.success) return parsed.data;
	const problems = parsed.error.issues.map((issue) => {
		if (issue.code === 'unrecognized_keys') {
			return `unknown field ${issue.keys.map((key) => `"${key}"`).join(', ')}`;
		}
		const at = issue.path.join('.');
		return at === '' ? issue.message : `${at}: ${issue.message}`;
	});
	throw new DomainError('invalid', problems.join('; '));
}

// A reference inside a request body that names nothing is a bad request, not a missing route.
async function inBody<T>(resolve: () => T | Promise<T>): Promise<T> {
	try {
		return await resolve();
	} catch (error) {
		if (error instanceof DomainError && error.code === 'not_found') {
			throw new DomainError('invalid', error.message);
		}
		throw error;
	}
}

// A path or query reference that names nothing, or is not shaped like a key, is not found.
async function inPath<T>(resolve: () => T | Promise<T>): Promise<T> {
	try {
		return await resolve();
	} catch (error) {
		if (error instanceof DomainError && error.code === 'invalid') {
			throw new DomainError('not_found', 'Not found');
		}
		throw error;
	}
}

async function realmJson(present: Presenter, realmId: number) {
	const realm = await present.realm(realmId);
	return {
		id: realm.id,
		key: realm.key,
		name: realm.name,
		url: realm.url,
		states: realm.states.map((state, order) => ({
			id: state.id,
			key: state.key,
			label: state.label,
			order,
			closed: state.closed,
			substates: state.substates.map(({ id, key, label }) => ({ id, key, label }))
		}))
	};
}

async function labourJson(present: Presenter, view: Awaited<ReturnType<typeof readLabour>>) {
	const summary = await present.labour(view);
	return {
		id: summary.id,
		key: summary.key,
		url: summary.url,
		realm: summary.realm,
		title: summary.title,
		state: summary.state.key,
		substate: summary.substate?.key ?? null,
		closed: summary.closed,
		owner: summary.owner,
		assignee: summary.assignee,
		parent: summary.parent,
		labels: summary.labels,
		brief: summary.brief,
		rank: view.rank,
		updatedAt: view.updatedAt.toISOString()
	};
}

async function labourDetailJson(db: Db, user: AuthUser, present: Presenter, labourId: number) {
	const view = await readLabour(db, labourId);
	const detail = await present.detail(view);
	const links = await Promise.all(
		(
			await filterAsync(
				await readLinks(db, labourId),
				async (link) =>
					(await canSeeLabour(db, user, link.from)) && (await canSeeLabour(db, user, link.to))
			)
		).map(async (link) => ({
			type: link.type,
			from: await refs.labourKey(db, link.from),
			to: await refs.labourKey(db, link.to),
			note: link.note
		}))
	);
	return {
		...(await labourJson(present, view)),
		description: detail.description,
		aliases: detail.aliases,
		createdAt: detail.createdAt,
		links,
		children: detail.children.map((child) => child.key)
	};
}

function pageParams(query: URLSearchParams): { limit: number; offset: number } {
	const rawLimit = query.get('limit');
	const limit = rawLimit === null ? DEFAULT_LIMIT : Number(rawLimit);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		throw new DomainError('invalid', `limit must be an integer from 1 to ${MAX_LIMIT}`);
	}
	const rawCursor = query.get('cursor');
	if (rawCursor === null) return { limit, offset: 0 };
	if (!/^\d{1,12}$/.test(rawCursor)) throw new DomainError('invalid', 'cursor is not valid');
	return { limit, offset: Number(rawCursor) };
}

async function listLabours(db: Db, user: AuthUser, present: Presenter, query: URLSearchParams) {
	const page = pageParams(query);
	const realm = query.get('realm');
	const realmId = realm === null ? undefined : await inPath(() => refs.realmId(db, realm, user));
	const state = query.get('state');
	if (state !== null && realmId === undefined) {
		throw new DomainError('invalid', 'state needs realm');
	}
	const stateId = state === null ? undefined : await inPath(() => refs.stateId(db, realmId, state));
	const parent = query.get('parent');
	const result = await queryLabours(
		db,
		{
			realms: (await visibleRealmIds(db, user)) ?? undefined,
			realmId,
			stateId,
			parentId: parent === null ? undefined : await inPath(() => refs.labourId(db, parent, user))
		},
		page
	);
	const end = page.offset + result.labours.length;
	return {
		labours: await Promise.all(result.labours.map((view) => labourJson(present, view))),
		total: result.total,
		nextCursor: end < result.total ? String(end) : null
	};
}

async function patchLabour(
	db: Db,
	user: AuthUser,
	present: Presenter,
	id: number,
	req: RestRequest
) {
	const body = await parse(patchBody, req);
	const current = await getLabour(db, id);
	const stateId =
		body.state === undefined
			? undefined
			: await inBody(() => refs.stateId(db, current.realmId, body.state!));
	await updateLabour(db, user, id, {
		title: body.title,
		description: body.description,
		assigneeId:
			body.assignee == null
				? (body.assignee as null | undefined)
				: await inBody(() => refs.userId(db, body.assignee!, user)),
		stateId,
		substateId:
			body.substate == null
				? (body.substate as null | undefined)
				: await inBody(() => refs.substateId(db, stateId ?? current.stateId, body.substate!)),
		labels: body.labels
	});
	return labourDetailJson(db, user, present, id);
}

async function route(db: Db, auth: RestAuth, req: RestRequest): Promise<Response> {
	const { user } = auth;
	const present = new Presenter(db, req.origin, user);
	const [resource, key, sub, ...extra] = req.segments;
	const ok = (data: unknown, status = 200) => Response.json(data, { status });
	const methodNotAllowed = () => fail(405, 'method not allowed');
	if (extra.length > 0) throw new DomainError('not_found', 'Not found');

	if (resource === 'realms' && sub === undefined) {
		if (req.method !== 'GET') return methodNotAllowed();
		if (key === undefined) {
			const visible = await visibleRealmIds(db, user);
			return ok({
				realms: await Promise.all(
					(await listRealms(db))
						.filter((realm) => visible === null || visible.includes(realm.id))
						.map((realm) => realmJson(present, realm.id))
				)
			});
		}
		return ok({
			realm: await realmJson(present, await inPath(() => refs.realmId(db, key, user)))
		});
	}

	if (resource === 'labours') {
		if (key === undefined) {
			if (req.method !== 'GET') return methodNotAllowed();
			return ok(await listLabours(db, user, present, req.query));
		}
		const id = await inPath(() => refs.labourId(db, key, user));
		if (sub === undefined) {
			if (req.method === 'GET')
				return ok({ labour: await labourDetailJson(db, user, present, id) });
			if (req.method === 'PATCH') {
				return ok({ labour: await patchLabour(db, user, present, id, req) });
			}
			return methodNotAllowed();
		}
		if (sub === 'comments') {
			if (req.method === 'GET') {
				return ok({
					comments: await Promise.all((await listComments(db, id)).map((c) => present.comment(c)))
				});
			}
			if (req.method === 'POST') {
				const { body } = await parse(commentBody, req);
				return ok({ comment: await present.comment(await addComment(db, user, id, body)) }, 201);
			}
			return methodNotAllowed();
		}
	}
	throw new DomainError('not_found', 'Not found');
}

const READS = new Set(['GET']);

export async function handleRest(
	db: Db,
	auth: RestAuth | null,
	req: RestRequest
): Promise<Response> {
	if (!auth) return unauthorizedResponse();
	if (!READS.has(req.method) && auth.credential.kind !== 'api_token') {
		return fail(403, 'writes need Authorization: Bearer <API token>');
	}
	try {
		return await route(db, auth, req);
	} catch (error) {
		if (error instanceof DomainError) return fail(STATUS[error.code], error.message);
		console.error('sagas REST request failed', error);
		return fail(500, 'internal error');
	}
}
