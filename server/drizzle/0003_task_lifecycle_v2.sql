ALTER TYPE "public"."activity_type" ADD VALUE 'delivered';--> statement-breakpoint
ALTER TYPE "public"."activity_type" ADD VALUE 'rejected';--> statement-breakpoint
ALTER TYPE "public"."task_status" ADD VALUE 'pending_review' BEFORE 'done';--> statement-breakpoint
CREATE TABLE "task_claimants" (
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"points" integer,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_claimants_task_id_user_id_pk" PRIMARY KEY("task_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "delivered_by" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "reviewed_by" uuid;--> statement-breakpoint
ALTER TABLE "task_claimants" ADD CONSTRAINT "task_claimants_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_claimants" ADD CONSTRAINT "task_claimants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_claimants_user_id_idx" ON "task_claimants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_delivered_by_users_id_fk" FOREIGN KEY ("delivered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Lifecycle v2 §2 data migration: copy the deprecated single-assignee model into
-- task_claimants. Each assigned task seeds a claimant (points = the task points
-- when already done, else NULL); a divergent completed_by also seeds one.
INSERT INTO "task_claimants" ("task_id", "user_id", "points", "claimed_at")
SELECT "id", "assignee_id",
       CASE WHEN "status" = 'done' THEN "points" ELSE NULL END,
       "created_at"
FROM "tasks"
WHERE "assignee_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "task_claimants" ("task_id", "user_id", "points", "claimed_at")
SELECT "id", "completed_by",
       CASE WHEN "status" = 'done' THEN "points" ELSE NULL END,
       "created_at"
FROM "tasks"
WHERE "status" = 'done'
  AND "completed_by" IS NOT NULL
  AND "completed_by" IS DISTINCT FROM "assignee_id"
ON CONFLICT DO NOTHING;