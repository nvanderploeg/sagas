CREATE TABLE `event_realms` (
	`seq` integer NOT NULL,
	`realm_id` integer NOT NULL,
	PRIMARY KEY(`seq`, `realm_id`),
	FOREIGN KEY (`seq`) REFERENCES `events`(`seq`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_realms_realm_idx` ON `event_realms` (`realm_id`);