import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { AuthUser } from '../auth/users.ts';
import type { Db } from '../db/client.ts';
import { toolsFor } from './tool.ts';
import { registerProjectTools } from './tools/projects.ts';
import { registerQuestTools } from './tools/quests.ts';
import { registerTicketTools } from './tools/tickets.ts';
import { registerUserTools } from './tools/users.ts';

const INSTRUCTIONS = `workload is a ticket tracker. Vocabulary:
- Ticket: one unit of work, addressed by its Ticket key (AM-123, any case). Moving a Ticket or renaming its Project key gives it a new key; old keys stay Aliases that still resolve.
- Project: a group of Tickets with its own key and States. States are its board columns; Closed is built in and always last. A Ticket is finished exactly when it is in Closed.
- Substate: an optional subdivision of a State. When a State has Substates, its Tickets are always in one.
- Rank: a Ticket's position within its State's column; top is next. There is no priority field.
- Parent and Children: a Ticket has at most one Parent.
- Quest: a named, ordered set of Tickets across Projects; progress is its Closed Tickets over all.
Every tool acts as the User of your API token (see whoami).`;

export function createMcpServer(db: Db, actor: AuthUser): McpServer {
	const server = new McpServer(
		{ name: 'workload', version: '0.1.0' },
		{ capabilities: { tools: {} }, instructions: INSTRUCTIONS }
	);
	const tools = toolsFor(server, db, actor);
	registerTicketTools(tools);
	registerProjectTools(tools);
	registerQuestTools(tools);
	registerUserTools(tools);
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
