import { requireRealmRole } from '../domain/access.ts';
import { currentVia } from '#lib/server/auth/via.ts';
import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import type { Db, Handle } from '../db/client.ts';
import { appraisals, attributes, labourAttributes, labours, states } from '../db/schema.ts';
import { DomainError } from '../domain/errors.ts';
import { labourName } from '../domain/labour-view.ts';
import { getLabour } from '../domain/lookup.ts';
import type { Actor } from '../domain/write.ts';
import { bumpRealms, readValues, writeValues, type ValueView } from './attributes.ts';
import { contentHash } from './content.ts';
import {
	LINK_NOTE_MAX,
	LINK_TYPES,
	readLinks,
	writeLink,
	type LinkType,
	type LinkView
} from './links.ts';
import { readMentions, type MentionView } from './mentions.ts';
import { refreshLabourText } from './search.ts';
import { embeddingTextChanged } from './vectors/hook.ts';
import { refreshEmbeddingInput } from './vectors/input.ts';
import { readNeeds, writeNeeds, type NeedView } from './skills.ts';
import { transact } from '#lib/server/db/tx.ts';

export type Reference = { href: string; label: string | null };

export type LinkInput = {
	type: LinkType;
	to?: number;
	from?: number;
	note?: string;
	remove?: boolean;
};

export type AppraiseItem = {
	labourId: number;
	brief?: string;
	refs?: { href: string; label?: string | null }[];
	values?: Record<string, unknown>;
	links?: LinkInput[];
	needs?: Record<string, number | null>;
	stamp?: string;
};

export type AppraisalView = {
	labourId: number;
	brief: string;
	refs: Reference[];
	setBy: number | null;
	via: string | null;
	setAt: Date | null;
	contentHash: string;
	stamp: {
		contentHash: string;
		appraisedBy: number;
		appraisedVia: string | null;
		appraisedAt: Date;
	} | null;
	unappraised: boolean;
	stale: boolean;
	values: ValueView[];
	links: LinkView[];
	needs: NeedView[];
	mentions: MentionView[];
};

export type UnappraisedReason = 'unappraised' | 'content' | 'values';

export const BATCH_MAX = 50;
export const BRIEF_MAX = 400;
export const REFS_MAX = 20;
export const HREF_MAX = 500;
export const REF_LABEL_MAX = 120;

type AppraisalRow = typeof appraisals.$inferSelect;

function invalid(message: string): never {
	throw new DomainError('invalid', message);
}

async function readRow(db: Handle, labourId: number): Promise<AppraisalRow | undefined> {
	return (await db.select().from(appraisals).where(eq(appraisals.labourId, labourId)).limit(1))[0];
}

export async function readAppraisal(db: Handle, labourId: number): Promise<AppraisalView> {
	await getLabour(db, labourId);
	const row = await readRow(db, labourId);
	const hash = await contentHash(db, labourId);
	const stamp =
		row?.contentHash == null
			? null
			: {
					contentHash: row.contentHash,
					appraisedBy: row.appraisedBy!,
					appraisedVia: row.appraisedVia,
					appraisedAt: row.appraisedAt!
				};
	return {
		labourId,
		brief: row?.brief ?? '',
		refs: (row?.refs ?? []) as Reference[],
		setBy: row?.setBy ?? null,
		via: row?.via ?? null,
		setAt: row?.setAt ?? null,
		contentHash: hash,
		stamp,
		unappraised: stamp === null,
		stale: stamp !== null && stamp.contentHash !== hash,
		values: await readValues(db, labourId),
		links: await readLinks(db, labourId),
		needs: await readNeeds(db, labourId),
		mentions: await readMentions(db, labourId)
	};
}

function normalizeBrief(brief: unknown): string {
	if (typeof brief !== 'string') invalid('Brief must be text');
	const text = brief.trim();
	if (text.length > BRIEF_MAX) invalid(`Brief must be at most ${BRIEF_MAX} characters`);
	return text;
}

