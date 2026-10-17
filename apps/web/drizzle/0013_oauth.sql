CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`auth_method` text NOT NULL,
	`secret_hash` text,
	`created_at` integer NOT NULL,
	`granted_at` integer,
	CONSTRAINT "oauth_clients_auth_method" CHECK("auth_method" IN ('none', 'client_secret_post', 'client_secret_basic')),
	CONSTRAINT "oauth_clients_secret_iff_confidential" CHECK(("auth_method" = 'none') = ("secret_hash" IS NULL)),
	CONSTRAINT "oauth_clients_redirect_uris_json" CHECK(json_valid("redirect_uris"))
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`grant_id` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `oauth_codes_client_idx` ON `oauth_codes` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_codes_user_idx` ON `oauth_codes` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`client_id` text NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_grants_client_idx` ON `oauth_grants` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_grants_user_idx` ON `oauth_grants` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`grant_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`grant_id`) REFERENCES `oauth_grants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_refresh_tokens_grant_idx` ON `oauth_refresh_tokens` (`grant_id`);--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `api_tokens` ADD `grant_id` integer REFERENCES oauth_grants(id) ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_grant_id_unique` ON `api_tokens` (`grant_id`);