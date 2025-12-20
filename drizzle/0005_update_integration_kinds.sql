ALTER TABLE "integration_states" ALTER COLUMN "integration" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."integration_kind";--> statement-breakpoint
CREATE TYPE "public"."integration_kind" AS ENUM('gmail', 'calendar', 'hubspot_notes', 'hubspot_contacts');--> statement-breakpoint
ALTER TABLE "integration_states" ALTER COLUMN "integration" SET DATA TYPE "public"."integration_kind" USING "integration"::"public"."integration_kind";