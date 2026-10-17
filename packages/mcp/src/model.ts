import { ToolSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

export type RealmRef = { id: number; key: string; name: string };

export type Attribute = { key: string; kind: string; spec: unknown; [field: string]: unknown };

export type Pulse = { weight?: number; [field: string]: unknown };

export type SentimentKey = {
	key: string;
	volume: number;
	mood: number;
	v: number;
	pulses: Pulse[];
	[field: string]: unknown;
};

export type Unfiled = { volume: number; [field: string]: unknown };

export type Sentiment = { asOf: string; keys: SentimentKey[]; unfiled: Unfiled[] };

export type RealmData = {
	realm: RealmRef;
	version: number;
	notes: string;
	settings: Record<string, unknown>;
	attributes: Attribute[];
	attributesFetchedAt: string;
	sentiment: Sentiment | null;
	sentimentAsOf: string | null;
};

export type Skill = { key: string; [field: string]: unknown };

export type SkillsData = { skills: Skill[] };

export type ServerData = { instructions?: string };

export type AttributesAnswer =
	| { version: number; full: false }
	| {
			version: number;
			full: true;
			notes: string;
			settings: Record<string, unknown>;
			attributes: Attribute[];
	  };

type Obj = Record<string, unknown>;

const isRecord = (value: unknown): value is Obj =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isNumber = (value: unknown): value is number =>
	typeof value === 'number' && Number.isFinite(value);

const items = <T>(value: unknown, keep: (item: unknown) => item is T): T[] | undefined =>
	Array.isArray(value) && value.every(keep) ? value : undefined;

const isRealmRef = (value: unknown): value is RealmRef =>
	isRecord(value) &&
	isNumber(value.id) &&
	typeof value.key === 'string' &&
	typeof value.name === 'string';

const isAttribute = (value: unknown): value is Attribute =>
	isRecord(value) && typeof value.key === 'string' && typeof value.kind === 'string';

const isSkill = (value: unknown): value is Skill =>
	isRecord(value) && typeof value.key === 'string';

const isSentimentKey = (value: unknown): value is SentimentKey =>
	isRecord(value) &&
	typeof value.key === 'string' &&
	isNumber(value.volume) &&
	isNumber(value.mood) &&
	isNumber(value.v) &&
	Array.isArray(value.pulses) &&
	value.pulses.every(isRecord);

const isUnfiled = (value: unknown): value is Unfiled => isRecord(value) && isNumber(value.volume);

export function parseRealms(data: unknown): RealmRef[] | undefined {
	if (!isRecord(data)) return undefined;
	const realms = items(data.realms, isRealmRef);
	return realms?.map(({ id, key, name }) => ({ id, key, name }));
}

export function parseAttributes(data: unknown): AttributesAnswer | undefined {
	if (!isRecord(data) || !isNumber(data.version)) return undefined;
	if (data.attributes === undefined) return { version: data.version, full: false };
	const attributes = items(data.attributes, isAttribute);
	if (!attributes || typeof data.notes !== 'string' || !isRecord(data.settings)) return undefined;
	return {
		version: data.version,
		full: true,
		notes: data.notes,
		settings: data.settings,
		attributes
	};
}

export function parseSentiment(data: unknown): Sentiment | undefined {
	if (!isRecord(data) || typeof data.asOf !== 'string') return undefined;
	const keys = items(data.keys, isSentimentKey);
	const unfiled = items(data.unfiled, isUnfiled);
	return keys && unfiled ? { asOf: data.asOf, keys, unfiled } : undefined;
}

export function parseSkills(data: unknown): SkillsData | undefined {
	if (!isRecord(data)) return undefined;
	const skills = items(data.skills, isSkill);
	return skills && { skills };
}

const isTime = (value: unknown): value is string => typeof value === 'string';

export function parseRealmData(data: unknown): RealmData | undefined {
	if (!isRecord(data) || !isRealmRef(data.realm) || !isTime(data.attributesFetchedAt)) {
		return undefined;
	}
	const answer = parseAttributes(data);
	if (!answer?.full) return undefined;
	const sentiment = data.sentiment === null ? null : parseSentiment(data.sentiment);
	const sentimentAsOf = data.sentimentAsOf;
	if (sentiment === undefined || (sentimentAsOf !== null && !isTime(sentimentAsOf))) {
		return undefined;
	}
	const { id, key, name } = data.realm;
	return {
		realm: { id, key, name },
		version: answer.version,
		notes: answer.notes,
		settings: answer.settings,
		attributes: answer.attributes,
		attributesFetchedAt: data.attributesFetchedAt,
		sentiment,
		sentimentAsOf
	};
}

// Drop a bad tool, never the whole list.
export function parseTools(data: unknown): Tool[] | undefined {
	if (!Array.isArray(data)) return undefined;
	const tools = data.filter((item): item is Tool => ToolSchema.safeParse(item).success);
	return tools.length || !data.length ? tools : undefined;
}

export function parseServer(data: unknown): ServerData | undefined {
	if (!isRecord(data)) return undefined;
	if (data.instructions === undefined) return {};
	return typeof data.instructions === 'string' ? { instructions: data.instructions } : undefined;
}
