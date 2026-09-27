-- verification_events checkout location (2026-09-27): checkout now has to happen inside the
-- dependant's geofence radius, like check-in, so the caregiver's checkout GPS fix and its distance
-- from the geofence centre are stored as the record that it did. Hand-written like 0010-0014 (see
-- 0011's header).
--
-- Nullable: visits checked out before this rule have no checkout location, and a visit that
-- hasn't been checked out yet has none either.

ALTER TABLE "verification_events" ADD COLUMN "checkout_gps_lat" double precision;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_gps_lng" double precision;
--> statement-breakpoint
ALTER TABLE "verification_events" ADD COLUMN "checkout_distance_from_geofence_meters" double precision;
