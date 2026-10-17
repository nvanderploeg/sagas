CREATE TABLE `outcomes` (
	`survey_id` integer NOT NULL,
	`labour_id` integer NOT NULL,
	`verdict` text NOT NULL,
	`author_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`survey_id`, `labour_id`, `verdict`),
	FOREIGN KEY (`survey_id`) REFERENCES `surveys`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outcomes_verdict" CHECK("verdict" IN ('picked', 'skipped', 'done'))
);
--> statement-breakpoint
CREATE INDEX `outcomes_labour_idx` ON `outcomes` (`labour_id`);