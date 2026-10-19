ALTER TABLE `states` ADD `is_open` integer DEFAULT true NOT NULL;--> statement-breakpoint
UPDATE `states` SET `is_open` = 0 WHERE `is_closed` = 1;
