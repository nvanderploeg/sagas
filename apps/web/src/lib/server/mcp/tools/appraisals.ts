import { canSeeLabour, visibleRealmIds } from '../../domain/access.ts';
import { z } from 'zod';
import {
	appraise,
	BATCH_MAX,
	listUnappraised,
	readAppraisal,
	type AppraiseItem
} from '../../agent/appraisals.ts';
import { changeLinks, LINK_BATCH_MAX, LINK_TYPES } from '../../agent/links.ts';
import { readLabour } from '../../domain/labours.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { labourRef, pageShape, realmRef, type Tools } from '../tool.ts';

const linkShape = z.strictObject({
	type: z
		.enum(LINK_TYPES)
		.describe(
			'evidence: the first supports the second. blocks: the second waits for the first to be Closed. relates: either way round. duplicates: the first repeats the second'
		),
	to: labourRef
		.optional()
		.describe('The Labour this one points to; give exactly one of `to` and `from`'),
	from: labourRef
		.optional()
		.describe('The Labour that points to this one, e.g. the blocker of a blocked Labour'),
	note: z
		.string()
		.optional()
		.describe('Up to 500 characters; keeps the existing note when left out'),
	remove: z.boolean().optional().describe('true removes the Link; removing an absent Link is fine')
});

const itemShape = z.strictObject({
	labour: labourRef,
	brief: z
		.string()
		.optional()
		.describe('One or two sentences for other agents to scan, up to 400 characters; "" clears'),
	refs: z
		.array(
			z.strictObject({
				href: z.string().describe('A URL or repository path, 1 to 500 characters'),
				label: z.string().nullable().optional().describe('Up to 120 characters')
			})
		)
		.optional()
		.describe('Replaces the References, at most 20; [] clears'),
	values: z
		.record(z.string(), z.unknown())
		.optional()
		.describe('Attribute key to value; null clears. As in the Realm of this Labour'),
	links: z.array(linkShape).optional().describe('Links to add, re-note or remove; others stay'),
	needs: z
		.record(z.string(), z.number().int().nullable())
		.optional()
		.describe(
			'Skill key to the level the Labour needs, 1 to 5; null clears. Others stay; a Labour needs at most 8 Skills'
		),
	stamp: z
		.string()
		.optional()
		.describe('The contentHash get_appraisal gave before you read the Labour')
});

const linkChangeShape = z.strictObject({
	type: z.enum(LINK_TYPES).describe(linkTypeHelp()),
	from: labourRef.describe('The Labour the Link starts at; for blocks, the blocker'),
	to: labourRef.describe('The Labour the Link points to; for blocks, the blocked Labour'),
	note: linkShape.shape.note,
	remove: linkShape.shape.remove
});

function linkTypeHelp(): string {
	return 'evidence: from supports to. blocks: to waits for from to be Closed. relates: either way round. duplicates: from repeats to';
}

