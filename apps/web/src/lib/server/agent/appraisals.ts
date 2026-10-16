import { and, desc, eq, lt } from 'drizzle-orm';
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
	stamp?: string;
};

export type AppraisalView = {
	labourId: number;
	brief: string;
	refs: Reference[];
	setBy: number | null;
	setAt: Date | null;
	contentHash: string;
	stamp: { contentHash: string; appraisedBy: number; appraisedAt: Date } | null;
	unappraised: boolean;
	stale: boolean;
	values: ValueView[];
	links: LinkView[];
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

function readRow(db: Handle, labourId: number): AppraisalRow | undefined {
	return db.select().from(appraisals).where(eq(appraisals.labourId, labourId)).get();
}

export function readAppraisal(db: Handle, labourId: number): AppraisalView {
	getLabour(db, labourId);
	const row = readRow(db, labourId);
	const hash = contentHash(db, labourId);
	const stamp =
		row?.contentHash == null
			? null
			: {
					contentHash: row.contentHash,
					appraisedBy: row.appraisedBy!,
					appraisedAt: row.appraisedAt!
				};
	return {
		labourId,
		brief: row?.brief ?? '',
		refs: (row?.refs ?? []) as Reference[],
		setBy: row?.setBy ?? null,
		setAt: row?.setAt ?? null,
		contentHash: hash,
		stamp,
		unappraised: stamp === null,
		stale: stamp !== null && stamp.contentHash !== hash,
		values: readValues(db, labourId),
		links: readLinks(db, labourId),
		mentions: readMentions(db, labourId)
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
function writeAppraisal(
	tx: Handle,
	userId: number,
	labourId: number,
	patch: { brief?: string; refs?: Reference[] },
	now: Date
): void {
	const set = { ...patch, setBy: userId, setAt: now };
	tx.insert(appraisals)
		.values({ labourId, ...set })
		.onConflictDoUpdate({ target: appraisals.labourId, set })
		.run();
	if (patch.brief !== undefined) refreshLabourText(tx, labourId);
}

function writeStamp(tx: Handle, userId: number, labourId: number, hash: string, now: Date): void {
	const set = { contentHash: hash, appraisedBy: userId, appraisedAt: now };
	tx.insert(appraisals)
		.values({ labourId, ...set })
		.onConflictDoUpdate({ target: appraisals.labourId, set })
		.run();
}

function applyLinks(
	tx: Handle,
	userId: number,
	labourId: number,
	inputs: LinkInput[],
	now: Date
): void {
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
		getLabour(tx, other);
		writeLink(
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

function applyItem(
	tx: Handle,
	userId: number,
	item: AppraiseItem,
	now: Date,
	touched: Set<number>
): boolean {
	const labour = getLabour(tx, item.labourId);

	const patch: { brief?: string; refs?: Reference[] } = {};
	if (item.brief !== undefined) patch.brief = normalizeBrief(item.brief);
	if (item.refs !== undefined) patch.refs = normalizeRefs(item.refs);
	if (patch.brief !== undefined || patch.refs !== undefined) {
		writeAppraisal(tx, userId, labour.id, patch, now);
	}

	if (item.values !== undefined) writeValues(tx, userId, labour, item.values, now, touched);
	if (item.links !== undefined) applyLinks(tx, userId, labour.id, item.links, now);

	if (item.stamp === undefined) return false;
	if (typeof item.stamp !== 'string') invalid('Stamp must be a content hash');
	const hash = contentHash(tx, labour.id);
	if (item.stamp !== hash) return false;
	writeStamp(tx, userId, labour.id, hash, now);
	return true;
}

export function appraise(
	db: Db,
	actor: Actor,
	items: AppraiseItem[],
	now: Date = new Date()
): { labourId: number; stamped: boolean }[] {
	if (!Array.isArray(items) || items.length < 1 || items.length > BATCH_MAX) {
		invalid(`Appraise takes 1 to ${BATCH_MAX} items`);
	}
	return db.transaction((tx) => {
		const seen = new Set<number>();
		for (const item of items) {
			if (seen.has(item.labourId)) invalid(`${labourName(tx)(item.labourId)} is listed twice`);
			seen.add(item.labourId);
		}
		const touched = new Set<number>();
		const results = items.map((item) => ({
			labourId: item.labourId,
			stamped: applyItem(tx, actor.id, item, now, touched)
		}));
		bumpRealms(tx, touched, now);
		return results;
	});
}

export type UnappraisedFilter = { realmId?: number; includeClosed?: boolean };

export function listUnappraised(
	db: Handle,
	filter: UnappraisedFilter,
	page: { offset: number; limit: number }
): { items: { labourId: number; reason: UnappraisedReason }[]; total: number } {
	const where = [];
	if (filter.realmId !== undefined) where.push(eq(labours.realmId, filter.realmId));
	if (filter.includeClosed !== true) where.push(eq(states.isClosed, false));

	const candidates = db
		.select({ id: labours.id, stamped: appraisals.contentHash })
		.from(labours)
		.innerJoin(states, eq(states.id, labours.stateId))
		.leftJoin(appraisals, eq(appraisals.labourId, labours.id))
		.where(and(...where))
		.orderBy(desc(labours.id))
		.all();

	const staleValues = new Set(
		db
			.selectDistinct({ labourId: labourAttributes.labourId })
			.from(labourAttributes)
			.innerJoin(attributes, eq(attributes.id, labourAttributes.attributeId))
			.where(lt(labourAttributes.setAt, attributes.revisedAt))
			.all()
			.map((row) => row.labourId)
	);

	const groups: Record<UnappraisedReason, number[]> = { unappraised: [], content: [], values: [] };
	for (const { id, stamped } of candidates) {
		if (stamped === null) groups.unappraised.push(id);
		else if (stamped !== contentHash(db, id)) groups.content.push(id);
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
