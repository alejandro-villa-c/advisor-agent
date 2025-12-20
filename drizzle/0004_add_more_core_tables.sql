CREATE TYPE "public"."integration_kind" AS ENUM('gmail', 'calendar', 'hubspot');--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'gmail_email';--> statement-breakpoint
ALTER TYPE "public"."document_source" ADD VALUE 'calendar_event';--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"google_event_id" text NOT NULL,
	"summary" text,
	"description" text,
	"location" text,
	"start_at" timestamp with time zone,
	"end_at" timestamp with time zone,
	"attendees" jsonb,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gmail_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"gmail_message_id" text NOT NULL,
	"gmail_thread_id" text,
	"from" text,
	"to" text,
	"cc" text,
	"bcc" text,
	"subject" text,
	"snippet" text,
	"sent_at" timestamp with time zone,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"integration" "integration_kind" NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gmail_messages" ADD CONSTRAINT "gmail_messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_states" ADD CONSTRAINT "integration_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calendar_events_user_id_idx" ON "calendar_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "calendar_events_start_at_idx" ON "calendar_events" USING btree ("start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_user_event_uq" ON "calendar_events" USING btree ("user_id","calendar_id","google_event_id");--> statement-breakpoint
CREATE INDEX "gmail_messages_user_id_idx" ON "gmail_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "gmail_messages_thread_id_idx" ON "gmail_messages" USING btree ("gmail_thread_id");--> statement-breakpoint
CREATE INDEX "gmail_messages_sent_at_idx" ON "gmail_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "gmail_messages_user_msg_uq" ON "gmail_messages" USING btree ("user_id","gmail_message_id");--> statement-breakpoint
CREATE INDEX "integration_states_user_id_idx" ON "integration_states" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "integration_states_user_integration_uq" ON "integration_states" USING btree ("user_id","integration");