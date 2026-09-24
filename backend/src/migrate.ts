// One-off migration runner (2026-09-21) - the only way to apply a schema migration to the real
// RDS instance right now. RDS has no network path reachable from outside AWS at all (private
// subnet, no public access, no bastion - infra/lib/database.ts's security group only grants
// ApiFunction access) and this project has no CI/CD migration step yet, so this Lambda exists
// purely to be invoked manually (`aws lambda invoke`) after a deploy, never on a schedule and never
// reachable from the REST API. Reuses db/lambdaDb.ts's existing Secrets-Manager-backed connection -
// the same one ApiFunction/missedVisitSweep.ts already use - so the DB credential resolves inside
// AWS at runtime and never passes through a developer's own shell or this Lambda's own logs.
//
// Also handles the "first supervisor" bootstrap (2026-09-21, same day) - a real, verified Cognito
// identity with custom:role: supervisor has no way to create its own `users` row: routes/users.ts's
// POST /users deliberately only allows a caller with no row yet to self-register as family_member,
// never supervisor, and only an *existing* supervisor row can create another one with role:
// supervisor. Every prior instance of this exact gap in this project was fixed with a one-off manual
// `INSERT INTO users` against a database there was a direct connection to (local Postgres) - the
// real RDS has never had one, since testing against it only became possible today. Reusing this
// Lambda's already-wired DB connection is the narrowest way to do the equivalent insert safely, as
// an explicit event-payload-guarded branch (not generic SQL execution).
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getLambdaDb } from './db/lambdaDb.js';
import * as schema from './db/schema.js';

// Plain __dirname, not testSupport.ts's fileURLToPath(import.meta.url) dance - this file is a
// NodejsFunction entry, and aws-lambda-nodejs's esbuild bundling defaults to CJS output regardless
// of backend/package.json's own "type": "module" (confirmed via a real `cdk synth` warning:
// "import.meta is not available with the cjs output format and will be empty"), so the plain CJS
// __dirname global is what's actually available at runtime here.
// Copied alongside the bundled entry file by infra/lib/migrationRunner.ts's own
// bundling.commandHooks.afterBundling step - esbuild only bundles JS/TS reachable via imports, so
// drizzle-kit's raw .sql migration files and meta/_journal.json (read from disk at runtime by
// drizzle-orm's migrate(), never imported as code) have to be copied into the deployment package
// separately, not resolved via a source-tree-relative path the way testSupport.ts's local/test-only
// equivalent does.
const migrationsFolder = path.join(__dirname, 'drizzle');

interface BootstrapSupervisorEvent {
  bootstrapSupervisor?: {
    cognitoSub: string;
    email: string;
    fullName: string;
  };
}

// drizzle-orm's migrate() already tracks which migrations are applied and no-ops on the rest, so a
// repeat invocation (e.g. after a deploy with no new migrations) is safe to run again.
export async function handler(event: BootstrapSupervisorEvent = {}): Promise<{ status: 'ok' }> {
  const db = await getLambdaDb();

  if (event.bootstrapSupervisor) {
    const { cognitoSub, email, fullName } = event.bootstrapSupervisor;
    const existing = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.cognitoSub, cognitoSub));
    if (existing.length > 0) {
      console.log('supervisor user row already exists, skipping', { cognitoSub });
    } else {
      await db.insert(schema.users).values({ cognitoSub, email, fullName, role: 'supervisor' });
      console.log('bootstrapped supervisor user row', { cognitoSub });
    }
    return { status: 'ok' };
  }

  await migrate(db, { migrationsFolder });
  console.log('migrations applied successfully');
  return { status: 'ok' };
}
