import { z } from 'zod';
import {
	defineAttribute,
	deleteAttribute,
	readAttributes,
	readRealmAgent,
	tuneRealm,
	type AttributeView
} from '../../agent/attributes.ts';
import { getRealm } from '../../domain/lookup.ts';
import { count } from '../present.ts';
import * as refs from '../refs.ts';
import { reply } from '../result.ts';
import { indexField, keyField, realmRef, type Tools } from '../tool.ts';

function attributeDto(view: AttributeView) {
	const { key, kind, label, rubric, spec, position, held, stale, counts } = view;
	return {
		key,
		kind,
		label,
		rubric,
		spec,
		position,
		revisedAt: view.revisedAt.toISOString(),
		held,
		stale,
		counts
	};
}

const specShape = z.strictObject({
	min: z.number().optional().describe('scale: lowest value, an integer'),
	max: z
		.number()
		.nullable()
		.optional()
		.describe(
			'scale: highest value, an integer at most 100 above min. tags: how many members a Labour may hold, 1 to 64; null for no limit. text: longest value in characters, 1 to 20,000; 2,000 by default'
		),
	members: z
		.array(
			z.strictObject({
				key: keyField,
				label: z.string().describe('1 to 64 characters'),
				rubric: z.string().optional().describe('When to pick this member, up to 1,000 characters')
			})
		)
		.optional()
		.describe('tags: 1 to 64 members in display order')
});

export function registerAttributeTools({ db, actor, define }: Tools): void {
	const settings = (realmId: number) => {
		const { version, notes, halfLifeDays, loudness } = readRealmAgent(db, realmId);
		return { version, notes, settings: { halfLifeDays, loudness } };
	};

	define(
		'get_attributes',
		{
			kind: 'read',
			description:
				"Get a Realm's agent notes, settings and Attributes, each with how many Labours hold each value; pass `since` with the version you cached to get only the version back when nothing changed.",
			input: {
				realm: realmRef,
				since: z.number().int().min(0).optional().describe('The version you last saw')
			}
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const { key } = getRealm(db, realmId);
			const agent = settings(realmId);
			if (args.since === agent.version) {
				return reply(
					{ realm: key, version: agent.version },
					`${key} is at version ${agent.version}`
				);
			}
			const found = readAttributes(db, realmId).map(attributeDto);
			return reply(
				{ realm: key, ...agent, attributes: found },
				`${key} version ${agent.version}: ${count(found.length, 'Attribute')}`
			);
		}
	);

	define(
		'define_attribute',
		{
			kind: 'write',
			description:
				'Create an Attribute of a Realm, or revise or move it when the key exists: a scale (integer range), tags (members, optionally a limit) or text value that agents set on its Labours, judged by its rubric.',
			input: {
				realm: realmRef,
				key: keyField,
				kind: z
					.enum(['scale', 'tags', 'text'])
					.describe('scale, tags or text; fixed once the Attribute exists'),
				label: z.string().optional().describe('1 to 64 characters; required to create'),
				rubric: z
					.string()
					.optional()
					.describe('Markdown guidance for setting it, 1 to 4,000 characters; required to create'),
				spec: specShape
					.optional()
					.describe(
						'Required to create a scale (min, max) or tags (members); on a revision, fields you leave out keep their value'
					),
				index: indexField.optional().describe("0-based index among the Realm's Attributes")
			}
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const { version, attribute } = defineAttribute(db, actor, realmId, {
				key: args.key,
				kind: args.kind,
				label: args.label,
				rubric: args.rubric,
				spec: args.spec,
				index: args.index
			});
			return reply(
				{ version, attribute: attributeDto(attribute) },
				`Attribute ${attribute.key} (${attribute.kind}) at index ${attribute.position}, version ${version}`
			);
		}
	);

	define(
		'delete_attribute',
		{
			kind: 'destroy',
			description: "Delete an Attribute of a Realm with every Labour's value of it.",
			input: { realm: realmRef, key: keyField }
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			const { version } = deleteAttribute(db, actor, realmId, args.key);
			return reply({ version, deleted: { key: args.key } }, `Deleted Attribute ${args.key}`);
		}
	);

	define(
		'tune_realm',
		{
			kind: 'write',
			description:
				"Set a Realm's agent notes (Markdown, up to 4,000 characters), Pulse half-life in days or loudness.",
			input: {
				realm: realmRef,
				notes: z.string().optional().describe('Up to 4,000 characters; "" clears'),
				half_life_days: z.number().optional().describe('More than 0, at most 365'),
				loudness: z.number().optional().describe('More than 0, at most 1,000')
			}
		},
		(args) => {
			const realmId = refs.realmId(db, args.realm, actor);
			tuneRealm(db, actor, realmId, {
				notes: args.notes,
				halfLifeDays: args.half_life_days,
				loudness: args.loudness
			});
			const { key } = getRealm(db, realmId);
			const agent = settings(realmId);
			return reply({ realm: key, ...agent }, `${key} settings at version ${agent.version}`);
		}
	);
}
