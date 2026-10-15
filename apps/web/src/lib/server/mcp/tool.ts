import type { CallToolResult, Tool, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { AuthUser } from '../auth/users.ts';
import type { Db } from '../db/client.ts';
import { DomainError } from '../domain/errors.ts';
import { Presenter } from './present.ts';
import { run, toErrorResult, type Reply } from './result.ts';

const ref = (what: string) =>
	z.union([z.string().trim().min(1), z.number().int().positive()], {
		error: `expected ${what} as a string, or an id as a JSON number`
	});

export const ticketRef = ref('a Ticket key').describe(
	'Ticket key in any case, e.g. "AM-12", a former key (Alias) included; or the internal id as a JSON number'
);
export const projectRef = ref('a Project key').describe(
	'Project key, a former key included; or the id as a JSON number'
);
export const userRef = ref('a username').describe(
	'Username, or "me" for you; or the id as a JSON number'
);
export const stateRef = ref('a State key').describe(
	'State key within the Project, e.g. "todo"; or the id as a JSON number'
);
export const substateRef = ref('a Substate key').describe(
	'Substate key within its State; or the id as a JSON number'
);
export const questRef = z
	.number({ error: 'expected a Quest id as a JSON number' })
	.int()
	.positive()
	.describe('Quest id');

export const placementShape = {
	position: z.enum(['top', 'bottom']).optional().describe('Place at the top or the bottom'),
	before: ticketRef.optional().describe('Place just before this Ticket'),
	after: ticketRef.optional().describe('Place just after this Ticket')
};

export const indexField = z.number().int().min(0);

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

const ANNOTATIONS: Record<ToolKind, ToolAnnotations> = {
	read: { readOnlyHint: true, openWorldHint: false },
	write: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	destroy: { readOnlyHint: false, destructiveHint: true, openWorldHint: false }
};

export type ToolKind = 'read' | 'write' | 'destroy';

type Body = (args: never, present: Presenter) => Reply | Promise<Reply>;

type Registered = {
	listing: Tool;
	schema: z.ZodObject;
	body: Body;
};

export type Tools = {
	db: Db;
	actor: AuthUser;
	define<S extends z.ZodRawShape>(
		name: string,
		spec: { description: string; kind: ToolKind; input: S },
		body: (args: z.output<z.ZodObject<S>>, present: Presenter) => Reply | Promise<Reply>
	): void;
};

export type Registry = {
	tools: Tools;
	list(): Tool[];
	call(name: string, args: unknown): Promise<CallToolResult>;
};

export function toolRegistry(db: Db, actor: AuthUser): Registry {
	const registered = new Map<string, Registered>();
	return {
		tools: {
			db,
			actor,
			define(name, spec, body) {
				const schema = z.strictObject(spec.input);
				const inputSchema = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' });
				registered.set(name, {
					listing: {
						name,
						description: spec.description,
						inputSchema: inputSchema as Tool['inputSchema'],
						annotations: ANNOTATIONS[spec.kind]
					},
					schema,
					body: body as Body
				});
			}
		},
		list: () => [...registered.values()].map((tool) => tool.listing),
		async call(name, args) {
			const tool = registered.get(name);
			if (tool === undefined) {
				return toErrorResult(new DomainError('not_found', `No tool is named "${name}"`));
			}
			const given = args ?? {};
			const parsed = tool.schema.safeParse(given);
			if (!parsed.success) {
				return toErrorResult(invalidArguments(name, tool.schema, given, parsed.error));
			}
			return run(name, () => tool.body(parsed.data as never, new Presenter(db)));
		}
	};
}

function valueAt(value: unknown, path: PropertyKey[]): unknown {
	let at = value;
	for (const key of path) {
		if (at === null || typeof at !== 'object') return undefined;
		at = (at as Record<PropertyKey, unknown>)[key];
	}
	return at;
}

const quoted = (path: PropertyKey[]) => `"${path.map(String).join('.')}"`;

function invalidArguments(
	tool: string,
	schema: z.ZodObject,
	args: unknown,
	error: z.ZodError
): DomainError {
	let unknown = false;
	const problems = error.issues.map((issue) => {
		if (issue.code === 'unrecognized_keys') {
			unknown = true;
			const names = issue.keys.map((key) => quoted([...issue.path, key]));
			return `unknown argument${names.length > 1 ? 's' : ''} ${names.join(', ')}`;
		}
		if (issue.path.length > 0 && valueAt(args, issue.path) === undefined) {
			return `missing argument ${quoted(issue.path)}`;
		}
		const where = issue.path.length > 0 ? `argument ${quoted(issue.path)}: ` : '';
		return `${where}${issue.message}`;
	});
	const known = Object.keys(schema.shape);
	const takes = known.length > 0 ? `takes ${known.join(', ')}` : 'takes no arguments';
	const hint = unknown ? `; ${tool} ${takes}` : '';
	return new DomainError('invalid', `Invalid arguments for ${tool}: ${problems.join('; ')}${hint}`);
}
