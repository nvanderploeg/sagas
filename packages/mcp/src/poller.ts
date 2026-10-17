import {
	listCache,
	readCache,
	removeCache,
	writeCache,
	type SagasClient,
	type Warn
} from '@sagas/client';
import {
	parseAttributes,
	parseRealmData,
	parseRealms,
	parseSentiment,
	parseServer,
	parseSkills,
	parseTools,
	type RealmData,
	type RealmRef
} from './model.ts';
import { resourcesOf, servedTools, type Cached, type State } from './view.ts';

export type Changes = { tools: boolean; resources: boolean };

export type Kind = 'core' | 'sentiment' | 'tools';

export type PollerOptions = {
	client: SagasClient;
	dir: string;
	warn: Warn;
	sentiment: boolean;
	onChange: (changes: Changes) => void;
	now?: () => Date;
};

type Answer = { kind: 'ok'; data: unknown } | { kind: 'down' } | { kind: 'error' };

const TOOLS = 'tools.json';
const SKILLS = 'skills.json';
const SERVER = 'server.json';
const realmFile = (id: number) => `realms/${id}.json`;

function cached<T>(dir: string, name: string, parse: (data: unknown) => T | undefined) {
	try {
		const entry = readCache<unknown>(dir, name);
		const data = entry && parse(entry.data);
		return entry && data ? { fetchedAt: entry.fetchedAt, data } : undefined;
	} catch {
		return undefined;
	}
}

