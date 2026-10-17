import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createStub, ok, tool, toolError } from './stub.ts';

type Json = Record<string, unknown>;

export type World = {
	realms: { id: number; key: string; name: string; aliases: string[] }[];
	attributes: Record<number, { version: number; notes: string; attributes: Json[] }>;
	sentiment: Record<number, { asOf: string; keys: Json[]; unfiled: Json[] }>;
	skills: Json[];
};

export const scale = (key: string, min = 1, max = 5): Json => ({
	key,
	kind: 'scale',
	label: key,
	rubric: `how ${key}`,
	spec: { min, max },
	position: 0,
	revisedAt: '2026-01-01T00:00:00.000Z',
	held: 0,
	stale: 0,
	counts: {}
});

export const tags = (key: string, members: string[]): Json => ({
	key,
	kind: 'tags',
	label: key,
	rubric: `which ${key}`,
	spec: { members: members.map((m) => ({ key: m, label: m, rubric: '' })), max: null },
	position: 1,
	revisedAt: '2026-01-01T00:00:00.000Z',
	held: 0,
	stale: 0,
	counts: Object.fromEntries(members.map((m) => [m, 0]))
});

export const pulse = (id: number, weight: number): Json => ({
	id,
	note: `pulse ${id}`,
	evidence: [],
	author: 'ann',
	createdAt: '2026-01-01T00:00:00.000Z',
	weight
});

export const sentimentKey = (
	realm: string,
	key: string,
	volume: number,
	mood: number,
	v: number
): Json => ({ realm, key, volume, mood, v, pulses: [pulse(1, volume)] });

export function defaultWorld(): World {
	return {
		realms: [
			{ id: 1, key: 'AM', name: 'Armory', aliases: [] },
			{ id: 2, key: 'WB', name: 'World Boss', aliases: [] }
		],
		attributes: {
			1: {
				version: 1,
				notes: 'Armory notes',
				attributes: [scale('impact'), tags('topic', ['boss-hp', 'loot'])]
			},
			2: { version: 4, notes: '', attributes: [scale('fun', 0, 10)] }
		},
		sentiment: {
			1: {
				asOf: '2026-01-01T00:00:00.000Z',
				keys: [
					sentimentKey('AM', 'impact', 2, -0.4, 0.29),
					sentimentKey('AM', 'topic:boss-hp', 4, 0.7, 0.44)
				],
				unfiled: []
			},
			2: { asOf: '2026-01-01T00:00:00.000Z', keys: [], unfiled: [] }
		},
		skills: [
			{ key: 'art', label: 'Art', rubric: '', holders: 2 },
			{ key: 'code', label: 'Code', rubric: '', holders: 3 }
		]
	};
}

export const ALL_TOOLS = [
	'whoami',
	'survey',
	'list_realms',
	'get_attributes',
	'get_sentiment',
	'list_skills'
];

// A stub `/mcp` whose answers follow `world`; `without` leaves tools out, as an older server would.
export async function createWorldStub(world: World, without: string[] = []) {
	const stub = createStub('secret');
	stub.tools = ALL_TOOLS.filter((name) => !without.includes(name)).map((name) =>
		tool(name, name === 'survey' ? 'Rank the Labours.' : `${name} tool`)
	);
	const realm = (args: Json) =>
		world.realms.find((r) => r.id === args.realm || r.key === args.realm);
	const withRealm = (args: Json, answer: (r: World['realms'][number]) => CallToolResult) => {
		const found = realm(args);
		return found ? answer(found) : toolError('not_found', 'unknown Realm');
	};

	stub.handlers.set('whoami', () => ok({ user: { username: 'ann' } }));
	stub.handlers.set('survey', () => ok({ survey: 1, results: [] }));
	stub.handlers.set('list_realms', () => ok({ realms: world.realms }));
	stub.handlers.set('get_attributes', (args) =>
		withRealm(args, (r) => {
			const current = world.attributes[r.id];
			if (args.since === current.version) return ok({ realm: r.key, version: current.version });
			return ok({
				realm: r.key,
				version: current.version,
				notes: current.notes,
				settings: { halfLifeDays: 14, loudness: 5 },
				attributes: current.attributes
			});
		})
	);
	stub.handlers.set('get_sentiment', (args) =>
		withRealm(args, (r) => ok(world.sentiment[r.id] as Json))
	);
	stub.handlers.set('list_skills', () => ok({ skills: world.skills }));
	await stub.start();
	return stub;
}
