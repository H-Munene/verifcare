import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as rds from "aws-cdk-lib/aws-rds";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecr from "aws-cdk-lib/aws-ecr";
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class MzaziCareStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // RDS DB subnet groups require subnets spanning at least 2 AZs, even for a
    // Single-AZ instance - so the VPC needs a second AZ's subnets to exist,
    // even though actual compute (RDS, later the api/missed-visit-sweep
    // Lambdas) stays pinned to eu-west-1c via an explicit AZ property. Only
    // one NAT Gateway is still created (natGateways: 1) - the second AZ's
    // private subnet routes cross-AZ to it, at a small per-GB data transfer
    // cost, rather than paying for a second NAT Gateway.
    //
    // Construct id deliberately changed from "Vpc" to "Vpc2": adding a second
    // AZ to an already-deployed single-AZ Vpc construct forces CDK to
    // recalculate every subnet's CIDR block, and CloudFormation has no way to
    // sequence "delete the old, now-relocated subnet" before "create the new
    // subnet that wants its freed CIDR" - the two collide as a real, repeatable
    // deploy failure ("CIDR conflicts with another subnet"), not a transient
    // one. Renaming the id forces a clean full replacement (new VPC created
    // fresh with the correct 2-AZ layout, old one deleted after) instead of a
    // doomed in-place patch. Safe here since nothing has ever successfully
    // landed inside this VPC yet - every prior RDS attempt failed and rolled
    // back before anything attached to it.
    const vpc = new ec2.Vpc(this, "Vpc2", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/16"),
      availabilityZones: ["eu-west-1c", "eu-west-1a"],
      natGateways: 1,
      subnetConfiguration: [
        { name: "Public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: "mzazi-care-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true, phone: true },
      autoVerify: { email: true, phone: true },
      standardAttributes: {
        fullname: { required: true, mutable: true },
      },
      customAttributes: {
        role: new cognito.StringAttribute({ minLen: 1, maxLen: 20, mutable: true }),
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const userPoolClient = userPool.addClient("UserPoolClient", {
      authFlows: {
        userSrp: true,
      },
      generateSecret: false,
      disableOAuth: true,
    });

    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });

    const rdsEncryptionKey = new kms.Key(this, "RdsEncryptionKey", {
      alias: "mzazi-care/rds",
      description: "Encrypts the Mzazi Care RDS PostgreSQL instance",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const rdsSecretEncryptionKey = new kms.Key(this, "RdsSecretEncryptionKey", {
      alias: "mzazi-care/rds-secret",
      description: "Encrypts the Secrets Manager secret holding RDS credentials",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const databaseSecret = new rds.DatabaseSecret(this, "DatabaseSecret", {
      username: "mzazi_care_admin",
      encryptionKey: rdsSecretEncryptionKey,
    });
    databaseSecret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const database = new rds.DatabaseInstance(this, "Database", {
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

    new cdk.CfnOutput(this, "DatabaseSecretArn", {
      value: databaseSecret.secretArn,
    });
    new cdk.CfnOutput(this, "DatabaseEndpoint", {
      value: database.dbInstanceEndpointAddress,
    });

    const biometricEnrollmentsKey = new kms.Key(this, "BiometricEnrollmentsKey", {
      alias: "mzazi-care/biometric-enrollments",
      description: "Encrypts the biometric-enrollments S3 bucket",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const visitAudioKey = new kms.Key(this, "VisitAudioKey", {
      alias: "mzazi-care/visit-audio",
      description: "Encrypts the visit-audio S3 bucket",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // No bucketName set: S3 bucket names are globally unique across all AWS
    // accounts, not just this one, so a literal "biometric-enrollments" would
    // very likely collide with an unrelated bucket somewhere else and fail to
    // deploy. Letting CloudFormation generate the physical name (derived from
    // the stack/logical id) guarantees uniqueness; architecture.md's bucket
    // "names" are the construct ids/labels below, not literal S3 bucket names.
    const biometricEnrollmentsBucket = new s3.Bucket(this, "BiometricEnrollmentsBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: biometricEnrollmentsKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // No lifecycle rule - per architecture.md's Retention section, deletion
      // here is application-triggered on caregiver/dependant offboarding, not
      // a calendar-based S3 rule (unlike visit-audio below).
    });

    const visitAudioBucket = new s3.Bucket(this, "VisitAudioBucket", {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: visitAudioKey,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
        },
      ],
    });

    new cdk.CfnOutput(this, "BiometricEnrollmentsBucketName", {
      value: biometricEnrollmentsBucket.bucketName,
    });
    new cdk.CfnOutput(this, "VisitAudioBucketName", {
      value: visitAudioBucket.bucketName,
    });

    // acoustic-model only - api stays a plain zip-based Lambda, no ECR
    // involvement, per architecture.md's "Container registry" row.
    const acousticModelRepository = new ecr.Repository(this, "AcousticModelRepository", {
      repositoryName: "acoustic-model",
      imageScanOnPush: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          description: "Expire untagged images after 14 days",
          tagStatus: ecr.TagStatus.UNTAGGED,
          maxImageAge: cdk.Duration.days(14),
        },
      ],
    });

    new cdk.CfnOutput(this, "AcousticModelRepositoryUri", {
      value: acousticModelRepository.repositoryUri,
    });
  }
}
