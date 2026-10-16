CREATE TABLE `surveys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`actor_id` integer NOT NULL,
	`for_id` integer NOT NULL,
	`request` text NOT NULL,
	`results` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`for_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "surveys_request_json" CHECK(json_valid("request")),
	CONSTRAINT "surveys_results_json" CHECK(json_valid("results"))
);
--> statement-breakpoint
CREATE INDEX `surveys_created_idx` ON `surveys` (`created_at`);