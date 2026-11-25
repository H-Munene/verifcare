import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as kms from "aws-cdk-lib/aws-kms";

export interface Database {
  database: rds.DatabaseInstanceFromSnapshot;
  databaseSecret: rds.DatabaseSecret;
}

// The stack was restored on 2026-11-24 after a teardown left it stuck in DELETE_FAILED: the data
// was kept by restoring this snapshot of the running database, and the retained keys, secret,
// buckets and user pool were imported back (cdk import). CloudFormation needs the same
// snapshotIdentifier on every later update: removing or changing it replaces the database with a
// new one restored from that snapshot (or an empty one), losing everything written since.
const RESTORED_FROM_SNAPSHOT = "verifcare-restore-2026-11-24";

export function createDatabase(stack: cdk.Stack, vpc: ec2.Vpc): Database {
  // Encrypts the database, through the snapshot it was restored from: a restore keeps the
  // snapshot's key, so it isn't passed below.
  new kms.Key(stack, "RdsEncryptionKey", {
    alias: "mzazi-care/rds",
    description: "Encrypts the Mzazi Care RDS PostgreSQL instance",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const rdsSecretEncryptionKey = new kms.Key(stack, "RdsSecretEncryptionKey", {
    alias: "mzazi-care/rds-secret",
    description: "Encrypts the Secrets Manager secret holding RDS credentials",
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const databaseSecret = new rds.DatabaseSecret(stack, "DatabaseSecret", {
    username: "mzazi_care_admin",
    encryptionKey: rdsSecretEncryptionKey,
  });
  databaseSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

  const database = new rds.DatabaseInstanceFromSnapshot(stack, "Database", {
    snapshotIdentifier: RESTORED_FROM_SNAPSHOT,
    // The snapshot's master password is the one in this (imported) secret.
    credentials: rds.SnapshotCredentials.fromSecret(databaseSecret),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    availabilityZone: "eu-west-1c",
    engine: rds.DatabaseInstanceEngine.postgres({
      version: rds.PostgresEngineVersion.VER_18_3,
    }),
    instanceType: ec2.InstanceType.of(
      ec2.InstanceClass.T4G,
      ec2.InstanceSize.MICRO,
    ),
    allocatedStorage: 20,
    storageType: rds.StorageType.GP3,
    multiAz: false,
    deletionProtection: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  database.addRotationSingleUser({
    automaticallyAfter: cdk.Duration.days(30),
  });

  new cdk.CfnOutput(stack, "DatabaseSecretArn", {
    value: databaseSecret.secretArn,
  });
  new cdk.CfnOutput(stack, "DatabaseEndpoint", {
    value: database.dbInstanceEndpointAddress,
  });

  return { database, databaseSecret };
}
