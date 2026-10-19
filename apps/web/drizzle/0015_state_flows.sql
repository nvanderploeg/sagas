CREATE TABLE `state_flows` (
	`from_state_id` integer NOT NULL,
	`to_state_id` integer NOT NULL,
	PRIMARY KEY(`from_state_id`, `to_state_id`),
	FOREIGN KEY (`from_state_id`) REFERENCES `states`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_state_id`) REFERENCES `states`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "state_flows_distinct" CHECK("from_state_id" <> "to_state_id")
);
