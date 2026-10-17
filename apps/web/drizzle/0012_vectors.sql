CREATE TABLE `labour_inputs` (
	`labour_id` integer PRIMARY KEY NOT NULL,
	`input_hash` text NOT NULL,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `labour_vectors` (
	`labour_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`vector` blob NOT NULL,
	`input_hash` text NOT NULL,
	`embedded_at` integer NOT NULL,
	FOREIGN KEY (`labour_id`) REFERENCES `labours`(`id`) ON UPDATE no action ON DELETE cascade
);
