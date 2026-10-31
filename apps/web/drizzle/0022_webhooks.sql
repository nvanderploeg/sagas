CREATE TABLE `webhooks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_id` integer NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`event_types` text,
	`realm_ids` text,
	`status` text DEFAULT 'active' NOT NULL,
	`status_reason` text,
	`cursor` integer NOT NULL,
	`secret` text NOT NULL,
	`previous_secret` text,
	`previous_secret_expires_at` integer,
	`failing_since` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhooks_owner_idx` ON `webhooks` (`owner_id`);