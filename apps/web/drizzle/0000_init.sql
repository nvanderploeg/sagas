CREATE TABLE `api_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_unique` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `api_tokens_user_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`actor_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`data` text NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_created_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE TABLE `invites` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`created_by_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`used_at` integer,
	`used_by_user_id` integer,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invites_used_pair" CHECK(("used_at" IS NULL) = ("used_by_user_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invites_token_hash_unique` ON `invites` (`token_hash`);--> statement-breakpoint
CREATE TABLE `labour_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`labour_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "labour_keys_format" CHECK("key" GLOB '[A-Z]*-[1-9]*' AND "key" NOT GLOB '*[^A-Z0-9-]*' AND "key" NOT GLOB '*-*[^0-9]*')
);
--> statement-breakpoint
CREATE INDEX `labour_keys_labour_idx` ON `labour_keys` (`labour_id`);--> statement-breakpoint
CREATE TABLE `labours` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm_id` integer NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`owner_id` integer NOT NULL,
	`assignee_id` integer,
	`state_id` integer NOT NULL,
	`substate_id` integer,
	`parent_id` integer,
	`rank` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`realm_id`,`state_id`) REFERENCES `states`(`realm_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`state_id`,`substate_id`) REFERENCES `substates`(`state_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "labours_number_positive" CHECK("number" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labours_realm_number_uq` ON `labours` (`realm_id`,`number`);--> statement-breakpoint
CREATE INDEX `labours_parent_idx` ON `labours` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `labours_state_rank_uq` ON `labours` (`state_id`,`rank`);--> statement-breakpoint
CREATE TABLE `quest_labours` (
	`quest_id` integer NOT NULL,
	`labour_id` integer NOT NULL,
	`rank` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`quest_id`, `labour_id`),
	FOREIGN KEY (`quest_id`) REFERENCES `quests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `quest_labours_quest_rank_uq` ON `quest_labours` (`quest_id`,`rank`);--> statement-breakpoint
CREATE INDEX `quest_labours_labour_idx` ON `quest_labours` (`labour_id`);--> statement-breakpoint
CREATE TABLE `quests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`owner_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `realm_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`realm_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "realm_keys_format" CHECK("key" GLOB '[A-Z]*' AND "key" NOT GLOB '*[^A-Z0-9]*' AND length("key") BETWEEN 2 AND 6)
);
--> statement-breakpoint
CREATE INDEX `realm_keys_realm_idx` ON `realm_keys` (`realm_id`);--> statement-breakpoint
CREATE TABLE `realms` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`key` text NOT NULL,
	`labour_counter` integer DEFAULT 0 NOT NULL,
	`initial_state_id` integer,
	FOREIGN KEY (`id`,`initial_state_id`) REFERENCES `states`(`realm_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "realms_key_format" CHECK("key" GLOB '[A-Z]*' AND "key" NOT GLOB '*[^A-Z0-9]*' AND length("key") BETWEEN 2 AND 6),
	CONSTRAINT "realms_counter_non_negative" CHECK("labour_counter" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `realms_key_unique` ON `realms` (`key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `states` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`position` integer NOT NULL,
	`is_closed` integer DEFAULT false NOT NULL,
	`default_substate_id` integer,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`default_substate_id`) REFERENCES `substates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`id`,`default_substate_id`) REFERENCES `substates`(`state_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `states_realm_key_uq` ON `states` (`realm_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `states_realm_position_uq` ON `states` (`realm_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `states_realm_id_uq` ON `states` (`realm_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `states_one_closed_uq` ON `states` (`realm_id`) WHERE "is_closed" = 1;--> statement-breakpoint
CREATE TABLE `substates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`state_id` integer NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`color` text NOT NULL,
	`icon` text NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`state_id`) REFERENCES `states`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `substates_state_key_uq` ON `substates` (`state_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `substates_state_position_uq` ON `substates` (`state_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `substates_state_id_uq` ON `substates` (`state_id`,`id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`password_hash` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "users_kind" CHECK("kind" IN ('human', 'agent')),
	CONSTRAINT "users_username_lower" CHECK("username" = lower("username")),
	CONSTRAINT "users_password_iff_human" CHECK(("kind" = 'human') = ("password_hash" IS NOT NULL)),
	CONSTRAINT "users_admin_is_human" CHECK("is_admin" = 0 OR "kind" = 'human')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);