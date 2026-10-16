import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { AuthUser } from '../auth/users.ts';
import type { Db } from '../db/client.ts';
import { toolRegistry } from './tool.ts';
import { registerRealmTools } from './tools/realms.ts';
import { registerQuestTools } from './tools/quests.ts';
import { registerLabourTools } from './tools/labours.ts';
import { registerUserTools } from './tools/users.ts';
import { registerAttributeTools } from './tools/attributes.ts';
import { registerAppraisalTools } from './tools/appraisals.ts';
import { registerSurveyTools } from './tools/survey.ts';
import { registerSentimentTools } from './tools/sentiment.ts';
import { registerSkillTools } from './tools/skills.ts';

const INSTRUCTIONS = `sagas is a labour tracker. Vocabulary:
- Labour: one unit of work, addressed by its Labour key (AM-123, any case). Moving a Labour or renaming its Realm key gives it a new key; old keys stay Aliases that still resolve.
- Realm: a group of Labours with its own key and States. States are its board columns; Closed is built in and always last. A Labour is finished exactly when it is in Closed.
- Substate: an optional subdivision of a State. When a State has Substates, its Labours are always in one.
- Rank: a Labour's position within its State's board column; top is next. There is no priority field.
- Parent and Children: a Labour has at most one Parent.
- Quest: a named, ordered set of Labours across Realms; progress is its Closed Labours over all.
- Agent layer: data for agents, shown to people only in an Advanced view. Any User may change it; its writes record no Events.
- Attribute: a field a Realm defines for agents to set on its Labours (a scale, tags or text), with a rubric saying what each value means.
- Appraisal: an agent's Brief and References for a Labour, stamped with the hash of the content it read; stale once that content changes.
- Link: evidence, blocks, relates or duplicates between two Labours; separate from Parent.
- Survey: a request that scores Labours with weights over Attribute keys, tags members and built-in features, for one User and an optional query. It returns Labours by Score, shuffled by a temperature, and is kept with its results.
- Score: a Labour's weighted sum in one Survey. Scores from different Surveys don't compare.
- Skill: an ability named once for the whole instance (vfx, combat-design). Users hold Skills at levels 1 to 5; Labours need them at levels.
- Sentiment: how a Realm's audience feels about what its Attributes name: for each scale Attribute and each tags member, a volume and a mood from -1 to +1, built from Pulses.
- Pulse: one report into a Sentiment: an amount and a mood about one key, with a note and evidence. Its weight halves every half-life. A Pulse for a key its Realm lacks stays unfiled until an agent files it.
Arguments: an id is a JSON number; a string is always a key or a username. "me" names you wherever a User is asked for.
Every tool acts as the User of your API token (see whoami).`;

// Declare `tools` without `listChanged`: a stateless server can never send that notification.
export function createMcpServer(db: Db, actor: AuthUser): Server {
	const server = new Server(
		{ name: 'sagas', version: '0.1.0' },
		{ capabilities: { tools: {} }, instructions: INSTRUCTIONS }
	);
	const registry = toolRegistry(db, actor);
	registerLabourTools(registry.tools);
	registerRealmTools(registry.tools);
	registerQuestTools(registry.tools);
	registerUserTools(registry.tools);
	registerAttributeTools(registry.tools);
	registerAppraisalTools(registry.tools);
	registerSurveyTools(registry.tools);
	registerSentimentTools(registry.tools);
	registerSkillTools(registry.tools);
	server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: registry.list() }));
	server.setRequestHandler(CallToolRequestSchema, (request) =>
		registry.call(request.params.name, request.params.arguments)
	);
	return server;
}

// Never reuse a server across requests: its tools act as one User, and a stateless transport
// serves one request.
export async function handleMcpRequest(
	db: Db,
	actor: AuthUser,
	request: Request,
	message: unknown
) {
	const server = createMcpServer(db, actor);
	const transport = new WebStandardStreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true
	});
	await server.connect(transport);
	try {
		return await transport.handleRequest(request, { parsedBody: message });
	} finally {
		await server.close();
	}
}
