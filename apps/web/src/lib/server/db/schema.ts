import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
	type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';

const id = () => integer('id').primaryKey({ autoIncrement: true });

const now = (name = 'created_at') =>
	integer(name, { mode: 'timestamp_ms' })
		.notNull()
		.$defaultFn(() => new Date());

const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

export const users = sqliteTable(
	'users',
	{
		id: id(),
		kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
		isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
		username: text('username').notNull().unique(),
		displayName: text('display_name').notNull(),
		passwordHash: text('password_hash'),
		createdAt: now()
	},
	() => [
		check('users_kind', sql.raw(`"kind" IN ('human', 'agent')`)),
		check('users_username_lower', sql.raw(`"username" = lower("username")`)),
		check(
			'users_password_iff_human',
			sql.raw(`("kind" = 'human') = ("password_hash" IS NOT NULL)`)
		),
		check('users_admin_is_human', sql.raw(`"is_admin" = 0 OR "kind" = 'human'`))
	]
);

export const sessions = sqliteTable(
	'sessions',
	{
		id: text('id').primaryKey(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: now(),
		expiresAt: timestamp('expires_at').notNull()
	},
	(t) => [index('sessions_user_idx').on(t.userId)]
);

export const invites = sqliteTable(
	'invites',
	{
		id: id(),
		tokenHash: text('token_hash').notNull().unique(),
		createdByUserId: integer('created_by_user_id')
			.notNull()
			.references(() => users.id),
		createdAt: now(),
		usedAt: timestamp('used_at'),
		usedByUserId: integer('used_by_user_id').references(() => users.id)
	},
	() => [check('invites_used_pair', sql.raw(`("used_at" IS NULL) = ("used_by_user_id" IS NULL)`))]
);

export const apiTokens = sqliteTable(
	'api_tokens',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull().unique(),
		createdAt: now(),
		lastUsedAt: timestamp('last_used_at'),
		revokedAt: timestamp('revoked_at')
	},
	(t) => [index('api_tokens_user_idx').on(t.userId)]
);

export const projects = sqliteTable(
	'projects',
	{
		id: id(),
		name: text('name').notNull(),
		key: text('key').notNull().unique(),
		ticketCounter: integer('ticket_counter').notNull().default(0),
		initialStateId: integer('initial_state_id')
	},
	(t) => [
		check(
			'projects_key_format',
			sql.raw(
				`"key" GLOB '[A-Z]*' AND "key" NOT GLOB '*[^A-Z0-9]*' AND length("key") BETWEEN 2 AND 6`
			)
		),
		check('projects_counter_non_negative', sql.raw(`"ticket_counter" >= 0`)),
		foreignKey(() => ({
			columns: [t.id, t.initialStateId],
			foreignColumns: [states.projectId, states.id]
		}))
	]
);

// Every key a Project has held, its current one included.
export const projectKeys = sqliteTable(
	'project_keys',
	{
		key: text('key').primaryKey(),
		projectId: integer('project_id')
			.notNull()
			.references((): AnySQLiteColumn => projects.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		index('project_keys_project_idx').on(t.projectId),
		check(
			'project_keys_format',
			sql.raw(
				`"key" GLOB '[A-Z]*' AND "key" NOT GLOB '*[^A-Z0-9]*' AND length("key") BETWEEN 2 AND 6`
			)
		)
	]
);

export const states = sqliteTable(
	'states',
	{
		id: id(),
		projectId: integer('project_id')
			.notNull()
			.references((): AnySQLiteColumn => projects.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		label: text('label').notNull(),
		color: text('color').notNull(),
		icon: text('icon').notNull(),
		position: integer('position').notNull(),
		isClosed: integer('is_closed', { mode: 'boolean' }).notNull().default(false),
		defaultSubstateId: integer('default_substate_id').references(
			(): AnySQLiteColumn => substates.id,
			{
				onDelete: 'set null'
			}
		)
	},
	(t) => [
		uniqueIndex('states_project_key_uq').on(t.projectId, t.key),
		uniqueIndex('states_project_position_uq').on(t.projectId, t.position),
		uniqueIndex('states_project_id_uq').on(t.projectId, t.id),
		uniqueIndex('states_one_closed_uq').on(t.projectId).where(sql.raw(`"is_closed" = 1`)),
		// The column FK clears the default with its Substate; this one keeps it within the State.
		foreignKey(() => ({
			columns: [t.id, t.defaultSubstateId],
			foreignColumns: [substates.stateId, substates.id]
		}))
	]
);

export const substates = sqliteTable(
	'substates',
	{
		id: id(),
		stateId: integer('state_id')
			.notNull()
			.references((): AnySQLiteColumn => states.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		label: text('label').notNull(),
		color: text('color').notNull(),
		icon: text('icon').notNull(),
		position: integer('position').notNull()
	},
	(t) => [
		uniqueIndex('substates_state_key_uq').on(t.stateId, t.key),
		uniqueIndex('substates_state_position_uq').on(t.stateId, t.position),
		uniqueIndex('substates_state_id_uq').on(t.stateId, t.id)
	]
);

export const tickets = sqliteTable(
	'tickets',
	{
		id: id(),
		projectId: integer('project_id')
			.notNull()
			.references((): AnySQLiteColumn => projects.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		ownerId: integer('owner_id')
			.notNull()
			.references(() => users.id),
		assigneeId: integer('assignee_id').references(() => users.id),
		stateId: integer('state_id').notNull(),
		substateId: integer('substate_id'),
		parentId: integer('parent_id').references((): AnySQLiteColumn => tickets.id, {
			onDelete: 'set null'
		}),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [
		uniqueIndex('tickets_project_number_uq').on(t.projectId, t.number),
		index('tickets_parent_idx').on(t.parentId),
		index('tickets_state_idx').on(t.stateId),
		foreignKey(() => ({
			columns: [t.projectId, t.stateId],
			foreignColumns: [states.projectId, states.id]
		})),
		foreignKey(() => ({
			columns: [t.stateId, t.substateId],
			foreignColumns: [substates.stateId, substates.id]
		})),
		check('tickets_number_positive', sql.raw(`"number" >= 1`))
	]
);

// Every key a Ticket has held, its current one included.
export const ticketKeys = sqliteTable(
	'ticket_keys',
	{
		key: text('key').primaryKey(),
		ticketId: integer('ticket_id')
			.notNull()
			.references(() => tickets.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		index('ticket_keys_ticket_idx').on(t.ticketId),
		check(
			'ticket_keys_format',
			sql.raw(
				`"key" GLOB '[A-Z]*-[1-9]*' AND "key" NOT GLOB '*[^A-Z0-9-]*' AND "key" NOT GLOB '*-*[^0-9]*'`
			)
		)
	]
);
