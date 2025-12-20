CREATE TYPE "public"."document_source" AS ENUM('hubspot_contact', 'hubspot_note');--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"document_id" integer NOT NULL,
	"chunk_index" integer NOT NULL,
	"text" text NOT NULL,
	"embedding" vector(1536),
	"embedding_model" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"source" "document_source" NOT NULL,
	"source_id" text NOT NULL,
	"title" text,
	"text" text NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubspot_contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"hubspot_contact_id" text NOT NULL,
	"email" text,
	"first_name" text,
	"last_name" text,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hubspot_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"hubspot_note_id" text NOT NULL,
	"hubspot_contact_id" text NOT NULL,
	"body" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubspot_contacts" ADD CONSTRAINT "hubspot_contacts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hubspot_notes" ADD CONSTRAINT "hubspot_notes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_chunks_user_id_idx" ON "document_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_chunks_document_chunk_uq" ON "document_chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_source_idx" ON "documents" USING btree ("source");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_user_source_uq" ON "documents" USING btree ("user_id","source","source_id");--> statement-breakpoint
CREATE INDEX "hubspot_contacts_user_id_idx" ON "hubspot_contacts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "hubspot_contacts_email_idx" ON "hubspot_contacts" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "hubspot_contacts_user_contact_uq" ON "hubspot_contacts" USING btree ("user_id","hubspot_contact_id");--> statement-breakpoint
CREATE INDEX "hubspot_notes_user_id_idx" ON "hubspot_notes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "hubspot_notes_user_contact_idx" ON "hubspot_notes" USING btree ("user_id","hubspot_contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hubspot_notes_user_note_uq" ON "hubspot_notes" USING btree ("user_id","hubspot_note_id");