// What cannot be read whole is absent: a poll refetches it.
export function loadState(dir: string): State {
	const state: State = {
		realms: new Map(),
		skills: cached(dir, SKILLS, parseSkills),
		tools: cached(dir, TOOLS, parseTools),
		server: cached(dir, SERVER, parseServer)
	};
	for (const file of listCache(dir, 'realms')) {
		const realm = cached(dir, `realms/${file}`, parseRealmData);
		if (realm && file === `${realm.data.realm.id}.json`) {
			state.realms.set(realm.data.realm.id, realm.data);
		}
	}
	return state;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function serialized(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

export function createPoller(state: State, options: PollerOptions) {
	const { client, dir, warn } = options;
	const now = options.now ?? (() => new Date());
	const warned = new Set<string>();
	const waiting = new Set<Kind>();
	const written = new Map<string, string>();
	let queue: Promise<void> = Promise.resolve();
	let stopped = false;

	for (const [id, data] of state.realms) {
		const text = serialized(data);
		if (text === undefined) state.realms.delete(id);
		else written.set(realmFile(id), text);
	}
	for (const [name, part] of [
		[SKILLS, 'skills'],
		[TOOLS, 'tools'],
		[SERVER, 'server']
	] as const) {
		const entry = state[part];
		if (entry === undefined) continue;
		const text = serialized(entry.data);
		if (text === undefined) state[part] = undefined;
		else written.set(name, text);
	}

	function fingerprints() {
		try {
			return {
				tools: JSON.stringify(servedTools(state)),
				resources: JSON.stringify(resourcesOf(state).map(({ uri, signature }) => [uri, signature]))
			};
		} catch {
			return undefined;
		}
	}

	let seen = fingerprints() ?? { tools: '', resources: '' };

	// Never mark resources seen here: a poll in flight must still announce its changes.
	function markToolsSeen(): void {
		seen = { ...seen, tools: fingerprints()?.tools ?? seen.tools };
	}

	function settle(): void {
		const current = fingerprints();
		if (!current) return;
		const changes = {
			tools: current.tools !== seen.tools,
			resources: current.resources !== seen.resources
		};
		seen = current;
		if (changes.tools || changes.resources) options.onChange(changes);
	}

	function warnOnce(kind: string, message: string): void {
		if (stopped || warned.has(kind)) return;
		warned.add(kind);
		warn(message);
	}

	// A failed write stays unrecorded, so the next poll writes it again.
	function persist(name: string, data: unknown, fetchedAt: string): void {
		if (stopped) return;
		const json = JSON.stringify(data);
		if (written.get(name) === json) return;
		if (writeCache(dir, name, data, { now: new Date(fetchedAt), warn })) written.set(name, json);
	}

	// An unchanged answer keeps its first fetchedAt, so memory and file agree.
	function keep<T>(current: Cached<T> | undefined, data: T): Cached<T> {
		return current && same(current.data, data) ? current : { fetchedAt: now().toISOString(), data };
	}

	async function ask(name: string, args: Record<string, unknown>): Promise<Answer> {
		const result = await client.callTool(name, args);
		if (!result.ok) {
			warnOnce('down', result.warning);
			return { kind: 'down' };
		}
		warned.delete('down');
		const { isError, structuredContent, content } = result.value;
		if (isError || !structuredContent) {
			const text = content.find((part) => part.type === 'text');
			const line = text && 'text' in text ? text.text.split('\n')[0] : 'no structured result';
			warnOnce(`tool:${name}`, `${name}: ${line}`);
			return { kind: 'error' };
		}
		warned.delete(`tool:${name}`);
		return { kind: 'ok', data: structuredContent };
	}

	const supports = (name: string) =>
		!state.tools || state.tools.data.some((tool) => tool.name === name);

	function rememberInstructions(instructions: string | undefined): void {
		if (stopped) return;
		state.server = keep(state.server, instructions === undefined ? {} : { instructions });
		persist(SERVER, state.server.data, state.server.fetchedAt);
	}

	async function refreshTools(): Promise<boolean> {
		const result = await client.listTools();
		if (!result.ok) {
			warnOnce('down', result.warning);
			return false;
		}
		warned.delete('down');
		if (stopped) return false;
		state.tools = keep(state.tools, result.value);
		persist(TOOLS, state.tools.data, state.tools.fetchedAt);
		const instructions = await client.instructions();
		if (instructions.ok) rememberInstructions(instructions.value);
		return true;
	}

	function store(data: RealmData): void {
		state.realms.set(data.realm.id, data);
		persist(realmFile(data.realm.id), data, now().toISOString());
	}

	async function fetchSentiment(id: number): Promise<Answer['kind']> {
		const answer = await ask('get_sentiment', { realm: id });
		if (answer.kind !== 'ok') return answer.kind;
		const sentiment = parseSentiment(answer.data);
		const current = state.realms.get(id);
		if (!sentiment) warnOnce('parse:get_sentiment', 'get_sentiment: unexpected answer');
		else if (current) store({ ...current, sentiment, sentimentAsOf: now().toISOString() });
		return 'ok';
	}

	async function fetchAttributes(listed: RealmRef): Promise<Answer['kind']> {
		const cachedRealm = state.realms.get(listed.id);
		let since = cachedRealm?.version;
		for (;;) {
			const answer = await ask('get_attributes', {
				realm: listed.id,
				...(since === undefined ? {} : { since })
			});
			if (answer.kind !== 'ok') return answer.kind;
			const parsed = parseAttributes(answer.data);
			if (!parsed) {
				warnOnce('parse:get_attributes', 'get_attributes: unexpected answer');
				return 'ok';
			}
			if (parsed.full) {
				store({
					realm: listed,
					version: parsed.version,
					notes: parsed.notes,
					settings: parsed.settings,
					attributes: parsed.attributes,
					attributesFetchedAt: now().toISOString(),
					sentiment: cachedRealm?.sentiment ?? null,
					sentimentAsOf: cachedRealm?.sentimentAsOf ?? null
				});
				return 'ok';
			}
			if (cachedRealm && since !== undefined && parsed.version === cachedRealm.version) {
				store({ ...cachedRealm, realm: listed });
				return 'ok';
			}
			if (since === undefined) return 'ok';
			since = undefined;
		}
	}

	// The Realms whose Sentiment it fetched on the way; nothing when it had to stop early.
	async function pollCore(): Promise<Set<number> | undefined> {
		const withSentiment = new Set<number>();
		if (!(await refreshTools())) return undefined;

		const listing = await ask('list_realms', {});
		if (listing.kind !== 'ok') return undefined;
		const realms = parseRealms(listing.data);
		if (!realms) {
			warnOnce('parse:list_realms', 'list_realms: unexpected answer');
			return undefined;
		}
		warned.delete('parse:list_realms');

		const listedIds = new Set(realms.map((realm) => realm.id));
		for (const id of [...state.realms.keys()]) {
			if (listedIds.has(id)) continue;
			state.realms.delete(id);
			written.delete(realmFile(id));
			removeCache(dir, realmFile(id));
		}
		for (const realm of realms) {
			const current = state.realms.get(realm.id);
			if (current) state.realms.set(realm.id, { ...current, realm });
		}

		for (const realm of realms) {
			if ((await fetchAttributes(realm)) === 'down') return undefined;
			const fresh = state.realms.get(realm.id);
			if (options.sentiment && fresh && !fresh.sentiment && supports('get_sentiment')) {
				withSentiment.add(realm.id);
				if ((await fetchSentiment(realm.id)) === 'down') return undefined;
			}
		}

		if (!supports('list_skills')) return withSentiment;
		const answer = await ask('list_skills', {});
		if (answer.kind !== 'ok') return answer.kind === 'down' ? undefined : withSentiment;
		const skills = parseSkills(answer.data);
		if (!skills) {
			warnOnce('parse:list_skills', 'list_skills: unexpected answer');
			return withSentiment;
		}
		state.skills = keep(state.skills, skills);
		persist(SKILLS, state.skills.data, state.skills.fetchedAt);
		return withSentiment;
	}

	async function pollSentiment(skip: Set<number> = new Set()): Promise<void> {
		if (!options.sentiment || !supports('get_sentiment')) return;
		for (const id of [...state.realms.keys()]) {
			if (skip.has(id)) continue;
			if ((await fetchSentiment(id)) === 'down') return;
		}
	}

	const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

	// Nothing a job or an announcement throws may reject the queue: every later job chains on it.
	function run(job: () => Promise<void>): Promise<void> {
		const next = queue.then(async () => {
			if (stopped) return;
			try {
				await job();
			} catch (error) {
				warnOnce('internal', `poll failed: ${reason(error)}`);
			}
			try {
				settle();
			} catch (error) {
				warnOnce('internal', `poll failed: ${reason(error)}`);
			}
		});
		queue = next.catch(() => {});
		return next;
	}

	const jobs: Record<Kind, () => Promise<unknown>> = {
		core: pollCore,
		sentiment: () => pollSentiment(),
		tools: refreshTools
	};

	return {
		markToolsSeen,
		refreshTools,
		rememberInstructions,
		poll: () =>
			run(async () => {
				const fetched = await pollCore();
				if (fetched) await pollSentiment(fetched);
			}),
		// Never drop a tick: each kind keeps one waiting run.
		enqueue(kind: Kind): void {
			if (stopped || waiting.has(kind)) return;
			waiting.add(kind);
			void run(async () => {
				waiting.delete(kind);
				await jobs[kind]();
			});
		},
		stop(): void {
			stopped = true;
			waiting.clear();
		},
		idle: () => queue
	};
}
