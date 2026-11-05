CREATE TABLE `recurrence_quests` (
	`recurrence_id` integer NOT NULL,
	`quest_id` integer NOT NULL,
	PRIMARY KEY(`recurrence_id`, `quest_id`),
	FOREIGN KEY (`recurrence_id`) REFERENCES `recurrences`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`quest_id`) REFERENCES `quests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm_id` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`owner_id` integer NOT NULL,
	`assignee_id` integer,
	`labels` text DEFAULT '[]' NOT NULL,
	`unit` text NOT NULL,
	`every` integer NOT NULL,
	`starts_on` text NOT NULL,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`labour_id` integer,
	`next_due_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recurrences_every_positive" CHECK("every" >= 1)
);
--> statement-breakpoint
CREATE INDEX `recurrences_realm_idx` ON `recurrences` (`realm_id`);--> statement-breakpoint
CREATE INDEX `recurrences_due_idx` ON `recurrences` (`next_due_at`);--> statement-breakpoint
ALTER TABLE `labours` ADD `recurrence_id` integer REFERENCES recurrences(id) ON DELETE set null;--> statement-breakpoint
CREATE INDEX `labours_recurrence_idx` ON `labours` (`recurrence_id`);