import { sql } from 'drizzle-orm';
import {
	check,
	foreignKey,
	index,
	integer,
	primaryKey,
	real,
	sqliteTable,
	text,
	uniqueIndex,
	type AnySQLiteColumn
} from 'drizzle-orm/sqlite-core';
import { EVENT_TYPES } from '../events/types.ts';

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
		mustChangePassword: integer('must_change_password', { mode: 'boolean' })
			.notNull()
			.default(false),
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

export const realms = sqliteTable(
	'realms',
	{
		id: id(),
		name: text('name').notNull(),
		key: text('key').notNull().unique(),
		labourCounter: integer('labour_counter').notNull().default(0),
		initialStateId: integer('initial_state_id')
	},
	(t) => [
		check(
			'realms_key_format',
			sql.raw(
				`"key" GLOB '[A-Z]*' AND "key" NOT GLOB '*[^A-Z0-9]*' AND length("key") BETWEEN 2 AND 6`
			)
		),
		check('realms_counter_non_negative', sql.raw(`"labour_counter" >= 0`)),
		foreignKey(() => ({
			columns: [t.id, t.initialStateId],
			foreignColumns: [states.realmId, states.id]
		}))
	]
);

// Every key a Realm has held, its current one included.
export const realmKeys = sqliteTable(
	'realm_keys',
	{
		key: text('key').primaryKey(),
		realmId: integer('realm_id')
			.notNull()
			.references((): AnySQLiteColumn => realms.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		index('realm_keys_realm_idx').on(t.realmId),
		check(
			'realm_keys_format',
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
		realmId: integer('realm_id')
			.notNull()
			.references((): AnySQLiteColumn => realms.id, { onDelete: 'cascade' }),
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
		uniqueIndex('states_realm_key_uq').on(t.realmId, t.key),
		uniqueIndex('states_realm_position_uq').on(t.realmId, t.position),
		uniqueIndex('states_realm_id_uq').on(t.realmId, t.id),
		uniqueIndex('states_one_closed_uq').on(t.realmId).where(sql.raw(`"is_closed" = 1`)),
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

export const labours = sqliteTable(
	'labours',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references((): AnySQLiteColumn => realms.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		ownerId: integer('owner_id')
			.notNull()
			.references(() => users.id),
		assigneeId: integer('assignee_id').references(() => users.id),
		stateId: integer('state_id').notNull(),
		substateId: integer('substate_id'),
		parentId: integer('parent_id').references((): AnySQLiteColumn => labours.id, {
			onDelete: 'set null'
		}),
		// A fractional index ordering the State's column; keep the default BINARY collation.
		rank: text('rank').notNull(),
		// Sorted and deduplicated; the format is LABEL in domain/labels.ts.
		labels: text('labels', { mode: 'json' })
			.notNull()
			.$type<string[]>()
			.default(sql`'[]'`),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [
		uniqueIndex('labours_realm_number_uq').on(t.realmId, t.number),
		uniqueIndex('labours_realm_id_uq').on(t.realmId, t.id),
		index('labours_parent_idx').on(t.parentId),
		uniqueIndex('labours_state_rank_uq').on(t.stateId, t.rank),
		foreignKey(() => ({
			columns: [t.realmId, t.stateId],
			foreignColumns: [states.realmId, states.id]
		})),
		foreignKey(() => ({
			columns: [t.stateId, t.substateId],
			foreignColumns: [substates.stateId, substates.id]
		})),
		check('labours_number_positive', sql.raw(`"number" >= 1`))
	]
);

// Every key a Labour has held, its current one included.
export const labourKeys = sqliteTable(
	'labour_keys',
	{
		key: text('key').primaryKey(),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		index('labour_keys_labour_idx').on(t.labourId),
		check(
			'labour_keys_format',
			sql.raw(
				`"key" GLOB '[A-Z]*-[1-9]*' AND "key" NOT GLOB '*[^A-Z0-9-]*' AND "key" NOT GLOB '*-*[^0-9]*'`
			)
		)
	]
);

export const comments = sqliteTable(
	'comments',
	{
		id: id(),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id),
		body: text('body').notNull(),
		createdAt: now(),
		// Null until the body is edited.
		updatedAt: timestamp('updated_at')
	},
	(t) => [index('comments_labour_idx').on(t.labourId, t.id)]
);

export const quests = sqliteTable('quests', {
	id: id(),
	name: text('name').notNull(),
	description: text('description').notNull().default(''),
	ownerId: integer('owner_id')
		.notNull()
		.references(() => users.id),
	createdAt: now(),
	updatedAt: now('updated_at')
});

export const questLabours = sqliteTable(
	'quest_labours',
	{
		questId: integer('quest_id')
			.notNull()
			.references(() => quests.id, { onDelete: 'cascade' }),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		// A fractional index ordering the Quest; keep the default BINARY collation.
		rank: text('rank').notNull(),
		addedAt: now('added_at')
	},
	(t) => [
		primaryKey({ columns: [t.questId, t.labourId] }),
		uniqueIndex('quest_labours_quest_rank_uq').on(t.questId, t.rank),
		index('quest_labours_labour_idx').on(t.labourId)
	]
);

export const events = sqliteTable(
	'events',
	{
		// AUTOINCREMENT keeps seq rising even after pruning empties the table.
		seq: integer('seq').primaryKey({ autoIncrement: true }),
		type: text('type', { enum: EVENT_TYPES }).notNull(),
		actorId: integer('actor_id')
			.notNull()
			.references(() => users.id),
		createdAt: now(),
		// The type's payload in docs/events.md.
		data: text('data', { mode: 'json' }).notNull().$type<unknown>()
	},
	(t) => [index('events_created_idx').on(t.createdAt)]
);

// A Realm's settings for agents, per docs/agent-layer-data.md. No row reads as version 0.
export const realmAgent = sqliteTable(
	'realm_agent',
	{
		realmId: integer('realm_id')
			.primaryKey()
			.references(() => realms.id, { onDelete: 'cascade' }),
		version: integer('version').notNull(),
		notes: text('notes').notNull().default(''),
		halfLifeDays: real('half_life_days').notNull().default(14),
		loudness: real('loudness').notNull().default(5),
		updatedAt: now('updated_at')
	},
	() => [
		check('realm_agent_version', sql.raw(`"version" >= 1`)),
		check('realm_agent_half_life', sql.raw(`"half_life_days" > 0 AND "half_life_days" <= 365`)),
		check('realm_agent_loudness', sql.raw(`"loudness" > 0`))
	]
);

export const attributes = sqliteTable(
	'attributes',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references(() => realms.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		kind: text('kind', { enum: ['scale', 'tags', 'text'] }).notNull(),
		label: text('label').notNull(),
		rubric: text('rubric').notNull(),
		// By kind; the shapes are in docs/agent-layer-data.md.
		spec: text('spec', { mode: 'json' }).notNull().$type<unknown>(),
		// No >= 0 check: writePositions parks rows on negative positions.
		position: integer('position').notNull(),
		createdAt: now(),
		revisedAt: now('revised_at'),
		updatedAt: now('updated_at')
	},
	(t) => [
		uniqueIndex('attributes_realm_key_uq').on(t.realmId, t.key),
		uniqueIndex('attributes_realm_position_uq').on(t.realmId, t.position),
		uniqueIndex('attributes_realm_id_uq').on(t.realmId, t.id),
		check(
			'attributes_key_format',
			sql.raw(
				`"key" GLOB '[a-z]*' AND "key" NOT GLOB '*[^a-z0-9-]*' AND length("key") BETWEEN 1 AND 32`
			)
		),
		check('attributes_kind', sql.raw(`"kind" IN ('scale', 'tags', 'text')`)),
		check('attributes_spec_json', sql.raw(`json_valid("spec")`))
	]
);

export const labourAttributes = sqliteTable(
	'labour_attributes',
	{
		realmId: integer('realm_id').notNull(),
		labourId: integer('labour_id').notNull(),
		attributeId: integer('attribute_id').notNull(),
		// By the Attribute's kind; the shapes are in docs/agent-layer-data.md.
		value: text('value', { mode: 'json' }).notNull().$type<unknown>(),
		setBy: integer('set_by')
			.notNull()
			.references(() => users.id),
		setAt: now('set_at')
	},
	(t) => [
		primaryKey({ columns: [t.labourId, t.attributeId] }),
		index('labour_attributes_attribute_idx').on(t.attributeId),
		foreignKey(() => ({
			columns: [t.realmId, t.labourId],
			foreignColumns: [labours.realmId, labours.id]
		})).onDelete('cascade'),
		foreignKey(() => ({
			columns: [t.realmId, t.attributeId],
			foreignColumns: [attributes.realmId, attributes.id]
		})).onDelete('cascade'),
		check('labour_attributes_value_json', sql.raw(`json_valid("value")`))
	]
);

// A Labour's Brief, References and stamp, per docs/agent-layer-data.md. No row reads as unappraised.
export const appraisals = sqliteTable(
	'appraisals',
	{
		labourId: integer('labour_id')
			.primaryKey()
			.references(() => labours.id, { onDelete: 'cascade' }),
		brief: text('brief').notNull().default(''),
		// Reference[]; the shape is in docs/agent-layer-data.md.
		refs: text('refs', { mode: 'json' }).notNull().$type<unknown>().default([]),
		// Null until a brief or refs write.
		setBy: integer('set_by').references(() => users.id),
		setAt: timestamp('set_at'),
		contentHash: text('content_hash'),
		appraisedBy: integer('appraised_by').references(() => users.id),
		appraisedAt: timestamp('appraised_at')
	},
	() => [
		check('appraisals_refs_json', sql.raw(`json_valid("refs")`)),
		check(
			'appraisals_stamp_set',
			sql.raw(
				`("content_hash" IS NULL) = ("appraised_by" IS NULL) AND ("appraised_by" IS NULL) = ("appraised_at" IS NULL)`
			)
		)
	]
);

// A typed connection between two Labours, per docs/agent-layer-data.md.
export const links = sqliteTable(
	'links',
	{
		fromId: integer('from_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		toId: integer('to_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		type: text('type', { enum: ['evidence', 'blocks', 'relates', 'duplicates'] }).notNull(),
		note: text('note').notNull().default(''),
		setBy: integer('set_by')
			.notNull()
			.references(() => users.id),
		setAt: now('set_at')
	},
	(t) => [
		primaryKey({ columns: [t.fromId, t.toId, t.type] }),
		index('links_to_type_idx').on(t.toId, t.type),
		check('links_distinct', sql.raw(`"from_id" <> "to_id"`)),
		check('links_relates_ordered', sql.raw(`"type" <> 'relates' OR "from_id" < "to_id"`)),
		check('links_type', sql.raw(`"type" IN ('evidence', 'blocks', 'relates', 'duplicates')`))
	]
);
