import * as cdk from "aws-cdk-lib/core";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as rds from "aws-cdk-lib/aws-rds";
import * as kms from "aws-cdk-lib/aws-kms";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as path from "node:path";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
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

    // acoustic-model's Lambda function is deliberately not created yet: it's a
    // container-image Lambda, and the ECR repository above has no image in it
    // yet (the real acoustic-model implementation is later work, Linear
    // HEZ-43 onward) - CDK cannot create a container-image Lambda against an
    // empty repository. api's function is created now since the Express app
    // it wraps already exists and is tested (HEZ-7), even though it currently
    // only has a health-check route.
    const apiFunction = new NodejsFunction(this, "ApiFunction", {
      // An explicit absolute path, not a bare relative string: NodejsFunction
      // normally infers the entry's base directory from the call site via
      // the JS stack trace, but that inference failed under tsx (the app's
      // runtime here, per cdk.json) with "Cannot find entry file" even though
      // the relative path was mathematically correct - a tsx-specific quirk,
      // not a real path error. __dirname is unambiguous regardless of which
      // runtime executes this file.
      entry: path.join(__dirname, "../../backend/src/lambda.ts"),
      // NodejsFunction also requires the entry to live under its
      // "projectRoot" (which it otherwise defaults to infra/ itself) - since
      // backend/ is a sibling directory with its own package.json/lockfile,
      // not nested inside infra/, both must be pointed at backend/ explicitly.
      projectRoot: path.join(__dirname, "../../backend"),
      depsLockFilePath: path.join(__dirname, "../../backend/package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      vpc,
      // Restricted to eu-west-1c specifically, not just PRIVATE_WITH_EGRESS -
      // that alone selects the private subnet in *every* AZ (both eu-west-1c
      // and the structural-only eu-west-1a one from HEZ-18), which would
      // contradict the single-AZ compute intent this project has kept
      // everywhere else (RDS included).
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        subnetFilters: [ec2.SubnetFilter.availabilityZones(["eu-west-1c"])],
      },
      environment: {
        DATABASE_SECRET_ARN: databaseSecret.secretArn,
        USER_POOL_ID: userPool.userPoolId,
        USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
        BIOMETRIC_ENROLLMENTS_BUCKET_NAME: biometricEnrollmentsBucket.bucketName,
        VISIT_AUDIO_BUCKET_NAME: visitAudioBucket.bucketName,
      },
    });

    // Network-level access only (the security group rule letting api reach
    // RDS's port) - matches architecture.md's "Networking (VPC layout)"
    // section, which is settled. IAM grants for what api's code actually
    // reads/writes (the secret, the two buckets, Rekognition) are Linear
    // HEZ-24's explicit scope, not this one - the current app only serves a
    // health check and doesn't touch any of them yet.
    database.connections.allowDefaultPortFrom(apiFunction);

    new cdk.CfnOutput(this, "ApiFunctionName", {
      value: apiFunction.functionName,
    });

    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
      this,
      "CognitoAuthorizer",
      { cognitoUserPools: [userPool] },
    );

    // REST API, not HTTP API: architecture.md originally chose HTTP API "for
    // lower cost and native Cognito JWT authorizer support," but AWS WAF's
    // WebACLAssociation does not support HTTP APIs at all - only REST APIs,
    // ALB, AppSync, Cognito user pools, App Runner, Verified Access, and
    // Amplify (confirmed against AWS's own CloudFormation reference and
    // corroborated by a real "ARN isn't valid" deploy failure that persisted
    // across multiple stage-name attempts, ruling out an ARN-formatting
    // explanation). Switched to REST API to keep WAF, which architecture.md
    // separately committed to keeping - REST API's Cognito authorizer is
    // equally native, and the cost difference at this project's near-zero
    // traffic is negligible. LambdaRestApi (proxy: true) mirrors the same
    // "route everything to the Lambda" shape the HTTP API had; the Express
    // app's own router still decides what to do with each path.
    const restApi = new apigateway.LambdaRestApi(this, "RestApi", {
      restApiName: "mzazi-care-api",
      handler: apiFunction,
      proxy: true,
      defaultMethodOptions: {
        authorizationType: apigateway.AuthorizationType.COGNITO,
        authorizer: cognitoAuthorizer,
      },
    });

    // WAF: 1 Web ACL, one custom rate-based rule, one AWS Managed Rule Group
    // (Amazon IP reputation list) - matches the "1 Web ACL, 2 rules, $7.01/
    // month" figure from the confirmed cost estimate, with the AWS-maintained
    // IP reputation list used in place of a literal second custom rule (a
    // hand-rolled "IP reputation" rule with no real threat-intel data behind
    // it wouldn't actually do anything - confirmed with the user 2026-09-13).
    // Rate limit (2000 req / 5 min / IP) is a placeholder default, not yet
    // reviewed/signed off - same caveat architecture.md already applies to
    // its other configurable numeric defaults (geofence accuracy, audio
    // retention).
    const webAcl = new wafv2.CfnWebACL(this, "WebAcl", {
      scope: "REGIONAL",
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        sampledRequestsEnabled: true,
        metricName: "MzaziCareWebAcl",
      },
      rules: [
        {
          name: "RateLimit",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "MzaziCareRateLimit",
          },
        },
        {
          name: "AwsIpReputationList",
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: "AWS",
              name: "AWSManagedRulesAmazonIpReputationList",
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            sampledRequestsEnabled: true,
            metricName: "MzaziCareIpReputationList",
          },
        },
      ],
    });

    new wafv2.CfnWebACLAssociation(this, "WebAclAssociation", {
      resourceArn: `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/${restApi.restApiId}/stages/${restApi.deploymentStage.stageName}`,
      webAclArn: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, "ApiUrl", { value: restApi.url });
  }
}
