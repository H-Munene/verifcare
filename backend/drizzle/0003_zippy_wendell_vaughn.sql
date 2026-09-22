ALTER TABLE "biometric_enrollments" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD COLUMN "rekognition_face_id" text;--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD COLUMN "matched_subject_type" "subject_type";--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD COLUMN "matched_subject_id" uuid;--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD COLUMN "matched_similarity" real;--> statement-breakpoint
CREATE INDEX "idx_biometric_enrollments_flagged" ON "biometric_enrollments" USING btree ("id") WHERE "biometric_enrollments"."status" = 'flagged';--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "chk_biometric_enrollments_status" CHECK ("biometric_enrollments"."status" IN ('active', 'superseded', 'deleted', 'flagged'));--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "chk_biometric_enrollments_flagged_has_match" CHECK ("biometric_enrollments"."status" != 'flagged' OR ("biometric_enrollments"."matched_subject_type" IS NOT NULL AND "biometric_enrollments"."matched_subject_id" IS NOT NULL AND "biometric_enrollments"."matched_similarity" IS NOT NULL));--> statement-breakpoint
DROP TYPE "public"."biometric_enrollment_status";