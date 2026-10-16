CREATE TABLE `attributes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`realm_id` integer NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`rubric` text NOT NULL,
	`spec` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	`revised_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attributes_key_format" CHECK("key" GLOB '[a-z]*' AND "key" NOT GLOB '*[^a-z0-9-]*' AND length("key") BETWEEN 1 AND 32),
	CONSTRAINT "attributes_kind" CHECK("kind" IN ('scale', 'tags', 'text')),
	CONSTRAINT "attributes_spec_json" CHECK(json_valid("spec"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attributes_realm_key_uq` ON `attributes` (`realm_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `attributes_realm_position_uq` ON `attributes` (`realm_id`,`position`);--> statement-breakpoint
CREATE UNIQUE INDEX `attributes_realm_id_uq` ON `attributes` (`realm_id`,`id`);--> statement-breakpoint
CREATE TABLE `labour_attributes` (
	`realm_id` integer NOT NULL,
	`labour_id` integer NOT NULL,
	`attribute_id` integer NOT NULL,
	`value` text NOT NULL,
	`set_by` integer NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`labour_id`, `attribute_id`),
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`realm_id`,`labour_id`) REFERENCES `labours`(`realm_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`realm_id`,`attribute_id`) REFERENCES `attributes`(`realm_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "labour_attributes_value_json" CHECK(json_valid("value"))
);
--> statement-breakpoint
CREATE INDEX `labour_attributes_attribute_idx` ON `labour_attributes` (`attribute_id`);--> statement-breakpoint
CREATE TABLE `realm_agent` (
	`realm_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`half_life_days` real DEFAULT 14 NOT NULL,
	`loudness` real DEFAULT 5 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`realm_id`) REFERENCES `realms`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "realm_agent_version" CHECK("version" >= 1),
	CONSTRAINT "realm_agent_half_life" CHECK("half_life_days" > 0 AND "half_life_days" <= 365),
	CONSTRAINT "realm_agent_loudness" CHECK("loudness" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `labours_realm_id_uq` ON `labours` (`realm_id`,`id`);