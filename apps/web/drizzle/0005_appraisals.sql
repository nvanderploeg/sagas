CREATE TABLE `appraisals` (
	`labour_id` integer PRIMARY KEY NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`refs` text DEFAULT '[]' NOT NULL,
	`set_by` integer,
	`set_at` integer,
	`content_hash` text,
	`appraised_by` integer,
	`appraised_at` integer,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`appraised_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "appraisals_refs_json" CHECK(json_valid("refs")),
	CONSTRAINT "appraisals_stamp_set" CHECK(("content_hash" IS NULL) = ("appraised_by" IS NULL) AND ("appraised_by" IS NULL) = ("appraised_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `links` (
	`from_id` integer NOT NULL,
	`to_id` integer NOT NULL,
	`type` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`set_by` integer NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`from_id`, `to_id`, `type`),
	FOREIGN KEY (`from_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "links_distinct" CHECK("from_id" <> "to_id"),
	CONSTRAINT "links_relates_ordered" CHECK("type" <> 'relates' OR "from_id" < "to_id"),
	CONSTRAINT "links_type" CHECK("type" IN ('evidence', 'blocks', 'relates', 'duplicates'))
);
--> statement-breakpoint
CREATE INDEX `links_to_type_idx` ON `links` (`to_id`,`type`);