-- HEZ-54: caregiver registration gains dob/gender/occupation, and employee_number/hire_date
-- become DB-generated instead of supervisor-entered. Hand-written (drizzle-kit generate wants an
-- interactive prompt to disambiguate the enum rename below from a drop+create, which this
-- non-interactive environment can't answer) - see backend/src/db/schema.ts's own comments for the
-- full reasoning behind each change.

-- Renamed, not dropped/recreated: dependants.gender's existing values are untouched by a type
-- rename, and caregivers.gender (added below) now shares the same vocabulary instead of a second,
-- near-duplicate enum.
ALTER TYPE "dependant_gender" RENAME TO "person_gender";
--> statement-breakpoint

CREATE TYPE "caregiver_occupation" AS ENUM ('nurse', 'community_health_worker', 'caregiver');
--> statement-breakpoint

CREATE SEQUENCE "caregiver_employee_number_seq" START WITH 1 INCREMENT BY 1;
--> statement-breakpoint

ALTER TABLE "caregivers" ADD COLUMN "dob" date;
--> statement-breakpoint

ALTER TABLE "caregivers" ADD COLUMN "gender" "person_gender";
--> statement-breakpoint

ALTER TABLE "caregivers" ADD COLUMN "occupation" "caregiver_occupation";
--> statement-breakpoint

ALTER TABLE "caregivers" ALTER COLUMN "employee_number" SET DEFAULT 'CG-' || lpad(nextval('caregiver_employee_number_seq')::text, 4, '0');
--> statement-breakpoint

ALTER TABLE "caregivers" ALTER COLUMN "hire_date" SET DEFAULT CURRENT_DATE;
