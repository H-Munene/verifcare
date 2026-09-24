CREATE TYPE "public"."id_type" AS ENUM('national_id', 'passport');--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_type" "id_type";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "id_number" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "chk_users_id_type_number_together" CHECK (("users"."id_type" IS NULL) = ("users"."id_number" IS NULL));