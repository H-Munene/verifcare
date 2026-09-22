// Copies backend/drizzle (raw .sql migrations + meta/_journal.json) into the migration-runner
// Lambda's bundled output directory - see infra/lib/migrationRunner.ts's commandHooks.afterBundling
// for why this is a real script rather than an inline shell command: cdk deploy can run from either
// PowerShell or Git Bash on this project's Windows dev machines, and inline shell-quoting differs
// between them, but `node <script>` behaves identically either way.
import { cpSync } from 'node:fs';
import path from 'node:path';

const [, , inputDir, outputDir] = process.argv;
cpSync(path.join(inputDir, 'drizzle'), path.join(outputDir, 'drizzle'), { recursive: true });
