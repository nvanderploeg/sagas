CREATE TABLE `webhook_deliveries` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`webhook_id` integer NOT NULL,
	`attempted_at` integer NOT NULL,
	`message_id` text NOT NULL,
	`kind` text NOT NULL,
	`first_seq` integer,
	`last_seq` integer,
	`status` integer,
	`error` text,
	`duration_ms` integer NOT NULL,
	`response_body` text,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook_idx` ON `webhook_deliveries` (`webhook_id`,`id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_attempted_idx` ON `webhook_deliveries` (`attempted_at`);