import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthUser } from '../auth/users.ts';
import type { Db } from '../db/client.ts';
import { Presenter } from './present.ts';
import { run, type Reply } from './result.ts';

const ref = z.union([z.string().trim().min(1), z.number().int().positive()]);

export const ticketRef = ref.describe(
	'Ticket key in any case, a former key (Alias) included, e.g. "AM-12", or the internal id'
);
export const projectRef = ref.describe('Project key (a former key works too) or id');
export const userRef = ref.describe('Username or id');
export const stateRef = ref.describe('State key within the Project, e.g. "todo", or id');
export const substateRef = ref.describe('Substate key within its State, or id');
export const questRef = ref.describe('Quest id');

export const placementShape = {
	position: z.enum(['top', 'bottom']).optional().describe('Place at the top or bottom'),
	before: ticketRef.optional().describe('Place just before this Ticket'),
	after: ticketRef.optional().describe('Place just after this Ticket')
};

export const styleShape = {
	label: z.string().describe('Display label'),
	color: z.string().describe('Color as #rrggbb'),
	icon: z.string().describe('Lowercase icon name, e.g. "circle"')
};

export const keyField = z
	.string()
	.describe('Lowercase key: letters, digits and hyphens, starting with a letter');

export const pageShape = {
	limit: z.number().int().min(1).max(200).default(50).describe('Page size, 1 to 200'),
	offset: z.number().int().min(0).default(0).describe('Number of results to skip')
};

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
const WRITE: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: false,
	openWorldHint: false
};
const DESTROY: ToolAnnotations = {
	readOnlyHint: false,
	destructiveHint: true,
	openWorldHint: false
};

export type ToolKind = 'read' | 'write' | 'destroy';

const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
	read: READ,
	write: WRITE,
	destroy: DESTROY
};

export type Tools = {
	db: Db;
	actor: AuthUser;
	define<S extends z.ZodRawShape>(
		name: string,
		spec: { description: string; kind: ToolKind; input: S },
		body: (args: z.infer<z.ZodObject<S>>, present: Presenter) => Reply | Promise<Reply>
	): void;
};

export function toolsFor(server: McpServer, db: Db, actor: AuthUser): Tools {
	return {
		db,
		actor,
		define(name, spec, body) {
			server.registerTool(
				name,
				{
					description: spec.description,
					inputSchema: spec.input as z.ZodRawShape,
					annotations: ANNOTATIONS[spec.kind]
				},
				(args: unknown) => run(name, () => body(args as never, new Presenter(db)))
			);
		}
	};
}