export function registerAppraisalTools({ db, actor, define }: Tools): void {
	define(
		'appraise',
		{
			kind: 'write',
			description: `Record what you read of up to ${BATCH_MAX} Labours in one all-or-nothing call: each item may set a Brief, replace References, set Attribute values, add or remove Links to other Labours and set the Skills it needs. Pass \`stamp\`, the contentHash get_appraisal gave you before reading, to mark the Appraisal current; it is stamped only if the Labour's title, description, Labels and Comments are unchanged since. Each item writes only what it names.`,
			input: {
				labours: z.array(itemShape).min(1).max(BATCH_MAX).describe(`1 to ${BATCH_MAX} items`)
			}
		},
		(args) => {
			const items = args.labours.map((item): AppraiseItem => ({
				labourId: refs.labourId(db, item.labour, actor),
				brief: item.brief,
				refs: item.refs,
				values: item.values,
				links: item.links?.map((link) => ({
					type: link.type,
					to: link.to === undefined ? undefined : refs.labourId(db, link.to, actor),
					from: link.from === undefined ? undefined : refs.labourId(db, link.from, actor),
					note: link.note,
					remove: link.remove
				})),
				needs: item.needs,
				stamp: item.stamp
			}));
			const results = appraise(db, actor, items);
			const appraised = results.map((result) => ({
				labour: refs.labourKey(db, result.labourId),
				stamped: result.stamped
			}));
			const stamped = appraised.filter((entry) => entry.stamped).length;
			return reply(
				{ appraised },
				`Appraised ${count(appraised.length, 'Labour')}, ${stamped} stamped`
			);
		}
	);

	define(
		'link_labours',
		{
			kind: 'write',
			description: `Add, re-note or remove Links between Labours in one all-or-nothing call of up to ${LINK_BATCH_MAX}: evidence, blocks (dependencies), relates and duplicates. "SPIRE-40 blocks SPIRE-41" is { type: "blocks", from: "SPIRE-40", to: "SPIRE-41" }; a blocks Link that would close a cycle is refused. Read a Labour's Links back with get_labour.`,
			input: {
				links: z
					.array(linkChangeShape)
					.min(1)
					.max(LINK_BATCH_MAX)
					.describe(`1 to ${LINK_BATCH_MAX} changes; others stay`)
			}
		},
		(args) => {
			changeLinks(
				db,
				actor,
				args.links.map((link) => ({
					type: link.type,
					from: refs.labourId(db, link.from, actor),
					to: refs.labourId(db, link.to, actor),
					note: link.note,
					remove: link.remove === true
				}))
			);
			return reply({ changed: args.links.length }, `Changed ${count(args.links.length, 'Link')}`);
		}
	);

	define(
		'get_appraisal',
		{
			kind: 'read',
			description:
				"Get a Labour's whole agent layer: Brief, References, Attribute values, Links, needed Skills and the 10 newest Mentions of it in other Labours' text, the stamp of its last Appraisal, and `contentHash`, the hash of what it holds now. Take `contentHash` before you read the Labour, then pass it back as `stamp` to appraise.",
			input: { labour: labourRef }
		},
		(args, present) => {
			const view = readAppraisal(db, refs.labourId(db, args.labour, actor));
			const key = refs.labourKey(db, view.labourId);
			const setBy = (id: number | null) => (id === null ? null : present.username(id));
			const data = {
				labour: key,
				brief: view.brief,
				refs: view.refs,
				setBy: setBy(view.setBy),
				via: view.via,
				setAt: view.setAt?.toISOString() ?? null,
				contentHash: view.contentHash,
				stamp:
					view.stamp === null
						? null
						: {
								contentHash: view.stamp.contentHash,
								appraisedBy: present.username(view.stamp.appraisedBy),
								appraisedVia: view.stamp.appraisedVia,
								appraisedAt: view.stamp.appraisedAt.toISOString()
							},
				unappraised: view.unappraised,
				stale: view.stale,
				values: view.values.map((value) => ({
					key: value.key,
					kind: value.kind,
					value: value.value,
					setBy: present.username(value.setBy),
					via: value.via,
					setAt: value.setAt.toISOString(),
					stale: value.stale
				})),
				links: view.links
					.filter((link) => canSeeLabour(db, actor, link.from) && canSeeLabour(db, actor, link.to))
					.map((link) => ({
						type: link.type,
						from: refs.labourKey(db, link.from),
						to: refs.labourKey(db, link.to),
						note: link.note,
						setBy: present.username(link.setBy),
						via: link.via,
						setAt: link.setAt.toISOString()
					})),
				needs: view.needs.map((need) => ({
					skill: need.key,
					level: need.level,
					setBy: present.username(need.setBy),
					via: need.via,
					setAt: need.setAt.toISOString()
				})),
				mentions: view.mentions
					.filter((mention) => canSeeLabour(db, actor, mention.sourceLabourId))
					.map((mention) => ({
						in: refs.labourKey(db, mention.sourceLabourId),
						comment: mention.commentId,
						by: present.username(mention.authorId),
						firstSeenAt: mention.firstSeenAt.toISOString()
					}))
			};
			const state = view.unappraised ? 'unappraised' : view.stale ? 'stale' : 'current';
			return reply(
				data,
				`${key} ${state}: ${count(data.values.length, 'value')}, ${count(data.links.length, 'Link')}`
			);
		}
	);

	define(
		'list_unappraised',
		{
			kind: 'read',
			description:
				'List the Labours worth reading next, each with its reason: `unappraised` (never stamped, newest first), then `content` (stamped, but its title, description, Labels or Comments changed since), then `values` (an Attribute value set before its Attribute was revised). Closed Labours are left out unless `include_closed`. Paginate with limit and offset.',
			input: {
				realm: realmRef.optional(),
				include_closed: z.boolean().optional().describe('true also lists Closed Labours'),
				...pageShape
			}
		},
		(args) => {
			const page = listUnappraised(
				db,
				{
					realms: visibleRealmIds(db, actor) ?? undefined,
					realmId: args.realm === undefined ? undefined : refs.realmId(db, args.realm, actor),
					includeClosed: args.include_closed
				},
				{ offset: args.offset, limit: args.limit }
			);
			const labours = page.items.map(({ labourId, reason }) => {
				const { key, title } = readLabour(db, labourId);
				return { labour: key, title, reason };
			});
			const end = args.offset + labours.length;
			const nextOffset = end < page.total ? end : null;
			const more = nextOffset === null ? '' : `; next offset ${nextOffset}`;
			return reply(
				{ labours, total: page.total, offset: args.offset, nextOffset },
				`${count(page.total, 'Labour')} to appraise${labours.length > 0 ? `; showing ${args.offset + 1}-${end}` : ''}${more}`
			);
		}
	);
}
