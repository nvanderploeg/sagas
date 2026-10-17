CREATE TABLE `pulses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm_id` integer,
	`user_id` integer,
	`attribute_id` integer,
	`member` text,
	`raw_key` text NOT NULL,
	`amount` real NOT NULL,
	`mood` real NOT NULL,
	`half_life_days` real,
	`note` text DEFAULT '' NOT NULL,
	`evidence` text DEFAULT '[]' NOT NULL,
	`ref` text,
	`author_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attribute_id`) REFERENCES `attributes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pulses_one_owner" CHECK(("realm_id" IS NULL) <> ("user_id" IS NULL)),
	CONSTRAINT "pulses_unfiled_is_sentiment" CHECK("attribute_id" IS NOT NULL OR ("member" IS NULL AND "realm_id" IS NOT NULL)),
	CONSTRAINT "pulses_amount" CHECK("amount" > 0 AND "amount" <= 10),
	CONSTRAINT "pulses_mood" CHECK("mood" >= -1 AND "mood" <= 1),
	CONSTRAINT "pulses_half_life" CHECK("half_life_days" IS NULL OR ("half_life_days" > 0 AND "half_life_days" <= 365)),
	CONSTRAINT "pulses_evidence_json" CHECK(json_valid("evidence"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pulses_author_ref_key_uq` ON `pulses` (`author_id`,`ref`,`raw_key`) WHERE "ref" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pulses_realm_attribute_idx` ON `pulses` (`realm_id`,`attribute_id`,`member`);--> statement-breakpoint
CREATE INDEX `pulses_user_attribute_idx` ON `pulses` (`user_id`,`attribute_id`,`member`);--> statement-breakpoint
CREATE INDEX `pulses_unfiled_idx` ON `pulses` (`realm_id`,`raw_key`) WHERE "attribute_id" IS NULL;--> statement-breakpoint
CREATE INDEX `pulses_created_idx` ON `pulses` (`created_at`);