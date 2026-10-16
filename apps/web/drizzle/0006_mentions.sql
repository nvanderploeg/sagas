CREATE TABLE `derived_builds` (
	`name` text PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`built_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mentions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_labour_id` integer NOT NULL,
	`comment_id` integer,
	`labour_id` integer,
	`user_id` integer,
	`author_id` integer NOT NULL,
	`first_seen_at` integer NOT NULL,
	FOREIGN KEY (`source_labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comment_id`) REFERENCES `comments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "mentions_one_target" CHECK(("labour_id" IS NULL) <> ("user_id" IS NULL)),
	CONSTRAINT "mentions_not_self" CHECK("labour_id" IS NULL OR "labour_id" <> "source_labour_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mentions_source_target_uq` ON `mentions` (`source_labour_id`,(CASE WHEN "comment_id" IS NULL THEN 0 ELSE "comment_id" END),(CASE WHEN "labour_id" IS NULL THEN 0 ELSE "labour_id" END),(CASE WHEN "user_id" IS NULL THEN 0 ELSE "user_id" END));--> statement-breakpoint
CREATE INDEX `mentions_labour_idx` ON `mentions` (`labour_id`,`first_seen_at`);--> statement-breakpoint
CREATE INDEX `mentions_user_idx` ON `mentions` (`user_id`,`first_seen_at`);