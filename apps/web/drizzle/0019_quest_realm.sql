ALTER TABLE `quests` ADD `realm_id` integer REFERENCES realms(id) ON DELETE CASCADE;--> statement-breakpoint
UPDATE `quests` SET `realm_id` = COALESCE(
	(SELECT `labours`.`realm_id` FROM `quest_labours`
		JOIN `labours` ON `labours`.`id` = `quest_labours`.`labour_id`
		WHERE `quest_labours`.`quest_id` = `quests`.`id`
		ORDER BY `quest_labours`.`rank` LIMIT 1),
	(SELECT `realm_members`.`realm_id` FROM `realm_members`
		WHERE `realm_members`.`user_id` = `quests`.`owner_id` AND `realm_members`.`status` = 'active'
		ORDER BY `realm_members`.`realm_id` LIMIT 1),
	(SELECT min(`id`) FROM `realms`)
);--> statement-breakpoint
DELETE FROM `quests` WHERE `realm_id` IS NULL;--> statement-breakpoint
CREATE INDEX `quests_realm_idx` ON `quests` (`realm_id`);
