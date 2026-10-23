CREATE TABLE `realm_members` (
	`realm_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`status` text NOT NULL,
	`invited_by` integer,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	PRIMARY KEY(`realm_id`, `user_id`),
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "realm_members_role" CHECK("role" IN ('owner', 'editor', 'viewer')),
	CONSTRAINT "realm_members_status" CHECK("status" IN ('pending', 'active')),
	CONSTRAINT "realm_members_accepted" CHECK(("status" = 'active') = ("accepted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `realm_members_user_idx` ON `realm_members` (`user_id`,`status`);--> statement-breakpoint
INSERT INTO `realm_members` (`realm_id`, `user_id`, `role`, `status`, `created_at`, `accepted_at`)
SELECT `realms`.`id`, `admin`.`id`, 'owner', 'active', CAST(strftime('%s', 'now') AS integer) * 1000, CAST(strftime('%s', 'now') AS integer) * 1000
FROM `realms`
JOIN (SELECT `id` FROM `users` WHERE `is_admin` = 1 ORDER BY `id` LIMIT 1) AS `admin`;
