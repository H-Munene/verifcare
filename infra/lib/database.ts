import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as kms from "aws-cdk-lib/aws-kms";

export interface Database {
  database: rds.DatabaseInstance;
  databaseSecret: rds.DatabaseSecret;
}

export function createDatabase(stack: cdk.Stack, vpc: ec2.Vpc): Database {
  const rdsEncryptionKey = new kms.Key(stack, "RdsEncryptionKey", {
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

  const database = new rds.DatabaseInstance(stack, "Database", {
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
    storageEncrypted: true,
    storageEncryptionKey: rdsEncryptionKey,
    credentials: rds.Credentials.fromSecret(databaseSecret),
    databaseName: "mzazi_care",
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
