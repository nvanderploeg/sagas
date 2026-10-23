import { canSeeLabour, requireRealmRole } from '../domain/access.ts';
import { eq, inArray } from 'drizzle-orm';
import type { Handle } from '../db/client.ts';
import { attributes, labours, realms } from '../db/schema.ts';
import { readAppraisal } from '../agent/appraisals.ts';
import {
	readAttributes,
	readRealmAgent,
	type AttributeKind,
	type Spec,
	type TagsSpec,
	type ValueView
} from '../agent/attributes.ts';
import { readAffinity, readSentiment } from '../agent/sentiment.ts';
import { listSkills, readUserSkills } from '../agent/skills.ts';
import { selectLabourViews, toLabourView } from '../domain/labour-view.ts';
import { getLabour, getRealm, getUser } from '../domain/lookup.ts';

export const LINKS_SHOWN = 50;
export const KEYS_SHOWN = 20;

type Value = number | string[] | string;
type LabourRef = { id: number; key: string; title: string };

export type LabourLayer = {
	brief: string;
	refs: { href: string; label: string | null }[];
	setBy: number | null;
	via: string | null;
	setAt: Date | null;
	stamp: { appraisedBy: number; appraisedVia: string | null; appraisedAt: Date } | null;
	unappraised: boolean;
	stale: boolean;
	values: {
		key: string;
		label: string;
		kind: AttributeKind;
		value: Value;
		display: string;
		setBy: number;
		via: string | null;
		setAt: Date;
		stale: boolean;
	}[];
	needs: {
		key: string;
		label: string;
		level: number;
		setBy: number;
		via: string | null;
		setAt: Date;
	}[];
	links: {
		type: string;
		direction: 'out' | 'in' | 'both';
		other: LabourRef;
		note: string;
		setBy: number;
		via: string | null;
		setAt: Date;
	}[];
	moreLinks: number;
	mentions: { source: LabourRef; commentId: number | null; authorId: number; firstSeenAt: Date }[];
};

export type RealmLayer = {
	notes: string;
	halfLifeDays: number;
	loudness: number;
	version: number;
	attributes: {
		key: string;
		label: string;
		kind: AttributeKind;
		rubric: string;
		spec: Spec;
		held: number;
		stale: number;
		counts: Record<string, number>;
	}[];
	sentiment: { key: string; label: string; volume: number; mood: number; v: number }[];
	moreSentiment: number;
	unfiled: { rawKey: string; volume: number; count: number }[];
	moreUnfiled: number;
};

export type UserLayer = {
	skills: { key: string; label: string; level: number }[];
	affinity: {
		realm: string;
		key: string;
		label: string;
		volume: number;
		mood: number;
		v: number;
	}[];
	moreAffinity: number;
};

type Labelled = { key: string; label: string; kind: AttributeKind; spec: Spec };

function displayOf(attribute: Labelled | undefined, value: Value): string {
	if (typeof value === 'string') return value;
	if (typeof value === 'number') {
		const max = attribute?.kind === 'scale' ? (attribute.spec as { max: number }).max : null;
		return max === null ? String(value) : `${value} / ${max}`;
	}
	const members = attribute?.kind === 'tags' ? (attribute.spec as TagsSpec).members : [];
	const labels = new Map(members.map((member) => [member.key, member.label]));
	return value.map((key) => labels.get(key) ?? key).join(', ');
}

// A Sentiment key is `attribute` or `attribute:member`; its label names both.
function keyLabel(attributesByKey: Map<string, Labelled>, key: string): string {
	const colon = key.indexOf(':');
	const attribute = attributesByKey.get(colon < 0 ? key : key.slice(0, colon));
	if (attribute === undefined) return key;
	if (colon < 0) return attribute.label;
	const member = key.slice(colon + 1);
	const found =
		attribute.kind === 'tags'
			? (attribute.spec as TagsSpec).members.find((candidate) => candidate.key === member)
			: undefined;
	return `${attribute.label}: ${found?.label ?? member}`;
}

function labourRefs(db: Handle, ids: number[]): Map<number, LabourRef> {
	if (ids.length === 0) return new Map();
	return new Map(
		selectLabourViews(db)
			.where(inArray(labours.id, ids))
			.all()
			.map(toLabourView)
			.map((view) => [view.id, { id: view.id, key: view.key, title: view.title }])
	);
}

