// Copies backend/drizzle (raw .sql migrations + meta/_journal.json) into the migration-runner
// Lambda's bundled output directory - see infra/lib/migrationRunner.ts's commandHooks.afterBundling
// for why this is a real script rather than an inline shell command: cdk deploy can run from either
// PowerShell or Git Bash on this project's Windows dev machines, and inline shell-quoting differs
// between them, but `node <script>` behaves identically either way.
import { cpSync } from 'node:fs';
import path from 'node:path';

const [, , inputDir, outputDir] = process.argv;
cpSync(path.join(inputDir, 'drizzle'), path.join(outputDir, 'drizzle'), { recursive: true });

// ponytail: fixed delay, not a handle-release poll - Windows-only workaround for a real,
// consistently-reproducing race (confirmed 2026-09-23), not a rare flake: this script runs as a
// child process CDK's own bundling code spawns, and CDK renames outputDir to its final name
// immediately after this process exits. On Windows, the OS doesn't always release this process's
// file handles on the files just written by cpSync before that rename() call fires, which fails
// with EPERM. Atomics.wait blocks the thread via the OS (not a CPU-spinning busy loop) and is the
// standard synchronous-sleep idiom in Node - there's no async equivalent available here, since
// this script must be finished, not just have scheduled a callback, before the process exits.
// Upgrade path if 300ms ever proves insufficient: this would need to become a poll-retry around
// the rename itself, which lives in aws-cdk-lib's own AssetStaging code, not something reachable
// from this script.
if (process.platform === 'win32') {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
}
