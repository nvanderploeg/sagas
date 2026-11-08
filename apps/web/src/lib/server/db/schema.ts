import { sql } from 'drizzle-orm';
import {
	boolean,
	check,
	doublePrecision,
	foreignKey,
	index,
	integer,
	json,
	jsonb,
	pgTable,
	primaryKey,
	text,
	uniqueIndex,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { bytea, epoch, tsvector } from './types.ts';
import { EVENT_TYPES } from '../events/types.ts';

const id = () => integer('id').primaryKey().generatedByDefaultAsIdentity();

const now = (name = 'created_at') =>
	epoch(name)
		.notNull()
		.$defaultFn(() => new Date());

const timestamp = (name: string) => epoch(name);

export const TABLE_PREFIX = 'sagas_';

export const users = pgTable(
	'sagas_users',
	{
		id: id(),
		kind: text('kind', { enum: ['human', 'agent'] }).notNull(),
		isAdmin: boolean('is_admin').notNull().default(false),
		username: text('username').notNull().unique(),
		displayName: text('display_name').notNull(),
		passwordHash: text('password_hash'),
		mustChangePassword: boolean('must_change_password').notNull().default(false),
		createdAt: now()
	},
	() => [
		check('sagas_users_kind', sql.raw(`"kind" IN ('human', 'agent')`)),
		check('sagas_users_username_lower', sql.raw(`"username" = lower("username")`)),
		check(
			'sagas_users_password_iff_human',
			sql.raw(`("kind" = 'human') = ("password_hash" IS NOT NULL)`)
		),
		check('sagas_users_admin_is_human', sql.raw(`NOT "is_admin" OR "kind" = 'human'`))
	]
);

export const sessions = pgTable(
	'sagas_sessions',
	{
		id: text('id').primaryKey(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: now(),
		expiresAt: timestamp('expires_at').notNull()
	},
	(t) => [index('sagas_sessions_user_idx').on(t.userId)]
);

export const invites = pgTable(
	'sagas_invites',
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
	() => [
		check('sagas_invites_used_pair', sql.raw(`("used_at" IS NULL) = ("used_by_user_id" IS NULL)`))
	]
);

export const apiTokens = pgTable(
	'sagas_api_tokens',
	{
		id: id(),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		tokenHash: text('token_hash').notNull().unique(),
		createdAt: now(),
		lastUsedAt: timestamp('last_used_at'),
		revokedAt: timestamp('revoked_at'),
		expiresAt: timestamp('expires_at'),
		grantId: integer('grant_id')
			.unique()
			.references(() => oauthGrants.id, { onDelete: 'cascade' })
	},
	(t) => [index('sagas_api_tokens_user_idx').on(t.userId)]
);

export const oauthClients = pgTable(
	'sagas_oauth_clients',
	{
		id: text('id').primaryKey(),
		name: text('name').notNull(),
		redirectUris: text('redirect_uris').notNull(),
		authMethod: text('auth_method', {
			enum: ['none', 'client_secret_post', 'client_secret_basic']
		}).notNull(),
		secretHash: text('secret_hash'),
		createdAt: now(),
		// When the client first exchanged a code; null for a client that never connected.
		grantedAt: timestamp('granted_at')
	},
	() => [
		check(
			'sagas_oauth_clients_auth_method',
			sql.raw(`"auth_method" IN ('none', 'client_secret_post', 'client_secret_basic')`)
		),
		check(
			'sagas_oauth_clients_secret_iff_confidential',
			sql.raw(`("auth_method" = 'none') = ("secret_hash" IS NULL)`)
		),
		check('sagas_oauth_clients_redirect_uris_json', sql.raw(`"redirect_uris"::json IS NOT NULL`))
	]
);

export const oauthGrants = pgTable(
	'sagas_oauth_grants',
	{
		id: id(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClients.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		createdAt: now(),
		revokedAt: timestamp('revoked_at')
	},
	(t) => [
		index('sagas_oauth_grants_client_idx').on(t.clientId),
		index('sagas_oauth_grants_user_idx').on(t.userId)
	]
);

export const oauthCodes = pgTable(
	'sagas_oauth_codes',
	{
		codeHash: text('code_hash').primaryKey(),
		clientId: text('client_id')
			.notNull()
			.references(() => oauthClients.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		redirectUri: text('redirect_uri').notNull(),
		codeChallenge: text('code_challenge').notNull(),
		createdAt: now(),
		expiresAt: timestamp('expires_at').notNull(),
		usedAt: timestamp('used_at'),
		grantId: integer('grant_id').references(() => oauthGrants.id, { onDelete: 'set null' })
	},
	(t) => [
		index('sagas_oauth_codes_client_idx').on(t.clientId),
		index('sagas_oauth_codes_user_idx').on(t.userId)
	]
);

export const oauthRefreshTokens = pgTable(
	'sagas_oauth_refresh_tokens',
	{
		tokenHash: text('token_hash').primaryKey(),
		grantId: integer('grant_id')
			.notNull()
			.references(() => oauthGrants.id, { onDelete: 'cascade' }),
		createdAt: now(),
		expiresAt: timestamp('expires_at').notNull(),
		usedAt: timestamp('used_at')
	},
	(t) => [index('sagas_oauth_refresh_tokens_grant_idx').on(t.grantId)]
);

export const realms = pgTable(
	'sagas_realms',
	{
		id: id(),
		name: text('name').notNull(),
		key: text('key').notNull().unique(),
		labourCounter: integer('labour_counter').notNull().default(0),
		initialStateId: integer('initial_state_id')
	},
	(t) => [
		check('sagas_realms_key_format', sql.raw(`"key" ~ '^[A-Z][A-Z0-9]{1,5}$'`)),
		check('sagas_realms_counter_non_negative', sql.raw(`"labour_counter" >= 0`)),
		foreignKey({
			columns: [t.id, t.initialStateId],
			foreignColumns: [states.realmId, states.id]
		})
	]
);

// One User's role in one Realm, per the product/realm-access Scroll. `pending` is an Offer: it grants nothing.
export const realmMembers = pgTable(
	'sagas_realm_members',
	{
		realmId: integer('realm_id')
			.notNull()
			.references(() => realms.id, { onDelete: 'cascade' }),
		userId: integer('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		role: text('role', { enum: ['owner', 'editor', 'viewer'] }).notNull(),
		status: text('status', { enum: ['pending', 'active'] }).notNull(),
		invitedBy: integer('invited_by').references(() => users.id, { onDelete: 'set null' }),
		createdAt: now(),
		acceptedAt: timestamp('accepted_at')
	},
	(t) => [
		primaryKey({ columns: [t.realmId, t.userId] }),
		index('sagas_realm_members_user_idx').on(t.userId, t.status),
		check('sagas_realm_members_role', sql.raw(`"role" IN ('owner', 'editor', 'viewer')`)),
		check('sagas_realm_members_status', sql.raw(`"status" IN ('pending', 'active')`)),
		check(
			'sagas_realm_members_accepted',
			sql.raw(`("status" = 'active') = ("accepted_at" IS NOT NULL)`)
		)
	]
);

// Every key a Realm has held, its current one included.
export const realmKeys = pgTable(
	'sagas_realm_keys',
	{
		key: text('key').primaryKey(),
		realmId: integer('realm_id')
			.notNull()
			.references((): AnyPgColumn => realms.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		index('sagas_realm_keys_realm_idx').on(t.realmId),
		check('sagas_realm_keys_format', sql.raw(`"key" ~ '^[A-Z][A-Z0-9]{1,5}$'`))
	]
);

export const states = pgTable(
	'sagas_states',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references((): AnyPgColumn => realms.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		label: text('label').notNull(),
		color: text('color').notNull(),
		icon: text('icon').notNull(),
		position: integer('position').notNull(),
		isClosed: boolean('is_closed').notNull().default(false),
		isOpen: boolean('is_open').notNull().default(true),
		defaultSubstateId: integer('default_substate_id').references((): AnyPgColumn => substates.id, {
			onDelete: 'set null'
		})
	},
	(t) => [
		uniqueIndex('sagas_states_realm_key_uq').on(t.realmId, t.key),
		uniqueIndex('sagas_states_realm_position_uq').on(t.realmId, t.position),
		uniqueIndex('sagas_states_realm_id_uq').on(t.realmId, t.id),
		uniqueIndex('sagas_states_one_closed_uq').on(t.realmId).where(sql.raw(`"is_closed"`)),
		// The column FK clears the default with its Substate; this one keeps it within the State.
		foreignKey({
			columns: [t.id, t.defaultSubstateId],
			foreignColumns: [substates.stateId, substates.id]
		})
	]
);

// A hint that a Labour in `fromStateId` usually moves next to `toStateId`; moves are never restricted.
export const stateFlows = pgTable(
	'sagas_state_flows',
	{
		fromStateId: integer('from_state_id')
			.notNull()
			.references((): AnyPgColumn => states.id, { onDelete: 'cascade' }),
		toStateId: integer('to_state_id')
			.notNull()
			.references((): AnyPgColumn => states.id, { onDelete: 'cascade' })
	},
	(t) => [
		primaryKey({ columns: [t.fromStateId, t.toStateId] }),
		check('sagas_state_flows_distinct', sql.raw(`"from_state_id" <> "to_state_id"`))
	]
);

export const substates = pgTable(
	'sagas_substates',
	{
		id: id(),
		stateId: integer('state_id')
			.notNull()
			.references((): AnyPgColumn => states.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		label: text('label').notNull(),
		color: text('color').notNull(),
		icon: text('icon').notNull(),
		position: integer('position').notNull()
	},
	(t) => [
		uniqueIndex('sagas_substates_state_key_uq').on(t.stateId, t.key),
		uniqueIndex('sagas_substates_state_position_uq').on(t.stateId, t.position),
		uniqueIndex('sagas_substates_state_id_uq').on(t.stateId, t.id)
	]
);

export const labours = pgTable(
	'sagas_labours',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references((): AnyPgColumn => realms.id, { onDelete: 'cascade' }),
		number: integer('number').notNull(),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		ownerId: integer('owner_id')
			.notNull()
			.references(() => users.id),
		assigneeId: integer('assignee_id').references(() => users.id),
		stateId: integer('state_id').notNull(),
		substateId: integer('substate_id'),
		parentId: integer('parent_id').references((): AnyPgColumn => labours.id, {
			onDelete: 'set null'
		}),
		// A fractional index ordering the State's column; keep COLLATE "C".
		rank: text('rank').notNull(),
		// Sorted and deduplicated; the format is LABEL in domain/labels.ts.
		labels: jsonb('labels')
			.notNull()
			.$type<string[]>()
			.default(sql`'[]'::jsonb`),
		// The Recurrence that created this Labour.
		recurrenceId: integer('recurrence_id').references((): AnyPgColumn => recurrences.id, {
			onDelete: 'set null'
		}),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [
		index('sagas_labours_recurrence_idx').on(t.recurrenceId),
		uniqueIndex('sagas_labours_realm_number_uq').on(t.realmId, t.number),
		uniqueIndex('sagas_labours_realm_id_uq').on(t.realmId, t.id),
		index('sagas_labours_parent_idx').on(t.parentId),
		uniqueIndex('sagas_labours_state_rank_uq').on(t.stateId, t.rank),
		foreignKey({
			columns: [t.realmId, t.stateId],
			foreignColumns: [states.realmId, states.id]
		}),
		foreignKey({
			columns: [t.stateId, t.substateId],
			foreignColumns: [substates.stateId, substates.id]
		}),
		check('sagas_labours_number_positive', sql.raw(`"number" >= 1`))
	]
);

// Every key a Labour has held, its current one included.
export const labourKeys = pgTable(
	'sagas_labour_keys',
	{
		key: text('key').primaryKey(),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		index('sagas_labour_keys_labour_idx').on(t.labourId),
		check('sagas_labour_keys_format', sql.raw(`"key" ~ '^[A-Z][A-Z0-9]*-[1-9][0-9]*$'`))
	]
);

export const comments = pgTable(
	'sagas_comments',
	{
		id: id(),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id),
		body: text('body').notNull(),
		// The API token's name when set through one.
		via: text('via'),
		createdAt: now(),
		// Null until the body is edited.
		updatedAt: timestamp('updated_at')
	},
	(t) => [index('sagas_comments_labour_idx').on(t.labourId, t.id)]
);

// A Quest belongs to one Realm, which decides who may see and edit it. Its Labours may be in any
// Realm.
export const quests = pgTable(
	'sagas_quests',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references(() => realms.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		description: text('description').notNull().default(''),
		ownerId: integer('owner_id')
			.notNull()
			.references(() => users.id),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [index('sagas_quests_realm_idx').on(t.realmId)]
);

export const questLabours = pgTable(
	'sagas_quest_labours',
	{
		questId: integer('quest_id')
			.notNull()
			.references(() => quests.id, { onDelete: 'cascade' }),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		// A fractional index ordering the Quest; keep COLLATE "C".
		rank: text('rank').notNull(),
		addedAt: now('added_at')
	},
	(t) => [
		primaryKey({ columns: [t.questId, t.labourId] }),
		uniqueIndex('sagas_quest_labours_quest_rank_uq').on(t.questId, t.rank),
		index('sagas_quest_labours_labour_idx').on(t.labourId)
	]
);

// A schedule that creates a Labour in its Realm each time the last one is finished and the next
// occurrence comes round.
export const recurrences = pgTable(
	'sagas_recurrences',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references(() => realms.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		description: text('description').notNull().default(''),
		ownerId: integer('owner_id')
			.notNull()
			.references(() => users.id),
		assigneeId: integer('assignee_id').references(() => users.id),
		labels: jsonb('labels')
			.notNull()
			.$type<string[]>()
			.default(sql`'[]'::jsonb`),
		unit: text('unit', { enum: ['day', 'week', 'month', 'year'] }).notNull(),
		every: integer('every').notNull(),
		// The first occurrence, a local calendar date YYYY-MM-DD in `timezone`.
		startsOn: text('starts_on').notNull(),
		// An IANA zone name.
		timezone: text('timezone').notNull().default('UTC'),
		paused: boolean('paused').notNull().default(false),
		// The Labour created last. Null before the first, and after it is deleted.
		labourId: integer('labour_id').references((): AnyPgColumn => labours.id, {
			onDelete: 'set null'
		}),
		// When the next Labour is due. Null while the last one is unfinished.
		nextDueAt: timestamp('next_due_at'),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [
		index('sagas_recurrences_realm_idx').on(t.realmId),
		index('sagas_recurrences_due_idx').on(t.nextDueAt),
		check('sagas_recurrences_every_positive', sql.raw(`"every" >= 1`))
	]
);

// The Quests each new Labour of a Recurrence is added to.
export const recurrenceQuests = pgTable(
	'sagas_recurrence_quests',
	{
		recurrenceId: integer('recurrence_id')
			.notNull()
			.references(() => recurrences.id, { onDelete: 'cascade' }),
		questId: integer('quest_id')
			.notNull()
			.references(() => quests.id, { onDelete: 'cascade' })
	},
	(t) => [primaryKey({ columns: [t.recurrenceId, t.questId] })]
);

// A page of a Realm's wiki, per docs/scrolls.md.
export const scrolls = pgTable(
	'sagas_scrolls',
	{
		id: id(),
		realmId: integer('realm_id')
			.notNull()
			.references(() => realms.id, { onDelete: 'cascade' }),
		parentId: integer('parent_id').references((): AnyPgColumn => scrolls.id, {
			onDelete: 'cascade'
		}),
		slug: text('slug').notNull(),
		// The current Path; scroll_paths holds it and every earlier one.
		path: text('path').notNull(),
		title: text('title').notNull(),
		body: text('body').notNull().default(''),
		// A fractional index ordering the siblings; keep COLLATE "C".
		rank: text('rank').notNull(),
		version: integer('version').notNull().default(1),
		createdById: integer('created_by_id')
			.notNull()
			.references(() => users.id),
		updatedById: integer('updated_by_id')
			.notNull()
			.references(() => users.id),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [
		uniqueIndex('sagas_scrolls_realm_path_uq').on(t.realmId, t.path),
		uniqueIndex('sagas_scrolls_sibling_rank_uq').on(
			t.realmId,
			sql`coalesce(${t.parentId}, 0)`,
			t.rank
		),
		index('sagas_scrolls_parent_idx').on(t.parentId),
		check(
			'sagas_scrolls_slug_format',
			sql.raw(`length("slug") BETWEEN 1 AND 64 AND "slug" ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$'`)
		),
		check('sagas_scrolls_version_positive', sql.raw(`"version" >= 1`))
	]
);

// Every Path a Scroll has held, its current one included.
export const scrollPaths = pgTable(
	'sagas_scroll_paths',
	{
		realmId: integer('realm_id')
			.notNull()
			.references(() => realms.id, { onDelete: 'cascade' }),
		path: text('path').notNull(),
		scrollId: integer('scroll_id')
			.notNull()
			.references(() => scrolls.id, { onDelete: 'cascade' }),
		createdAt: now()
	},
	(t) => [
		primaryKey({ columns: [t.realmId, t.path] }),
		index('sagas_scroll_paths_scroll_idx').on(t.scrollId)
	]
);

// What a Scroll's body names, per docs/scrolls.md: one of a Scroll link's target, a Labour or a User.
export const scrollRefs = pgTable(
	'sagas_scroll_refs',
	{
		id: id(),
		scrollId: integer('scroll_id')
			.notNull()
			.references(() => scrolls.id, { onDelete: 'cascade' }),
		// A normalized Path in the source Scroll's Realm, which may name no Scroll yet.
		targetPath: text('target_path'),
		labourId: integer('labour_id').references(() => labours.id, { onDelete: 'cascade' }),
		userId: integer('user_id').references(() => users.id, { onDelete: 'cascade' }),
		firstSeenAt: epoch('first_seen_at').notNull()
	},
	(t) => [
		uniqueIndex('sagas_scroll_refs_target_uq').on(
			t.scrollId,
			sql`coalesce(${t.targetPath}, '')`,
			sql`coalesce(${t.labourId}, 0)`,
			sql`coalesce(${t.userId}, 0)`
		),
		index('sagas_scroll_refs_path_idx').on(t.targetPath),
		index('sagas_scroll_refs_labour_idx').on(t.labourId),
		check(
			'sagas_scroll_refs_one_target',
			sql.raw(
				`("target_path" IS NOT NULL)::int + ("labour_id" IS NOT NULL)::int + ("user_id" IS NOT NULL)::int = 1`
			)
		)
	]
);

export const events = pgTable(
	'sagas_events',
	{
		// Allocated from event_counter inside the writing transaction.
		seq: integer('seq').primaryKey(),
		type: text('type', { enum: EVENT_TYPES }).notNull(),
		actorId: integer('actor_id')
			.notNull()
			.references(() => users.id),
		// The API token the write came through; null for a session. `tokenName` is the name it
		// had then, kept after the token is revoked or renamed.
		tokenId: integer('token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
		tokenName: text('token_name'),
		createdAt: now(),
		// The type's payload in docs/events.md.
		data: json('data').notNull().$type<unknown>()
	},
	(t) => [index('sagas_events_created_idx').on(t.createdAt)]
);

// The newest seq ever assigned, pruned Events included. One row.
export const eventCounter = pgTable(
	'sagas_event_counter',
	{
		id: integer('id').primaryKey().default(1),
		last: integer('last').notNull().default(0)
	},
	() => [check('sagas_event_counter_single', sql.raw(`"id" = 1`))]
);

// The Realms an Event touches, per docs/webhooks.md. realmId has no foreign key: a deleted
// Realm's id stays for the Events that touched it.
export const eventRealms = pgTable(
	'sagas_event_realms',
	{
		seq: integer('seq')
			.notNull()
			.references(() => events.seq, { onDelete: 'cascade' }),
		realmId: integer('realm_id').notNull()
	},
	(t) => [
		primaryKey({ columns: [t.seq, t.realmId] }),
		index('sagas_event_realms_realm_idx').on(t.realmId)
	]
);

// A Realm's settings for agents, per docs/agent-layer-data.md. No row reads as version 0.
export const realmAgent = pgTable(
	'sagas_realm_agent',
	{
		realmId: integer('realm_id')
			.primaryKey()
			.references(() => realms.id, { onDelete: 'cascade' }),
		version: integer('version').notNull(),
		notes: text('notes').notNull().default(''),
		halfLifeDays: doublePrecision('half_life_days').notNull().default(14),
		loudness: doublePrecision('loudness').notNull().default(5),
		updatedAt: now('updated_at')
	},
	() => [
		check('sagas_realm_agent_version', sql.raw(`"version" >= 1`)),
		check(
			'sagas_realm_agent_half_life',
			sql.raw(`"half_life_days" > 0 AND "half_life_days" <= 365`)
		),
		check('sagas_realm_agent_loudness', sql.raw(`"loudness" > 0`))
	]
);

export const attributes = pgTable(
	'sagas_attributes',
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
		spec: json('spec').notNull().$type<unknown>(),
		// No >= 0 check: writePositions parks rows on negative positions.
		position: integer('position').notNull(),
		createdAt: now(),
		revisedAt: now('revised_at'),
		updatedAt: now('updated_at')
	},
	(t) => [
		uniqueIndex('sagas_attributes_realm_key_uq').on(t.realmId, t.key),
		uniqueIndex('sagas_attributes_realm_position_uq').on(t.realmId, t.position),
		uniqueIndex('sagas_attributes_realm_id_uq').on(t.realmId, t.id),
		check('sagas_attributes_key_format', sql.raw(`"key" ~ '^[a-z][a-z0-9-]{0,31}$'`)),
		check('sagas_attributes_kind', sql.raw(`"kind" IN ('scale', 'tags', 'text')`))
	]
);

export const labourAttributes = pgTable(
	'sagas_labour_attributes',
	{
		realmId: integer('realm_id').notNull(),
		labourId: integer('labour_id').notNull(),
		attributeId: integer('attribute_id').notNull(),
		// By the Attribute's kind; the shapes are in docs/agent-layer-data.md.
		value: json('value').notNull().$type<unknown>(),
		setBy: integer('set_by')
			.notNull()
			.references(() => users.id),
		via: text('via'),
		setAt: now('set_at')
	},
	(t) => [
		primaryKey({ columns: [t.labourId, t.attributeId] }),
		index('sagas_labour_attributes_attribute_idx').on(t.attributeId),
		foreignKey({
			columns: [t.realmId, t.labourId],
			foreignColumns: [labours.realmId, labours.id]
		}).onDelete('cascade'),
		foreignKey({
			columns: [t.realmId, t.attributeId],
			foreignColumns: [attributes.realmId, attributes.id]
		}).onDelete('cascade')
	]
);

// A Labour's Brief, References and stamp, per docs/agent-layer-data.md. No row reads as unappraised.
export const appraisals = pgTable(
	'sagas_appraisals',
	{
		labourId: integer('labour_id')
			.primaryKey()
			.references(() => labours.id, { onDelete: 'cascade' }),
		brief: text('brief').notNull().default(''),
		// Reference[]; the shape is in docs/agent-layer-data.md.
		refs: json('refs').notNull().$type<unknown>().default([]),
		// Null until a brief or refs write.
		setBy: integer('set_by').references(() => users.id),
		setAt: timestamp('set_at'),
		via: text('via'),
		contentHash: text('content_hash'),
		appraisedBy: integer('appraised_by').references(() => users.id),
		appraisedAt: timestamp('appraised_at'),
		appraisedVia: text('appraised_via')
	},
	() => [
		check(
			'sagas_appraisals_stamp_set',
			sql.raw(
				`("content_hash" IS NULL) = ("appraised_by" IS NULL) AND ("appraised_by" IS NULL) = ("appraised_at" IS NULL)`
			)
		)
	]
);

// A typed connection between two Labours, per docs/agent-layer-data.md.
export const links = pgTable(
	'sagas_links',
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
		via: text('via'),
		setAt: now('set_at')
	},
	(t) => [
		primaryKey({ columns: [t.fromId, t.toId, t.type] }),
		index('sagas_links_to_type_idx').on(t.toId, t.type),
		check('sagas_links_distinct', sql.raw(`"from_id" <> "to_id"`)),
		check('sagas_links_relates_ordered', sql.raw(`"type" <> 'relates' OR "from_id" < "to_id"`)),
		check('sagas_links_type', sql.raw(`"type" IN ('evidence', 'blocks', 'relates', 'duplicates')`))
	]
);

// The version of the build rules each derived structure follows, per docs/agent-layer-data.md.
export const derivedBuilds = pgTable('sagas_derived_builds', {
	name: text('name', { enum: ['labour_text', 'mentions', 'embedding_inputs'] }).primaryKey(),
	version: integer('version').notNull(),
	builtAt: now('built_at')
});

// A Labour key or username found in a Labour's description or a Comment, per docs/agent-layer-data.md.
export const mentions = pgTable(
	'sagas_mentions',
	{
		id: id(),
		sourceLabourId: integer('source_labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		// Null when the Mention is in the description.
		commentId: integer('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
		labourId: integer('labour_id').references(() => labours.id, { onDelete: 'cascade' }),
		userId: integer('user_id').references(() => users.id),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id),
		firstSeenAt: epoch('first_seen_at').notNull()
	},
	(t) => [
		uniqueIndex('sagas_mentions_source_target_uq').on(
			t.sourceLabourId,
			sql`coalesce(${t.commentId}, 0)`,
			sql`coalesce(${t.labourId}, 0)`,
			sql`coalesce(${t.userId}, 0)`
		),
		index('sagas_mentions_labour_idx').on(t.labourId, t.firstSeenAt),
		index('sagas_mentions_user_idx').on(t.userId, t.firstSeenAt),
		check('sagas_mentions_one_target', sql.raw(`("labour_id" IS NULL) <> ("user_id" IS NULL)`)),
		check(
			'sagas_mentions_not_self',
			sql.raw(`"labour_id" IS NULL OR "labour_id" <> "source_labour_id"`)
		)
	]
);

// One report into a Realm's Sentiment or a User's Affinity, per docs/agent-layer-data.md.
export const pulses = pgTable(
	'sagas_pulses',
	{
		id: id(),
		realmId: integer('realm_id').references(() => realms.id, { onDelete: 'cascade' }),
		userId: integer('user_id').references(() => users.id),
		// Null while unfiled.
		attributeId: integer('attribute_id').references(() => attributes.id, { onDelete: 'cascade' }),
		// The member key of a tags Attribute; null otherwise.
		member: text('member'),
		rawKey: text('raw_key').notNull(),
		amount: doublePrecision('amount').notNull(),
		mood: doublePrecision('mood').notNull(),
		// Null never fades.
		halfLifeDays: doublePrecision('half_life_days'),
		note: text('note').notNull().default(''),
		// Evidence[]; the shape is in docs/agent-layer-data.md.
		evidence: json('evidence').notNull().$type<unknown>().default([]),
		ref: text('ref'),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id),
		via: text('via'),
		createdAt: now()
	},
	(t) => [
		uniqueIndex('sagas_pulses_author_ref_key_uq')
			.on(t.authorId, t.ref, t.rawKey)
			.where(sql.raw(`"ref" IS NOT NULL`)),
		index('sagas_pulses_realm_attribute_idx').on(t.realmId, t.attributeId, t.member),
		index('sagas_pulses_user_attribute_idx').on(t.userId, t.attributeId, t.member),
		index('sagas_pulses_unfiled_idx')
			.on(t.realmId, t.rawKey)
			.where(sql.raw(`"attribute_id" IS NULL`)),
		index('sagas_pulses_created_idx').on(t.createdAt),
		check('sagas_pulses_one_owner', sql.raw(`("realm_id" IS NULL) <> ("user_id" IS NULL)`)),
		check(
			'sagas_pulses_unfiled_is_sentiment',
			sql.raw(`"attribute_id" IS NOT NULL OR ("member" IS NULL AND "realm_id" IS NOT NULL)`)
		),
		check('sagas_pulses_amount', sql.raw(`"amount" > 0 AND "amount" <= 10`)),
		check('sagas_pulses_mood', sql.raw(`"mood" >= -1 AND "mood" <= 1`)),
		check(
			'sagas_pulses_half_life',
			sql.raw(`"half_life_days" IS NULL OR ("half_life_days" > 0 AND "half_life_days" <= 365)`)
		)
	]
);

// A scored request and what it returned, per docs/agent-layer-data.md.
export const surveys = pgTable(
	'sagas_surveys',
	{
		id: id(),
		actorId: integer('actor_id')
			.notNull()
			.references(() => users.id),
		forId: integer('for_id')
			.notNull()
			.references(() => users.id),
		request: json('request').notNull().$type<unknown>(),
		// Results; the shape is in docs/agent-layer-data.md.
		results: json('results').notNull().$type<unknown>(),
		createdAt: now()
	},
	(t) => [index('sagas_surveys_created_idx').on(t.createdAt)]
);

// What became of a Labour a Survey returned, per docs/agent-layer-data.md.
export const outcomes = pgTable(
	'sagas_outcomes',
	{
		surveyId: integer('survey_id')
			.notNull()
			.references(() => surveys.id, { onDelete: 'cascade' }),
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		verdict: text('verdict', { enum: ['picked', 'skipped', 'done'] }).notNull(),
		authorId: integer('author_id')
			.notNull()
			.references(() => users.id),
		via: text('via'),
		createdAt: now()
	},
	(t) => [
		primaryKey({ columns: [t.surveyId, t.labourId, t.verdict] }),
		index('sagas_outcomes_labour_idx').on(t.labourId),
		check('sagas_outcomes_verdict', sql.raw(`"verdict" IN ('picked', 'skipped', 'done')`))
	]
);

// An ability named once for the instance, per docs/agent-layer-data.md.
export const skills = pgTable(
	'sagas_skills',
	{
		id: id(),
		key: text('key').notNull().unique(),
		label: text('label').notNull(),
		rubric: text('rubric').notNull().default(''),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	() => [
		check('sagas_skills_key_format', sql.raw(`"key" ~ '^[a-z][a-z0-9-]{0,31}$'`)),
		check('sagas_skills_label_length', sql.raw(`length("label") BETWEEN 1 AND 64`)),
		check('sagas_skills_rubric_length', sql.raw(`length("rubric") <= 4000`))
	]
);

export const userSkills = pgTable(
	'sagas_user_skills',
	{
		userId: integer('user_id')
			.notNull()
			.references(() => users.id),
		skillId: integer('skill_id')
			.notNull()
			.references(() => skills.id, { onDelete: 'cascade' }),
		level: integer('level').notNull(),
		setBy: integer('set_by')
			.notNull()
			.references(() => users.id),
		via: text('via'),
		setAt: now('set_at')
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.skillId] }),
		check('sagas_user_skills_level', sql.raw(`"level" BETWEEN 1 AND 5`))
	]
);

// A Labour needs at most 8, held by the domain.
export const labourNeeds = pgTable(
	'sagas_labour_needs',
	{
		labourId: integer('labour_id')
			.notNull()
			.references(() => labours.id, { onDelete: 'cascade' }),
		skillId: integer('skill_id')
			.notNull()
			.references(() => skills.id, { onDelete: 'cascade' }),
		level: integer('level').notNull(),
		setBy: integer('set_by')
			.notNull()
			.references(() => users.id),
		via: text('via'),
		setAt: now('set_at')
	},
	(t) => [
		primaryKey({ columns: [t.labourId, t.skillId] }),
		check('sagas_labour_needs_level', sql.raw(`"level" BETWEEN 1 AND 5`))
	]
);

// A Labour's embedding, per docs/agent-layer-data.md. Derived: a missing or stale row is rebuilt.
export const labourVectors = pgTable('sagas_labour_vectors', {
	labourId: integer('labour_id')
		.primaryKey()
		.references(() => labours.id, { onDelete: 'cascade' }),
	model: text('model').notNull(),
	vector: bytea('vector').notNull(),
	inputHash: text('input_hash').notNull(),
	embeddedAt: now('embedded_at')
});

// The hash of a Labour's embedding input as its text stands, per docs/agent-layer-data.md.
export const labourInputs = pgTable('sagas_labour_inputs', {
	labourId: integer('labour_id')
		.primaryKey()
		.references(() => labours.id, { onDelete: 'cascade' }),
	inputHash: text('input_hash').notNull()
});

export const webhooks = pgTable(
	'sagas_webhooks',
	{
		id: id(),
		ownerId: integer('owner_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		name: text('name').notNull(),
		url: text('url').notNull(),
		eventTypes: text('event_types'),
		realmIds: text('realm_ids'),
		status: text('status', { enum: ['active', 'paused', 'disabled'] })
			.notNull()
			.default('active'),
		statusReason: text('status_reason', { enum: ['key_changed', 'failing'] }),
		cursor: integer('cursor').notNull(),
		secret: text('secret').notNull(),
		previousSecret: text('previous_secret'),
		previousSecretExpiresAt: timestamp('previous_secret_expires_at'),
		failingSince: timestamp('failing_since'),
		attempts: integer('attempts').notNull().default(0),
		nextAttemptAt: timestamp('next_attempt_at'),
		createdAt: now(),
		updatedAt: now('updated_at')
	},
	(t) => [index('sagas_webhooks_owner_idx').on(t.ownerId)]
);

export const webhookDeliveries = pgTable(
	'sagas_webhook_deliveries',
	{
		id: id(),
		webhookId: integer('webhook_id')
			.notNull()
			.references(() => webhooks.id, { onDelete: 'cascade' }),
		attemptedAt: epoch('attempted_at').notNull(),
		messageId: text('message_id').notNull(),
		kind: text('kind', { enum: ['events', 'reset', 'ping'] }).notNull(),
		firstSeq: integer('first_seq'),
		lastSeq: integer('last_seq'),
		status: integer('status'),
		error: text('error'),
		durationMs: integer('duration_ms').notNull(),
		responseBody: text('response_body')
	},
	(t) => [
		index('sagas_webhook_deliveries_webhook_idx').on(t.webhookId, t.id),
		index('sagas_webhook_deliveries_attempted_idx').on(t.attemptedAt)
	]
);

// Weights: title A, brief B, notes C, description and comments D; keywordScores ranks the classes
// 4:3:2:1.
export const labourText = pgTable(
	'sagas_labour_text',
	{
		labourId: integer('labour_id')
			.primaryKey()
			.references(() => labours.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		brief: text('brief').notNull(),
		description: text('description').notNull(),
		comments: text('comments').notNull(),
		notes: text('notes').notNull(),
		search: tsvector('search').generatedAlwaysAs(
			sql.raw(
				`setweight(to_tsvector('sagas_english', "title"), 'A') || setweight(to_tsvector('sagas_english', "brief"), 'B') || setweight(to_tsvector('sagas_english', "notes"), 'C') || setweight(to_tsvector('sagas_english', "description"), 'D') || setweight(to_tsvector('sagas_english', "comments"), 'D')`
			)
		)
	},
	(t) => [index('sagas_labour_text_search_idx').using('gin', t.search)]
);

// Weights: title A, body B; scrollMatches orders by them.
export const scrollText = pgTable(
	'sagas_scroll_text',
	{
		scrollId: integer('scroll_id')
			.primaryKey()
			.references(() => scrolls.id, { onDelete: 'cascade' }),
		title: text('title').notNull(),
		body: text('body').notNull(),
		search: tsvector('search').generatedAlwaysAs(
			sql.raw(
				`setweight(to_tsvector('sagas_english', "title"), 'A') || setweight(to_tsvector('sagas_english', "body"), 'B')`
			)
		)
	},
	(t) => [index('sagas_scroll_text_search_idx').using('gin', t.search)]
);