function normalizeRefs(refs: unknown): Reference[] {
	if (!Array.isArray(refs)) invalid('References must be an array');
	if (refs.length > REFS_MAX) invalid(`A Labour holds at most ${REFS_MAX} References`);
	const seen = new Set<string>();
	return refs.map((ref: { href?: unknown; label?: unknown } | null) => {
		if (ref === null || typeof ref !== 'object' || typeof ref.href !== 'string') {
			invalid('Each Reference needs an href');
		}
		const href = ref.href.trim();
		if (href.length < 1 || href.length > HREF_MAX) {
			invalid(`A Reference href must be 1 to ${HREF_MAX} characters`);
		}
		if (seen.has(href)) invalid(`Reference "${href}" is listed twice`);
		seen.add(href);
		if (ref.label != null && typeof ref.label !== 'string')
			invalid('A Reference label must be text');
		const label = ref.label?.trim() ?? '';
		if (label.length > REF_LABEL_MAX) {
			invalid(`A Reference label must be at most ${REF_LABEL_MAX} characters`);
		}
		return { href, label: label === '' ? null : label };
	});
}

// The one place a Brief or References are written.
async function writeAppraisal(
	tx: Handle,
	userId: number,
	labourId: number,
	patch: { brief?: string; refs?: Reference[] },
	now: Date,
	rebriefed: Set<number>
): Promise<void> {
	const before = (await readRow(tx, labourId))?.brief ?? '';
	const set = { ...patch, setBy: userId, via: currentVia(), setAt: now };
	await tx
		.insert(appraisals)
		.values({ labourId, ...set })
		.onConflictDoUpdate({ target: appraisals.labourId, set });
	if (patch.brief === undefined) return;
	await refreshLabourText(tx, labourId);
	await refreshEmbeddingInput(tx, labourId);
	if (patch.brief !== before) rebriefed.add(labourId);
}

async function writeStamp(
	tx: Handle,
	userId: number,
	labourId: number,
	hash: string,
	now: Date
): Promise<void> {
	const set = {
		contentHash: hash,
		appraisedBy: userId,
		appraisedAt: now,
		appraisedVia: currentVia()
	};
	await tx
		.insert(appraisals)
		.values({ labourId, ...set })
		.onConflictDoUpdate({ target: appraisals.labourId, set });
}

async function applyLinks(
	tx: Handle,
	userId: number,
	labourId: number,
	inputs: LinkInput[],
	now: Date
): Promise<void> {
	if (!Array.isArray(inputs)) invalid('Links must be an array');
	for (const input of inputs) {
		if (input === null || typeof input !== 'object' || !LINK_TYPES.includes(input.type)) {
			invalid(`A Link type must be one of ${LINK_TYPES.join(', ')}`);
		}
		if ((input.to === undefined) === (input.from === undefined)) {
			invalid('A Link names its other end with exactly one of to and from');
		}
		let note: string | undefined;
		if (input.note !== undefined) {
			if (typeof input.note !== 'string') invalid('A Link note must be text');
			note = input.note.trim();
			if (note.length > LINK_NOTE_MAX) {
				invalid(`A Link note must be at most ${LINK_NOTE_MAX} characters`);
			}
		}
		const other = (input.to ?? input.from)!;
		if (other === labourId) invalid('A Labour cannot be linked to itself');
		await requireRealmRole(tx, { id: userId }, (await getLabour(tx, other)).realmId, 'viewer');
		await writeLink(
			tx,
			userId,
			{
				type: input.type,
				from: input.to === undefined ? other : labourId,
				to: input.to === undefined ? labourId : other,
				note,
				remove: input.remove === true
			},
			now
		);
	}
}

