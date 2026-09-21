// One-off migration runner (2026-09-21) - the only way to apply a schema migration to the real
// RDS instance right now. RDS has no network path reachable from outside AWS at all (private
// subnet, no public access, no bastion - infra/lib/database.ts's security group only grants
// ApiFunction access) and this project has no CI/CD migration step yet, so this Lambda exists
// purely to be invoked manually (`aws lambda invoke`) after a deploy, never on a schedule and never
// reachable from the REST API. Reuses db/lambdaDb.ts's existing Secrets-Manager-backed connection -
// the same one ApiFunction/missedVisitSweep.ts already use - so the DB credential resolves inside
// AWS at runtime and never passes through a developer's own shell or this Lambda's own logs.
import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getLambdaDb } from './db/lambdaDb.js';

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

// drizzle-orm's migrate() already tracks which migrations are applied and no-ops on the rest, so a
// repeat invocation (e.g. after a deploy with no new migrations) is safe to run again.
export async function handler(): Promise<{ status: 'ok' }> {
  const db = await getLambdaDb();
  await migrate(db, { migrationsFolder });
  console.log('migrations applied successfully');
  return { status: 'ok' };
}
