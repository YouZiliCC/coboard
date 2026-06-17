ALTER TABLE "tasks" ADD COLUMN "min_claimants" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "max_claimants" integer;