async function applyItem(
	tx: Handle,
	userId: number,
	item: AppraiseItem,
	now: Date,
	touched: Set<number>,
	rebriefed: Set<number>
): Promise<boolean> {
	const labour = await getLabour(tx, item.labourId);

	const patch: { brief?: string; refs?: Reference[] } = {};
	if (item.brief !== undefined) patch.brief = normalizeBrief(item.brief);
	if (item.refs !== undefined) patch.refs = normalizeRefs(item.refs);
	if (patch.brief !== undefined || patch.refs !== undefined) {
		await writeAppraisal(tx, userId, labour.id, patch, now, rebriefed);
	}

	if (item.values !== undefined) await writeValues(tx, userId, labour, item.values, now, touched);
	if (item.links !== undefined) await applyLinks(tx, userId, labour.id, item.links, now);
	if (item.needs !== undefined) await writeNeeds(tx, userId, labour.id, item.needs, now);

	if (item.stamp === undefined) return false;
	if (typeof item.stamp !== 'string') invalid('Stamp must be a content hash');
	const hash = await contentHash(tx, labour.id);
	if (item.stamp !== hash) return false;
	await writeStamp(tx, userId, labour.id, hash, now);
	return true;
}

export async function appraise(
	db: Db,
	actor: Actor,
	items: AppraiseItem[],
	now: Date = new Date()
): Promise<{ labourId: number; stamped: boolean }[]> {
	if (!Array.isArray(items) || items.length < 1 || items.length > BATCH_MAX) {
		invalid(`Appraise takes 1 to ${BATCH_MAX} items`);
	}
	const rebriefed = new Set<number>();
	const results = await transact(db, async (tx) => {
		const seen = new Set<number>();
		for (const item of items) {
			if (seen.has(item.labourId))
				invalid(`${await labourName(tx)(item.labourId)} is listed twice`);
			seen.add(item.labourId);
		}
		const touched = new Set<number>();
		for (const item of items) {
			await requireRealmRole(tx, actor, (await getLabour(tx, item.labourId)).realmId, 'editor');
		}
		const results: { labourId: number; stamped: boolean }[] = [];
		for (const item of items) {
			results.push({
				labourId: item.labourId,
				stamped: await applyItem(tx, actor.id, item, now, touched, rebriefed)
			});
		}
		await bumpRealms(tx, touched, now);
		return results;
	});
	for (const labourId of rebriefed) embeddingTextChanged(labourId);
	return results;
}

export type UnappraisedFilter = { realms?: number[]; realmId?: number; includeClosed?: boolean };

export async function listUnappraised(
	db: Handle,
	filter: UnappraisedFilter,
	page: { offset: number; limit: number }
): Promise<{ items: { labourId: number; reason: UnappraisedReason }[]; total: number }> {
	const where = [];
	if (filter.realms !== undefined) where.push(inArray(labours.realmId, filter.realms));
	if (filter.realmId !== undefined) where.push(eq(labours.realmId, filter.realmId));
	if (filter.includeClosed !== true) where.push(eq(states.isClosed, false));

	const candidates = await db
		.select({ id: labours.id, stamped: appraisals.contentHash })
		.from(labours)
		.innerJoin(states, eq(states.id, labours.stateId))
		.leftJoin(appraisals, eq(appraisals.labourId, labours.id))
		.where(and(...where))
		.orderBy(desc(labours.id));

	const staleValues = new Set(
		(
			await db
				.selectDistinct({ labourId: labourAttributes.labourId })
				.from(labourAttributes)
				.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
				.where(lt(labourAttributes.setAt, attributes.revisedAt))
		).map((row) => row.labourId)
	);

	const groups: Record<UnappraisedReason, number[]> = { unappraised: [], content: [], values: [] };
	for (const { id, stamped } of candidates) {
		if (stamped === null) groups.unappraised.push(id);
		else if (stamped !== (await contentHash(db, id))) groups.content.push(id);
		else if (staleValues.has(id)) groups.values.push(id);
	}

	const listed = (['unappraised', 'content', 'values'] as const).flatMap((reason) =>
		groups[reason].map((labourId) => ({ labourId, reason }))
	);
	return {
		items: listed.slice(page.offset, page.offset + page.limit),
		total: listed.length
	};
}
