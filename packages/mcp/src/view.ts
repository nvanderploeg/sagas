import type { Tool } from '@sagas/client';
import type { Attribute, RealmData, ServerData, SkillsData } from './model.ts';

export type Cached<T> = { fetchedAt: string; data: T };

export type State = {
	realms: Map<number, RealmData>;
	skills: Cached<SkillsData> | undefined;
	tools: Cached<Tool[]> | undefined;
	server: Cached<ServerData> | undefined;
};

export type Resource = {
	uri: string;
	name: string;
	description: string;
	mimeType: 'application/json';
	text: string;
	signature: string;
};

export const SKILLS_URI = 'sagas://skills';
export const realmUri = (key: string) => `sagas://realm/${key}`;

const DIGEST_LIMIT = 1500;
const LOUD_KEYS = 3;
const SURVEY = 'survey';

const round = (value: number) => Number(value.toFixed(1)) + 0;

function signed(value: number): string {
	const shown = round(value);
	return `${shown < 0 ? '-' : '+'}${Math.abs(shown).toFixed(1)}`;
}

const realmContent = (data: RealmData) => ({
	realm: data.realm,
	version: data.version,
	notes: data.notes,
	settings: data.settings,
	attributes: data.attributes,
	attributesFetchedAt: data.attributesFetchedAt,
	sentiment: data.sentiment,
	sentimentAsOf: data.sentimentAsOf
});

const omit = (value: object, field: string) =>
	Object.fromEntries(Object.entries(value).filter(([name]) => name !== field));

// A signature changes only when an agent would read something different.
function stable({ realm, version, notes, settings, attributes, sentiment }: RealmData) {
	return {
		realm,
		version,
		notes,
		settings,
		attributes,
		sentiment: sentiment && {
			keys: sentiment.keys.map((key) => ({
				...omit(key, 'v'),
				volume: round(key.volume),
				mood: round(key.mood),
				pulses: key.pulses.map((pulse) => omit(pulse, 'weight'))
			})),
			unfiled: sentiment.unfiled.map((entry) => ({ ...entry, volume: round(entry.volume) }))
		}
	};
}

const byKey = <T extends { key: string }>(a: T, b: T) =>
	a.key < b.key ? -1 : a.key > b.key ? 1 : 0;

export function resourcesOf(state: State): Resource[] {
	const resources: Resource[] = [];
	const realms = [...state.realms.values()].sort((a, b) => byKey(a.realm, b.realm));
	for (const data of realms) {
		const { key, name } = data.realm;
		resources.push({
			uri: realmUri(key),
			name: `Realm ${key}`,
			description: `${name}: notes, settings, Attributes with their counts, and Sentiment`,
			mimeType: 'application/json',
			text: JSON.stringify(realmContent(data), null, 2),
			signature: JSON.stringify(stable(data))
		});
	}
	if (state.skills) {
		const { skills } = state.skills.data;
		resources.push({
			uri: SKILLS_URI,
			name: 'Skills',
			description: 'The Skills defined on this instance',
			mimeType: 'application/json',
			text: JSON.stringify({ skills, fetchedAt: state.skills.fetchedAt }, null, 2),
			signature: JSON.stringify(skills)
		});
	}
	return resources;
}

function describeAttribute({ key, kind, spec }: Attribute): string {
	const fields = typeof spec === 'object' && spec !== null ? (spec as Record<string, unknown>) : {};
	if (kind === 'scale') return `${key} (scale ${String(fields.min)}–${String(fields.max)})`;
	if (kind === 'tags') {
		const members = Array.isArray(fields.members) ? fields.members : [];
		const keys = members.map((member) => String((member as { key?: unknown })?.key));
		return `${key} (tags: ${keys.join(', ')})`;
	}
	return `${key} (${kind})`;
}

export function digestOf(state: State): string {
	const lines: string[] = [];
	const realms = [...state.realms.values()].sort((a, b) => byKey(a.realm, b.realm));
	for (const data of realms) {
		const attributes = data.attributes.map(describeAttribute).join(', ') || 'no attributes';
		let line = `${data.realm.key}: ${attributes}`;
		const loud = (data.sentiment?.keys ?? [])
			.filter((entry) => entry.volume > 0)
			.sort((a, b) => b.v - a.v || byKey(a, b))
			.slice(0, LOUD_KEYS);
		if (loud.length) {
			line += `; loud: ${loud.map((entry) => `${entry.key} mood ${signed(entry.mood)}`).join(', ')}`;
		}
		lines.push(line);
	}
	const skills = state.skills?.data.skills ?? [];
	if (skills.length) lines.push(`Skills: ${skills.map((skill) => skill.key).join(', ')}`);
	if (!lines.length) return '';
	const text = ['Cached for this instance:', ...lines].join('\n');
	return text.length > DIGEST_LIMIT ? `${text.slice(0, DIGEST_LIMIT - 1)}…` : text;
}

export function servedTools(state: State): Tool[] {
	const digest = digestOf(state);
	const tools = state.tools?.data ?? [];
	if (!digest) return tools;
	return tools.map((tool) =>
		tool.name === SURVEY
			? { ...tool, description: tool.description ? `${tool.description}\n\n${digest}` : digest }
			: tool
	);
}
