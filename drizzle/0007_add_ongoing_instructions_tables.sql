CREATE TYPE "public"."proactive_action_status" AS ENUM('pending', 'running', 'completed', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('gmail_received', 'gmail_sent', 'calendar_event_created', 'calendar_event_updated', 'calendar_event_deleted', 'hubspot_contact_created', 'hubspot_contact_updated', 'hubspot_contact_deleted', 'hubspot_note_created', 'hubspot_note_deleted');--> statement-breakpoint
CREATE TABLE "instruction_trigger_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_action_rate_limits" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"hour_window" timestamp with time zone NOT NULL,
	"action_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "proactive_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"instruction_id" integer,
	"instruction_text" text NOT NULL,
	"trigger_type" "trigger_type" NOT NULL,
	"trigger_summary" text NOT NULL,
	"trigger_data" jsonb,
	"action_taken" text NOT NULL,
	"action_result" jsonb,
	"status" "proactive_action_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instruction_trigger_states" ADD CONSTRAINT "instruction_trigger_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_action_rate_limits" ADD CONSTRAINT "proactive_action_rate_limits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proactive_actions" ADD CONSTRAINT "proactive_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instruction_trigger_states_user_id_idx" ON "instruction_trigger_states" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "proactive_action_rate_limits_user_hour_idx" ON "proactive_action_rate_limits" USING btree ("user_id","hour_window");--> statement-breakpoint
CREATE INDEX "proactive_actions_user_id_idx" ON "proactive_actions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "proactive_actions_status_idx" ON "proactive_actions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proactive_actions_created_at_idx" ON "proactive_actions" USING btree ("created_at");