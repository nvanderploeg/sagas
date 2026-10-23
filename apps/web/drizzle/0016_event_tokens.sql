ALTER TABLE `events` ADD `token_id` integer REFERENCES api_tokens(id);--> statement-breakpoint
ALTER TABLE `events` ADD `token_name` text;