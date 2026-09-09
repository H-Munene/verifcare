CREATE TYPE "public"."biometric_enrollment_status" AS ENUM('active', 'superseded', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."consent_type" AS ENUM('biometric_verification', 'audio_cognitive_monitoring');--> statement-breakpoint
CREATE TYPE "public"."dependant_gender" AS ENUM('male', 'female');--> statement-breakpoint
CREATE TYPE "public"."dependant_status" AS ENUM('active', 'deactivated');--> statement-breakpoint
CREATE TYPE "public"."subject_type" AS ENUM('caregiver', 'dependant');--> statement-breakpoint
CREATE TYPE "public"."verification_attempt_type" AS ENUM('geofence', 'caregiver_liveness', 'dependant_liveness');--> statement-breakpoint
CREATE TABLE "audio_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"verification_event_id" uuid NOT NULL,
	"s3_key" text NOT NULL,
	"duration_seconds" integer,
	"risk_score" numeric(5, 4),
	"model_version" text,
	"processed_at" timestamp with time zone,
	CONSTRAINT "uq_audio_records_s3_key" UNIQUE("s3_key"),
	CONSTRAINT "chk_audio_records_risk_score_range" CHECK ("audio_records"."risk_score" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"actor_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "biometric_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"caregiver_id" uuid,
	"dependant_id" uuid,
	"s3_key" text NOT NULL,
	"image_order" smallint NOT NULL,
	"quality_score" real,
	"status" "biometric_enrollment_status" DEFAULT 'active' NOT NULL,
	"enrolled_by" uuid NOT NULL,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_biometric_enrollments_s3_key" UNIQUE("s3_key"),
	CONSTRAINT "chk_biometric_enrollments_image_order" CHECK ("biometric_enrollments"."image_order" BETWEEN 1 AND 3),
	CONSTRAINT "chk_biometric_enrollments_subject" CHECK (("biometric_enrollments"."subject_type" = 'caregiver' AND "biometric_enrollments"."caregiver_id" IS NOT NULL AND "biometric_enrollments"."dependant_id" IS NULL) OR
          ("biometric_enrollments"."subject_type" = 'dependant' AND "biometric_enrollments"."dependant_id" IS NOT NULL AND "biometric_enrollments"."caregiver_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "caregivers" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"employee_number" text,
	"hire_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_caregivers_employee_number" UNIQUE("employee_number")
);
--> statement-breakpoint
CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"subject_type" "subject_type" NOT NULL,
	"caregiver_id" uuid,
	"dependant_id" uuid,
	"consent_type" "consent_type" NOT NULL,
	"granted_by" uuid NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "chk_consent_records_subject" CHECK (("consent_records"."subject_type" = 'caregiver' AND "consent_records"."caregiver_id" IS NOT NULL AND "consent_records"."dependant_id" IS NULL) OR
          ("consent_records"."subject_type" = 'dependant' AND "consent_records"."dependant_id" IS NOT NULL AND "consent_records"."caregiver_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "dependant_family_members" (
	"dependant_id" uuid NOT NULL,
	"family_member_user_id" uuid NOT NULL,
	"relationship" text,
	"is_primary_contact" boolean DEFAULT false NOT NULL,
	"added_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dependant_family_members_dependant_id_family_member_user_id_pk" PRIMARY KEY("dependant_id","family_member_user_id")
);
--> statement-breakpoint
CREATE TABLE "dependants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"full_name" text NOT NULL,
	"dob" date NOT NULL,
	"gender" "dependant_gender",
	"home_address_text" text,
	"geofence_lat" double precision NOT NULL,
	"geofence_lng" double precision NOT NULL,
	"geofence_radius_meters" integer NOT NULL,
	"cognitive_monitoring_enabled" boolean DEFAULT false NOT NULL,
	"status" "dependant_status" DEFAULT 'active' NOT NULL,
	"registered_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_dependants_geofence_radius_positive" CHECK ("dependants"."geofence_radius_meters" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_log" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"type" text NOT NULL,
	"visit_schedule_id" uuid,
	"audio_record_id" uuid,
	"recipient_user_id" uuid NOT NULL,
	"channel" text,
	"sent_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	CONSTRAINT "chk_notification_log_type" CHECK ("notification_log"."type" IN ('missed_visit', 'cognitive_risk')),
	CONSTRAINT "chk_notification_log_related_entity" CHECK (("notification_log"."type" = 'missed_visit' AND "notification_log"."visit_schedule_id" IS NOT NULL AND "notification_log"."audio_record_id" IS NULL) OR
          ("notification_log"."type" = 'cognitive_risk' AND "notification_log"."audio_record_id" IS NOT NULL AND "notification_log"."visit_schedule_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"cognito_sub" text NOT NULL,
	"email" text,
	"phone_number" text,
	"full_name" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_users_cognito_sub" UNIQUE("cognito_sub"),
	CONSTRAINT "uq_users_email" UNIQUE("email"),
	CONSTRAINT "uq_users_phone_number" UNIQUE("phone_number"),
	CONSTRAINT "chk_users_role" CHECK ("users"."role" IN ('supervisor', 'caregiver', 'family_member')),
	CONSTRAINT "chk_users_status" CHECK ("users"."status" IN ('active', 'suspended', 'deactivated')),
	CONSTRAINT "chk_users_phone_required_unless_supervisor" CHECK ("users"."role" = 'supervisor' OR "users"."phone_number" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "verification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"visit_schedule_id" uuid NOT NULL,
	"attempt_type" "verification_attempt_type" NOT NULL,
	"passed" boolean NOT NULL,
	"failure_reason" text,
	"metadata" jsonb,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_events" (
	"visit_schedule_id" uuid PRIMARY KEY NOT NULL,
	"checkin_at" timestamp with time zone,
	"checkout_at" timestamp with time zone,
	"checkin_gps_lat" double precision,
	"checkin_gps_lng" double precision,
	"distance_from_geofence_meters" double precision,
	"caregiver_match_confidence" numeric(5, 2),
	"dependant_match_confidence" numeric(5, 2),
	"caregiver_liveness_passed" boolean,
	"dependant_liveness_passed" boolean,
	"session_token_hash" text,
	CONSTRAINT "chk_verification_events_caregiver_match_confidence_range" CHECK ("verification_events"."caregiver_match_confidence" BETWEEN 0 AND 100),
	CONSTRAINT "chk_verification_events_dependant_match_confidence_range" CHECK ("verification_events"."dependant_match_confidence" BETWEEN 0 AND 100),
	CONSTRAINT "chk_verification_events_checkout_after_checkin" CHECK ("verification_events"."checkout_at" IS NULL OR ("verification_events"."checkin_at" IS NOT NULL AND "verification_events"."checkout_at" >= "verification_events"."checkin_at"))
);
--> statement-breakpoint
CREATE TABLE "visit_schedules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_generate_v7() NOT NULL,
	"caregiver_id" uuid NOT NULL,
	"dependant_id" uuid NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_visit_schedules_status" CHECK ("visit_schedules"."status" IN ('scheduled', 'in_progress', 'completed', 'missed', 'cancelled', 'investigated')),
	CONSTRAINT "chk_visit_schedules_end_after_start" CHECK ("visit_schedules"."scheduled_end" > "visit_schedules"."scheduled_start")
);
--> statement-breakpoint
ALTER TABLE "audio_records" ADD CONSTRAINT "fk_audio_records_verification_event" FOREIGN KEY ("verification_event_id") REFERENCES "public"."verification_events"("visit_schedule_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "biometric_enrollments_caregiver_id_caregivers_user_id_fk" FOREIGN KEY ("caregiver_id") REFERENCES "public"."caregivers"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "biometric_enrollments_dependant_id_dependants_id_fk" FOREIGN KEY ("dependant_id") REFERENCES "public"."dependants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "biometric_enrollments" ADD CONSTRAINT "biometric_enrollments_enrolled_by_users_id_fk" FOREIGN KEY ("enrolled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregivers" ADD CONSTRAINT "caregivers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_caregiver_id_caregivers_user_id_fk" FOREIGN KEY ("caregiver_id") REFERENCES "public"."caregivers"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_dependant_id_dependants_id_fk" FOREIGN KEY ("dependant_id") REFERENCES "public"."dependants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependant_family_members" ADD CONSTRAINT "dependant_family_members_dependant_id_dependants_id_fk" FOREIGN KEY ("dependant_id") REFERENCES "public"."dependants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependant_family_members" ADD CONSTRAINT "dependant_family_members_family_member_user_id_users_id_fk" FOREIGN KEY ("family_member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependant_family_members" ADD CONSTRAINT "dependant_family_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependants" ADD CONSTRAINT "dependants_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_visit_schedule_id_visit_schedules_id_fk" FOREIGN KEY ("visit_schedule_id") REFERENCES "public"."visit_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_audio_record_id_audio_records_id_fk" FOREIGN KEY ("audio_record_id") REFERENCES "public"."audio_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_recipient_user_id_users_id_fk" FOREIGN KEY ("recipient_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_attempts" ADD CONSTRAINT "verification_attempts_visit_schedule_id_visit_schedules_id_fk" FOREIGN KEY ("visit_schedule_id") REFERENCES "public"."visit_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_events" ADD CONSTRAINT "verification_events_visit_schedule_id_visit_schedules_id_fk" FOREIGN KEY ("visit_schedule_id") REFERENCES "public"."visit_schedules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD CONSTRAINT "visit_schedules_caregiver_id_caregivers_user_id_fk" FOREIGN KEY ("caregiver_id") REFERENCES "public"."caregivers"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD CONSTRAINT "visit_schedules_dependant_id_dependants_id_fk" FOREIGN KEY ("dependant_id") REFERENCES "public"."dependants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_schedules" ADD CONSTRAINT "visit_schedules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_audio_records_verification_event" ON "audio_records" USING btree ("verification_event_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_entity" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "idx_audit_log_actor_time" ON "audit_log" USING btree ("actor_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_biometric_enrollments_caregiver_active" ON "biometric_enrollments" USING btree ("caregiver_id","status");--> statement-breakpoint
CREATE INDEX "idx_biometric_enrollments_dependant_active" ON "biometric_enrollments" USING btree ("dependant_id","status");--> statement-breakpoint
CREATE INDEX "idx_biometric_enrollments_enrolled_by" ON "biometric_enrollments" USING btree ("enrolled_by");--> statement-breakpoint
CREATE INDEX "idx_consent_records_caregiver" ON "consent_records" USING btree ("caregiver_id");--> statement-breakpoint
CREATE INDEX "idx_consent_records_dependant" ON "consent_records" USING btree ("dependant_id");--> statement-breakpoint
CREATE INDEX "idx_consent_records_type" ON "consent_records" USING btree ("consent_type");--> statement-breakpoint
CREATE INDEX "idx_consent_records_granted_by" ON "consent_records" USING btree ("granted_by");--> statement-breakpoint
CREATE INDEX "idx_dependant_family_members_family_member" ON "dependant_family_members" USING btree ("family_member_user_id");--> statement-breakpoint
CREATE INDEX "idx_dependant_family_members_added_by" ON "dependant_family_members" USING btree ("added_by");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_dependant_family_members_primary_contact" ON "dependant_family_members" USING btree ("dependant_id") WHERE "dependant_family_members"."is_primary_contact";--> statement-breakpoint
CREATE INDEX "idx_dependants_registered_by" ON "dependants" USING btree ("registered_by");--> statement-breakpoint
CREATE INDEX "idx_dependants_status" ON "dependants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_notification_log_recipient_sent" ON "notification_log" USING btree ("recipient_user_id","sent_at");--> statement-breakpoint
CREATE INDEX "idx_notification_log_visit_schedule" ON "notification_log" USING btree ("visit_schedule_id");--> statement-breakpoint
CREATE INDEX "idx_notification_log_audio_record" ON "notification_log" USING btree ("audio_record_id");--> statement-breakpoint
CREATE INDEX "idx_notification_log_acknowledged_by" ON "notification_log" USING btree ("acknowledged_by");--> statement-breakpoint
CREATE INDEX "idx_users_role" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "idx_verification_attempts_visit_time" ON "verification_attempts" USING btree ("visit_schedule_id","attempted_at");--> statement-breakpoint
CREATE INDEX "idx_visit_schedules_caregiver_start" ON "visit_schedules" USING btree ("caregiver_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "idx_visit_schedules_dependant_start" ON "visit_schedules" USING btree ("dependant_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "idx_visit_schedules_status" ON "visit_schedules" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_visit_schedules_created_by" ON "visit_schedules" USING btree ("created_by");