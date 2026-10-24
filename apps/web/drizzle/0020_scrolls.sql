CREATE TABLE `scroll_paths` (
	`realm_id` integer NOT NULL,
	`path` text NOT NULL,
	`scroll_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`realm_id`, `path`),
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`scroll_id`) REFERENCES `scrolls`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `scroll_paths_scroll_idx` ON `scroll_paths` (`scroll_id`);--> statement-breakpoint
CREATE TABLE `scroll_refs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scroll_id` integer NOT NULL,
	`target_path` text,
	`labour_id` integer,
	`user_id` integer,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`scroll_id`) REFERENCES `scrolls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scroll_refs_one_target" CHECK(("target_path" IS NOT NULL) + ("labour_id" IS NOT NULL) + ("user_id" IS NOT NULL) = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scroll_refs_target_uq` ON `scroll_refs` (`scroll_id`,(CASE WHEN "target_path" IS NULL THEN '' ELSE "target_path" END),(CASE WHEN "labour_id" IS NULL THEN 0 ELSE "labour_id" END),(CASE WHEN "user_id" IS NULL THEN 0 ELSE "user_id" END));--> statement-breakpoint
CREATE INDEX `scroll_refs_path_idx` ON `scroll_refs` (`target_path`);--> statement-breakpoint
CREATE INDEX `scroll_refs_labour_idx` ON `scroll_refs` (`labour_id`);--> statement-breakpoint
CREATE TABLE `scrolls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm_id` integer NOT NULL,
	`parent_id` integer,
	`slug` text NOT NULL,
	`path` text NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`rank` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_id` integer NOT NULL,
	`updated_by_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `scrolls`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`updated_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scrolls_slug_format" CHECK(length("slug") BETWEEN 1 AND 64 AND "slug" NOT GLOB '*[^a-z0-9-]*' AND "slug" GLOB '[a-z0-9]*' AND "slug" GLOB '*[a-z0-9]'),
	CONSTRAINT "scrolls_version_positive" CHECK("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `scrolls_realm_path_uq` ON `scrolls` (`realm_id`,`path`);--> statement-breakpoint
CREATE UNIQUE INDEX `scrolls_sibling_rank_uq` ON `scrolls` (`realm_id`,(CASE WHEN "parent_id" IS NULL THEN 0 ELSE "parent_id" END),`rank`);--> statement-breakpoint
CREATE INDEX `scrolls_parent_idx` ON `scrolls` (`parent_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `scroll_text` USING fts5(title, body, tokenize = 'porter unicode61');
