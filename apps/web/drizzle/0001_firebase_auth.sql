ALTER TABLE "users" DROP CONSTRAINT "users_password_iff_human";--> statement-breakpoint
ALTER TABLE "realms" ADD COLUMN "created_by_user_id" integer;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "firebase_uid" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "email" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "realm_limit" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "realms" ADD CONSTRAINT "realms_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action DEFERRABLE INITIALLY IMMEDIATE;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email") WHERE "users"."email" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_firebase_uid_unique" UNIQUE("firebase_uid");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_realm_limit" CHECK ("realm_limit" >= 0);--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_lower" CHECK ("email" IS NULL OR "email" = lower("email"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_agent_has_no_firebase" CHECK ("kind" = 'human' OR "firebase_uid" IS NULL);--> statement-breakpoint
UPDATE "realms" SET "created_by_user_id" = (
	SELECT "user_id" FROM "realm_members"
	WHERE "realm_id" = "realms"."id" AND "role" = 'owner' AND "status" = 'active'
	ORDER BY "created_at", "user_id" LIMIT 1
);
