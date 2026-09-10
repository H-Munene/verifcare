# Mzazi Care

## Architecture

![Mzazi Care AWS architecture](assets/aws_architecture.png)

Backend compute runs on three AWS Lambda functions (`api`, `acoustic-model`, `missed-visit-sweep`) behind Amazon API Gateway, with Cognito for auth, RDS (PostgreSQL) as the primary datastore, S3 for biometric/audio storage, and Rekognition for face verification.

This diagram omits the Region/VPC/public-private subnet boundaries (diagramming tool and space constraints) - worth stating explicitly since it can't be inferred from the image alone: `api` and `missed-visit-sweep` are both VPC-attached in a private subnet (so they can reach RDS directly); `acoustic-model` is not (it only touches S3). All outbound calls from the two VPC-attached functions to other AWS services - Secrets Manager, Rekognition, SNS, CloudWatch, and `api`'s invocation of `acoustic-model` - go through a single NAT Gateway.

## Local development

Requires Docker.

```bash
# From the repo root: start Postgres (host port 5433, not 5432 - see docker-compose.yml).
docker compose up -d

# One-time: create the disposable database the integration tests use.
psql -h localhost -p 5433 -U postgres -c "CREATE DATABASE mzazi_care_test;"
# Password: postgres (set in docker-compose.yml, local dev only).

cd backend
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed    # optional: realistic sample data - users, caregivers, dependants, visits
npm run dev
```

`npm run db:studio` (from `backend/`) opens a browser-based database viewer.
`npm test` runs the unit tests; the DB-enforcement integration tests in that same run need `TEST_DATABASE_URL` (in `.env.example`) and skip themselves cleanly if it isn't set.

See `backend/drizzle/README.md` for migrations and how to re-verify them, check `backend/openapi.yaml` for the API contract.
