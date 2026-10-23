import { canSeeRealm } from '../../domain/access.ts';
import { inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
	AMOUNT_MAX,
	deletePulse,
	EVIDENCE_MAX,
	filePulses,
	LIMIT_DEFAULT,
	LIMIT_MAX,
	postPulses,
	PULSES_MAX,
	readAffinity,
	readSentiment,
	type Evidence,
	type PulseInput,
	type PulseView,
	type SentimentView
} from '../../agent/sentiment.ts';
import type { Handle } from '../../db/client.ts';
import { realms } from '../../db/schema.ts';
import { DomainError } from '../../domain/errors.ts';
import { getRealm } from '../../domain/lookup.ts';
import { count, type Presenter } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { labourRef, realmRef, userRef, type Tools } from '../tool.ts';

const evidenceShape = z.union([
	z.strictObject({
		href: z.string().describe('A URL or repository path, 1 to 500 characters'),
		label: z.string().nullable().optional().describe('Up to 120 characters')
	}),
	z.strictObject({ labour: labourRef })
]);

const pulseShape = z.strictObject({
	key: z
		.string()
		.describe(
			'A `scale` Attribute key (`impact`) or a `tags` member (`topic:boss-hp`), in the Realm or not; a key the Realm lacks is kept unfiled'
		),
	amount: z.number().describe(`How much was said, above 0 and at most ${AMOUNT_MAX}`),
	mood: z.number().describe('How people feel about it, from -1 (bad) to 1 (good)'),
	note: z.string().optional().describe('What you saw, up to 1,000 characters'),
	evidence: z
		.array(evidenceShape)
		.max(EVIDENCE_MAX)
		.optional()
		.describe(`Up to ${EVIDENCE_MAX} items: { href, label? } or { labour }`),
	half_life_days: z
		.number()
		.nullable()
		.optional()
		.describe(
			"Days for the Pulse's weight to halve, above 0 and at most 365; null never fades; the Realm's half-life by default"
		),
	ref: z
		.string()
		.optional()
		.describe(
			'Your own id for what you saw, up to 200 characters; your second Pulse with the same ref and key is skipped'
		)
});

// Relies on the domain dropping evidence that names a deleted Labour.
function evidenceDto(db: Handle) {
	const keys = new Map<number, string>();
	return (items: Evidence[]) =>
		items.map((item) => {
			if (!('labour' in item)) return item;
			if (!keys.has(item.labour)) keys.set(item.labour, refs.labourKey(db, item.labour));
			return { labour: keys.get(item.labour)! };
		});
}

export function pulseDto(db: Handle, present: Presenter) {
	const evidence = evidenceDto(db);
	return (pulse: PulseView) => ({
		id: pulse.id,
		note: pulse.note,
		evidence: evidence(pulse.evidence),
		author: present.username(pulse.authorId),
		createdAt: pulse.createdAt.toISOString()
	});
}

