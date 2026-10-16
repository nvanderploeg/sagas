CREATE TABLE `labour_needs` (
	`labour_id` integer NOT NULL,
	`skill_id` integer NOT NULL,
	`level` integer NOT NULL,
	`set_by` integer NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`labour_id`, `skill_id`),
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "labour_needs_level" CHECK("level" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`rubric` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "skills_key_format" CHECK("key" GLOB '[a-z]*' AND "key" NOT GLOB '*[^a-z0-9-]*' AND length("key") BETWEEN 1 AND 32),
	CONSTRAINT "skills_label_length" CHECK(length("label") BETWEEN 1 AND 64),
	CONSTRAINT "skills_rubric_length" CHECK(length("rubric") <= 4000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_key_unique` ON `skills` (`key`);--> statement-breakpoint
CREATE TABLE `user_skills` (
	`user_id` integer NOT NULL,
	`skill_id` integer NOT NULL,
	`level` integer NOT NULL,
	`set_by` integer NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `skill_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skill_id`) REFERENCES `skills`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_skills_level" CHECK("level" BETWEEN 1 AND 5)
);
