# Mzazi Care

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