export function registerSentimentTools({ db, actor, define }: Tools): void {
	define(
		'pulse',
		{
			kind: 'write',
			description: `Report what an audience feels about a Realm's Attributes, in up to ${PULSES_MAX} Pulses in one all-or-nothing call. A Pulse has a key, an \`amount\` (how much was said) and a \`mood\`, with a note and evidence; its weight halves every half-life. A key the Realm lacks is kept unfiled until get_sentiment shows it and file_pulses files it. Give each Pulse a \`ref\` of your own (a message id, a Labour key) so a rescan of the same source counts nothing twice. Each result is \`filed\`, \`unfiled\` or \`skipped\` (a repeated ref, naming the earlier Pulse in \`id\`).`,
			input: {
				realm: realmRef,
				pulses: z.array(pulseShape).min(1).max(PULSES_MAX).describe(`1 to ${PULSES_MAX} Pulses`)
			}
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const items = args.pulses.map((item): PulseInput => ({
				key: item.key,
				amount: item.amount,
				mood: item.mood,
				note: item.note,
				evidence: item.evidence?.map((entry) =>
					'labour' in entry ? { labour: refs.labourId(db, entry.labour, actor) } : entry
				),
				halfLifeDays: item.half_life_days,
				ref: item.ref
			}));
			const results = postPulses(db, actor, realmId, items);
			const tally = (status: string) => results.filter((r) => r.status === status).length;
			return reply(
				{ pulses: results },
				`Posted ${count(results.length, 'Pulse')}: ${tally('filed')} filed, ${tally('unfiled')} unfiled, ${tally('skipped')} skipped`
			);
		}
	);

	define(
		'get_sentiment',
		{
			kind: 'read',
			description: `Get the Sentiment of a Realm, or the Affinity of a User: for each key with Pulses, its \`volume\` (the Pulses' summed weights), \`mood\` (their weighted mean, -1 to 1), \`v\` (volume against loudness, 0 to 1) and its heaviest Pulses (${LIMIT_DEFAULT} by default, up to ${LIMIT_MAX} with \`limit\`). Give exactly one of \`realm\` and \`user\`. A Realm's loudness is its setting; an Affinity's is 5, and its keys each name their Realm. A Realm's result also has \`unfiled\`, the keys Pulses were posted under that the Realm lacks, each with its volume, count and newest Pulse; a User's is always empty. \`asOf\` is the moment the weights are for.`,
			input: {
				realm: realmRef.optional().describe('The Realm whose Sentiment to read; not with `user`'),
				user: userRef.optional().describe('The User whose Affinity to read; not with `realm`'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(LIMIT_MAX)
					.optional()
					.describe(`Pulses to list for each key, 1 to ${LIMIT_MAX}; ${LIMIT_DEFAULT} by default`)
			}
		},
		(args, present) => {
			if ((args.realm === undefined) === (args.user === undefined)) {
				throw new DomainError('invalid', 'Give exactly one of realm and user');
			}
			const dto = pulseDto(db, present);
			const listed = (view: SentimentView, realmKey: (realmId: number) => string) => ({
				asOf: view.asOf.toISOString(),
				keys: view.keys.map((entry) => ({
					realm: realmKey(entry.realmId),
					key: entry.key,
					volume: entry.volume,
					mood: entry.mood,
					v: entry.v,
					pulses: entry.pulses.map((pulse) => ({ ...dto(pulse), weight: pulse.weight }))
				})),
				unfiled: view.unfiled
			});

			if (args.realm !== undefined) {
				const realmId = refs.realmId(db, args.realm, actor);
				const view = readSentiment(db, realmId, { limit: args.limit });
				const realm = getRealm(db, realmId).key;
				const data = listed(view, () => realm);
				return reply(
					data,
					`${realm}: ${count(data.keys.length, 'key')} with Pulses, ${data.unfiled.length} unfiled`
				);
			}
			const userId = refs.userId(db, args.user!, actor);
			const affinity = readAffinity(db, userId, { limit: args.limit });
			// Another User's Affinity names only Realms you can see.
			const view = {
				...affinity,
				keys: affinity.keys.filter((entry) => canSeeRealm(db, actor, entry.realmId))
			};
			const realmKeys = new Map(
				db
					.select({ id: realms.id, key: realms.key })
					.from(realms)
					.where(inArray(realms.id, [...new Set(view.keys.map((entry) => entry.realmId))]))
					.all()
					.map((row) => [row.id, row.key])
			);
			const data = listed(view, (realmId) => realmKeys.get(realmId)!);
			return reply(
				data,
				`${present.username(userId)}'s Affinity: ${count(data.keys.length, 'key')} with Pulses`
			);
		}
	);

	define(
		'file_pulses',
		{
			kind: 'write',
			description:
				"File a Realm's unfiled Pulses under a key it has: every Pulse unfiled under `raw_key`, and every one filed with `raw_key` as its current key, moves to `key`. A Pulse keeps its raw key. `key` must be a `scale` Attribute or a `tags` member of the Realm. Answers how many moved; 0 is fine.",
			input: {
				realm: realmRef,
				raw_key: z.string().describe('The key the Pulses were posted under, e.g. "boss-hp"'),
				key: z.string().describe('The key to file them under: `attr` or `attr:member`')
			}
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const filed = filePulses(db, actor, realmId, args.raw_key, args.key);
			return reply({ filed }, `Filed ${count(filed, 'Pulse')}`);
		}
	);

	define(
		'delete_pulse',
		{
			kind: 'destroy',
			description:
				"Delete one Pulse by id, whoever posted it; get_sentiment gives the ids. Its weight leaves the Realm's Sentiment, or the User's Affinity, at once.",
			input: { pulse: z.number().int().positive().describe('Pulse id') }
		},
		(args) => {
			deletePulse(db, actor, args.pulse);
			return reply({ deleted: { id: args.pulse } }, `Deleted Pulse ${args.pulse}`);
		}
	);
}
