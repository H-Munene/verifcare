import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";

export interface MigrationRunnerParams {
  vpc: ec2.Vpc;
  database: rds.IDatabaseInstance;
  databaseSecret: rds.DatabaseSecret;
}

export interface MigrationRunner {
  migrationRunnerFunction: NodejsFunction;
}

// A one-off, manually-invoked Lambda (2026-09-21) - not on any schedule, not reachable from the
// REST API, not granted to any principal beyond whoever can already call lambda:InvokeFunction on
// this account. Exists solely because the real RDS instance has no network path from outside AWS
// (database.ts's own security group only grants ApiFunction access) and this project has no CI/CD
// migration step yet - this is the only way to apply a schema migration to it without either
// exposing RDS publicly or standing up a persistent bastion. Reuses backend/src/db/lambdaDb.ts's
// existing Secrets-Manager-backed connection (the same one ApiFunction/MissedVisitSweepFunction
// already use), so the DB credential resolves inside AWS at runtime and never has to be fetched by
// or pasted into a developer's own shell.
export function createMigrationRunner(
  stack: cdk.Stack,
  params: MigrationRunnerParams,
): MigrationRunner {
  const { vpc, database, databaseSecret } = params;

  const migrationRunnerFunction = new NodejsFunction(stack, "MigrationRunnerFunction", {
    entry: path.join(__dirname, "../../backend/src/migrate.ts"),
    projectRoot: path.join(__dirname, "../../backend"),
    depsLockFilePath: path.join(__dirname, "../../backend/package-lock.json"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    // Applying several migrations against a cold connection comfortably fits well under a minute
    // in practice, but the default 3s Lambda timeout obviously doesn't - 2 minutes is a generous
    // margin, not a tuned figure.
    timeout: cdk.Duration.minutes(2),
    vpc,
    vpcSubnets: {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      subnetFilters: [ec2.SubnetFilter.availabilityZones(["eu-west-1c"])],
    },
    environment: {
      DATABASE_SECRET_ARN: databaseSecret.secretArn,
    },
    bundling: {
      // esbuild only follows the JS/TS import graph - drizzle-kit's raw .sql migration files and
      // meta/_journal.json (read from disk at runtime by drizzle-orm's migrate(), never imported as
      // code) have to be copied into the deployment package by hand. See
      // infra/scripts/copy-drizzle-migrations.mjs for why this is a real script, not an inline
      // shell command.
      commandHooks: {
        beforeInstall(): string[] {
          return [];
        },
        beforeBundling(): string[] {
          return [];
        },
        afterBundling(inputDir: string, outputDir: string): string[] {
          const script = path.join(__dirname, "../scripts/copy-drizzle-migrations.mjs");
          return [`node "${script}" "${inputDir}" "${outputDir}"`];
        },
      },
    },
  });

  database.connections.allowDefaultPortFrom(migrationRunnerFunction);

  // Network access (above) alone isn't enough - db/lambdaDb.ts's getLambdaDb() also needs to
  // actually read the credential out of Secrets Manager at runtime, the same grant api.ts's
  // ApiFunction already has. Scoped to this one secret's ARN, not a wildcard.
  databaseSecret.grantRead(migrationRunnerFunction);

  new cdk.CfnOutput(stack, "MigrationRunnerFunctionName", {
    value: migrationRunnerFunction.functionName,
  });

  return { migrationRunnerFunction };
}
