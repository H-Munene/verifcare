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
import * as sns from "aws-cdk-lib/aws-sns";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as iam from "aws-cdk-lib/aws-iam";
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

    // Shared across two alert sources per architecture.md's "Alerts" row
    // (missed-visit alerts from this Lambda, cognitive-risk alerts from the
    // api/acoustic-model flow later) - not nested under missed-visit-sweep's
    // own naming. No email subscription created here: no real supervisor
    // email address has been settled anywhere yet, and that's account-
    // specific operational data, not infrastructure-as-code material. The
    // Message Data Protection add-on confirmed during the cost-estimate work
    // is deferred to the same follow-up issue as the real sweep logic below -
    // its actual data-identifier/action configuration was never specified,
    // and configuring it now would be scope creep beyond "stub the wiring."
    const alertsTopic = new sns.Topic(this, "AlertsTopic", {
      topicName: "mzazi-care-alerts",
    });

    // Stub only (HEZ-23) - see backend/src/missedVisitSweep.ts for why the
    // real query/SNS-publish logic is deliberately deferred, not built here.
    // Still VPC-attached to eu-west-1c and given the same environment
    // variables api has, even though the stub doesn't use them yet - matches
    // this project's consistent pattern of wiring networking/environment
    // ahead of the code that will need it.
    const missedVisitSweepFunction = new NodejsFunction(this, "MissedVisitSweepFunction", {
      entry: path.join(__dirname, "../../backend/src/missedVisitSweep.ts"),
      projectRoot: path.join(__dirname, "../../backend"),
      depsLockFilePath: path.join(__dirname, "../../backend/package-lock.json"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        subnetFilters: [ec2.SubnetFilter.availabilityZones(["eu-west-1c"])],
      },
      environment: {
        DATABASE_SECRET_ARN: databaseSecret.secretArn,
        ALERTS_TOPIC_ARN: alertsTopic.topicArn,
      },
    });

    database.connections.allowDefaultPortFrom(missedVisitSweepFunction);

    // Every 6 hours, not hourly - confirmed with the user 2026-09-13. This
    // changes the working assumption baked into the already-confirmed
    // Secrets Manager (800 API calls/month) and Lambda (720 invocations/
    // month) cost figures in project-state.md (hourly assumed ~720
    // invocations/month; every 6 hours is ~120/month) - flagged there as
    // needing a re-check, not recalculated here.
    new events.Rule(this, "MissedVisitSweepSchedule", {
      schedule: events.Schedule.rate(cdk.Duration.hours(6)),
      targets: [new eventsTargets.LambdaFunction(missedVisitSweepFunction)],
    });

    new cdk.CfnOutput(this, "MissedVisitSweepFunctionName", {
      value: missedVisitSweepFunction.functionName,
    });
    new cdk.CfnOutput(this, "AlertsTopicArn", { value: alertsTopic.topicArn });

    // Deliberately a separate topic from AlertsTopic - architecture.md's
    // Observability row says CloudWatch alarms are "distinct from the
    // business-facing SNS alerts" (missed-visit/cognitive-risk, sent to the
    // supervisor). This one is for operational/system health, not product
    // alerts. No email subscription yet, same reasoning as AlertsTopic - no
    // real recipient address is settled anywhere.
    const opsAlertsTopic = new sns.Topic(this, "OpsAlertsTopic", {
      topicName: "mzazi-care-ops-alerts",
    });
    const opsAlarmAction = new cloudwatchActions.SnsAction(opsAlertsTopic);

    // 5 alarms, 1 dashboard - matches the confirmed cost estimate ($0.51/
    // month). Errors only, one per current resource, not error+latency per
    // Lambda function as architecture.md's fuller text describes - confirmed
    // with the user 2026-09-13, since the literal text doesn't fit in 5 with
    // 2 functions + API Gateway + RDS all needing coverage. Latency alarms
    // and acoustic-model's own alarm are left for later, once there's a
    // concrete need to revisit the count.
    const apiFunctionErrorsAlarm = new cloudwatch.Alarm(this, "ApiFunctionErrorsAlarm", {
      alarmDescription: "api Lambda function errors",
      metric: apiFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    apiFunctionErrorsAlarm.addAlarmAction(opsAlarmAction);

    const missedVisitSweepErrorsAlarm = new cloudwatch.Alarm(this, "MissedVisitSweepErrorsAlarm", {
      alarmDescription: "missed-visit-sweep Lambda function errors",
      metric: missedVisitSweepFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    missedVisitSweepErrorsAlarm.addAlarmAction(opsAlarmAction);

    const apiGatewayErrorsAlarm = new cloudwatch.Alarm(this, "ApiGatewayErrorsAlarm", {
      alarmDescription: "REST API 5xx server errors",
      metric: restApi.metricServerError({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    apiGatewayErrorsAlarm.addAlarmAction(opsAlarmAction);

    const databaseCpuAlarm = new cloudwatch.Alarm(this, "DatabaseCpuAlarm", {
      alarmDescription: "RDS CPU utilization high",
      metric: database.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    databaseCpuAlarm.addAlarmAction(opsAlarmAction);

    const databaseStorageAlarm = new cloudwatch.Alarm(this, "DatabaseStorageAlarm", {
      alarmDescription: "RDS free storage space low",
      metric: database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) }),
      threshold: 2 * 1024 * 1024 * 1024, // 2 GiB, in bytes
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
    });
    databaseStorageAlarm.addAlarmAction(opsAlarmAction);

    new cloudwatch.Dashboard(this, "Dashboard", {
      dashboardName: "mzazi-care",
      widgets: [
        [
          new cloudwatch.GraphWidget({
            title: "Lambda errors",
            left: [
              apiFunction.metricErrors({ label: "api" }),
              missedVisitSweepFunction.metricErrors({ label: "missed-visit-sweep" }),
            ],
          }),
          new cloudwatch.GraphWidget({
            title: "API Gateway 5xx errors",
            left: [restApi.metricServerError()],
          }),
        ],
        [
          new cloudwatch.GraphWidget({
            title: "RDS CPU utilization",
            left: [database.metricCPUUtilization()],
          }),
          new cloudwatch.GraphWidget({
            title: "RDS free storage space",
            left: [database.metricFreeStorageSpace()],
          }),
        ],
      ],
    });

    new cdk.CfnOutput(this, "OpsAlertsTopicArn", { value: opsAlertsTopic.topicArn });

    // GitHub Actions OIDC federation for CI/CD (HEZ-26), not static AWS
    // access keys stored as GitHub secrets. The trust condition scopes this
    // role to exactly this repo's main branch - nothing else can assume it.
    // Its only permission is assuming the four roles `cdk bootstrap` already
    // created (HEZ-15) - those already have everything needed to deploy, so
    // this role just needs the ability to hop into them, not broad
    // permissions of its own.
    const githubOidcProvider = new iam.OpenIdConnectProvider(this, "GitHubOidcProvider", {
      url: "https://token.actions.githubusercontent.com",
      clientIds: ["sts.amazonaws.com"],
    });

    const githubDeployRole = new iam.Role(this, "GitHubDeployRole", {
      roleName: "mzazi-care-github-deploy",
      assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": "repo:H-Munene/mzazi_care:ref:refs/heads/main" },
      }),
    });

    githubDeployRole.addToPolicy(new iam.PolicyStatement({
      actions: ["sts:AssumeRole"],
      resources: [
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-cfn-exec-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-file-publishing-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-image-publishing-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-hnb659fds-lookup-role-${this.account}-${this.region}`,
      ],
    }));

    new cdk.CfnOutput(this, "GitHubDeployRoleArn", { value: githubDeployRole.roleArn });
  }
}
