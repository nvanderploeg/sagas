ALTER TABLE "sagas_users" DROP CONSTRAINT "sagas_users_password_iff_human";--> statement-breakpoint
ALTER TABLE "sagas_realms" ADD COLUMN "created_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "sagas_users" ADD COLUMN "firebase_uid" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "sagas_users" ADD COLUMN "email" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "sagas_users" ADD COLUMN "realm_limit" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "sagas_realms" ADD CONSTRAINT "sagas_realms_created_by_user_id_sagas_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."sagas_users"("id") ON DELETE set null ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
CREATE UNIQUE INDEX "sagas_users_email_unique" ON "sagas_users" USING btree ("email") WHERE "sagas_users"."email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "sagas_users" ADD CONSTRAINT "sagas_users_firebase_uid_unique" UNIQUE("firebase_uid");--> statement-breakpoint
ALTER TABLE "sagas_users" ADD CONSTRAINT "sagas_users_realm_limit" CHECK ("realm_limit" >= 0);--> statement-breakpoint
ALTER TABLE "sagas_users" ADD CONSTRAINT "sagas_users_email_lower" CHECK ("email" IS NULL OR "email" = lower("email"));--> statement-breakpoint
ALTER TABLE "sagas_users" ADD CONSTRAINT "sagas_users_agent_has_no_firebase" CHECK ("kind" = 'human' OR "firebase_uid" IS NULL);--> statement-breakpoint
UPDATE "sagas_realms" SET "created_by_user_id" = (
	SELECT "user_id" FROM "sagas_realm_members"
	WHERE "realm_id" = "sagas_realms"."id" AND "role" = 'owner' AND "status" = 'active'
	ORDER BY "created_at", "user_id" LIMIT 1
);