export function readLabourLayer(db: Handle, viewer: { id: number }, labourId: number): LabourLayer {
	const labour = getLabour(db, labourId);
	requireRealmRole(db, viewer, labour.realmId, 'viewer');
	const appraisal = readAppraisal(db, labourId);
	const visibleLinks = appraisal.links.filter(
		(link) => canSeeLabour(db, viewer, link.from) && canSeeLabour(db, viewer, link.to)
	);
	const visibleMentions = appraisal.mentions.filter((mention) =>
		canSeeLabour(db, viewer, mention.sourceLabourId)
	);

	const realmAttributes = new Map<string, Labelled>(
		db
			.select({
				key: attributes.key,
				label: attributes.label,
				kind: attributes.kind,
				spec: attributes.spec
			})
			.from(attributes)
			.where(eq(attributes.realmId, labour.realmId))
			.all()
			.map((row) => [row.key, { ...row, spec: row.spec as Spec }])
	);
	const skillLabels = new Map(listSkills(db).map((skill) => [skill.key, skill.label]));

	const shownLinks = visibleLinks.slice(0, LINKS_SHOWN);
	const others = labourRefs(db, [
		...shownLinks.map((link) => (link.from === labourId ? link.to : link.from)),
		...visibleMentions.map((mention) => mention.sourceLabourId)
	]);
	const ref = (id: number): LabourRef => others.get(id) ?? { id, key: `Labour ${id}`, title: '' };

	return {
		brief: appraisal.brief,
		refs: appraisal.refs,
		setBy: appraisal.setBy,
		via: appraisal.via,
		setAt: appraisal.setAt,
		stamp:
			appraisal.stamp === null
				? null
				: {
						appraisedBy: appraisal.stamp.appraisedBy,
						appraisedVia: appraisal.stamp.appraisedVia,
						appraisedAt: appraisal.stamp.appraisedAt
					},
		unappraised: appraisal.unappraised,
		stale: appraisal.stale,
		values: appraisal.values.map((value: ValueView) => {
			const attribute = realmAttributes.get(value.key);
			return {
				key: value.key,
				label: attribute?.label ?? value.key,
				kind: value.kind,
				value: value.value,
				display: displayOf(attribute, value.value),
				setBy: value.setBy,
				via: value.via,
				setAt: value.setAt,
				stale: value.stale
			};
		}),
		needs: appraisal.needs.map((need) => ({
			key: need.key,
			label: skillLabels.get(need.key) ?? need.key,
			level: need.level,
			setBy: need.setBy,
			via: need.via,
			setAt: need.setAt
		})),
		links: shownLinks.map((link) => ({
			type: link.type,
			direction: link.type === 'relates' ? 'both' : link.from === labourId ? 'out' : 'in',
			other: ref(link.from === labourId ? link.to : link.from),
			note: link.note,
			setBy: link.setBy,
			via: link.via,
			setAt: link.setAt
		})),
		moreLinks: Math.max(0, visibleLinks.length - LINKS_SHOWN),
		mentions: visibleMentions.map((mention) => ({
			source: ref(mention.sourceLabourId),
			commentId: mention.commentId,
			authorId: mention.authorId,
			firstSeenAt: mention.firstSeenAt
		}))
	};
}

export function readRealmLayer(
	db: Handle,
	viewer: { id: number },
	realmId: number,
	now: Date = new Date()
): RealmLayer {
	getRealm(db, realmId);
	requireRealmRole(db, viewer, realmId, 'viewer');
	const agent = readRealmAgent(db, realmId);
	const held = readAttributes(db, realmId);
	const byKey = new Map<string, Labelled>(held.map((attribute) => [attribute.key, attribute]));
	const sentiment = readSentiment(db, realmId, { limit: 1, now });

	return {
		notes: agent.notes,
		halfLifeDays: agent.halfLifeDays,
		loudness: agent.loudness,
		version: agent.version,
		attributes: held.map((attribute) => ({
			key: attribute.key,
			label: attribute.label,
			kind: attribute.kind,
			rubric: attribute.rubric,
			spec: attribute.spec,
			held: attribute.held,
			stale: attribute.stale,
			counts: attribute.counts
		})),
		sentiment: sentiment.keys.slice(0, KEYS_SHOWN).map((entry) => ({
			key: entry.key,
			label: keyLabel(byKey, entry.key),
			volume: entry.volume,
			mood: entry.mood,
			v: entry.v
		})),
		moreSentiment: Math.max(0, sentiment.keys.length - KEYS_SHOWN),
		unfiled: sentiment.unfiled.slice(0, KEYS_SHOWN).map((entry) => ({
			rawKey: entry.rawKey,
			volume: entry.volume,
			count: entry.count
		})),
		moreUnfiled: Math.max(0, sentiment.unfiled.length - KEYS_SHOWN)
	};
}

export function readUserLayer(db: Handle, userId: number, now: Date = new Date()): UserLayer {
	getUser(db, userId);
	const levels = readUserSkills(db, userId);
	const skillLabels = new Map(listSkills(db).map((skill) => [skill.key, skill.label]));
	const affinity = readAffinity(db, userId, { limit: 1, now });
	const shown = affinity.keys.slice(0, KEYS_SHOWN);

	const realmIds = [...new Set(shown.map((entry) => entry.realmId))];
	const rows =
		realmIds.length === 0
			? []
			: db
					.select({
						realmId: attributes.realmId,
						realmKey: realms.key,
						key: attributes.key,
						label: attributes.label,
						kind: attributes.kind,
						spec: attributes.spec
					})
					.from(attributes)
					.innerJoin(realms, eq(realms.id, attributes.realmId))
					.where(inArray(attributes.realmId, realmIds))
					.all();
	const realmKeys = new Map(rows.map((row) => [row.realmId, row.realmKey]));
	const byRealm = new Map<number, Map<string, Labelled>>();
	for (const row of rows) {
		const group = byRealm.get(row.realmId) ?? new Map<string, Labelled>();
		group.set(row.key, { ...row, spec: row.spec as Spec });
		byRealm.set(row.realmId, group);
	}

	return {
		skills: Object.entries(levels).map(([key, level]) => ({
			key,
			label: skillLabels.get(key) ?? key,
			level
		})),
		affinity: shown.map((entry) => ({
			realm: realmKeys.get(entry.realmId) ?? '',
			key: entry.key,
			label: keyLabel(byRealm.get(entry.realmId) ?? new Map(), entry.key),
			volume: entry.volume,
			mood: entry.mood,
			v: entry.v
		})),
		moreAffinity: Math.max(0, affinity.keys.length - KEYS_SHOWN)
	};
}
