import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rekognition from "aws-cdk-lib/aws-rekognition";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";

export interface ApiParams {
  vpc: ec2.Vpc;
  database: rds.DatabaseInstance;
  databaseSecret: rds.DatabaseSecret;
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  caregiverAppUserPoolClient: cognito.UserPoolClient;
  familyMemberAppUserPoolClient: cognito.UserPoolClient;
  biometricEnrollmentsBucket: s3.Bucket;
  visitAudioBucket: s3.Bucket;
  biometricFacesCollection: rekognition.CfnCollection;
}

export interface Api {
  apiFunction: NodejsFunction;
  restApi: apigateway.LambdaRestApi;
}

export function createApi(stack: cdk.Stack, params: ApiParams): Api {
  const {
    vpc,
    database,
    databaseSecret,
    userPool,
    userPoolClient,
    caregiverAppUserPoolClient,
    familyMemberAppUserPoolClient,
    biometricEnrollmentsBucket,
    visitAudioBucket,
    biometricFacesCollection,
  } = params;

  // acoustic-model's Lambda function is deliberately not created yet: it's a
  // container-image Lambda, and the ECR repository above has no image in it
  // yet (the real acoustic-model implementation is later work, Linear
  // HEZ-43 onward) - CDK cannot create a container-image Lambda against an
  // empty repository. api's function is created now since the Express app
  // it wraps already exists and is tested (HEZ-7), even though it currently
  // only has a health-check route.
  const apiFunction = new NodejsFunction(stack, "ApiFunction", {
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
      // All three app clients (web, caregiver mobile, family-member mobile) must be passed
      // through so the Lambda's ID token verifier accepts tokens from any of them - a real bug
      // (2026-09-14): passing only the web client id made every mobile sign-in fail backend
      // calls with a generic 401, even though the token itself was perfectly valid. See
      // backend/src/config.ts and backend/src/auth/verifier.ts.
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      CAREGIVER_USER_POOL_CLIENT_ID: caregiverAppUserPoolClient.userPoolClientId,
      FAMILY_MEMBER_USER_POOL_CLIENT_ID: familyMemberAppUserPoolClient.userPoolClientId,
      BIOMETRIC_ENROLLMENTS_BUCKET_NAME: biometricEnrollmentsBucket.bucketName,
      VISIT_AUDIO_BUCKET_NAME: visitAudioBucket.bucketName,
      BIOMETRIC_FACES_COLLECTION_ID: biometricFacesCollection.collectionId,
    },
  });

  // Network-level access (the security group rule letting api reach RDS's
  // port) - matches architecture.md's "Networking (VPC layout)" section,
  // which is settled.
  database.connections.allowDefaultPortFrom(apiFunction);

  // Lets api's Lambda-to-Drizzle connection (backend/src/db/lambdaDb.ts)
  // resolve DB credentials at runtime - scoped to this secret's ARN and its
  // KMS key, not a wildcard grant.
  databaseSecret.grantRead(apiFunction);

  // Lets api's POST /users complete a genuinely new self-signup by assigning
  // custom:role server-side (HEZ-29) - the only way that attribute can be
  // set at all now that the app client's own write access to it was removed
  // (see infra/lib/auth.ts). Scoped to this user pool only, not a wildcard.
  userPool.grant(apiFunction, "cognito-idp:AdminUpdateUserAttributes");

  // Lets the supervisor web app register a dependant's primary/family
  // contact who has never touched Cognito at all, not just link an existing
  // identity (2026-09-14, extending HEZ-30/HEZ-56's family-member linking).
  // Scoped to this user pool only, not a wildcard - same pattern as the
  // grant above.
  userPool.grant(apiFunction, "cognito-idp:AdminCreateUser");

  // Lets api's biometric-enrollment upload flow (HEZ-31) sign a presigned PUT
  // URL that S3 will actually honor - a presigned URL is only valid if the
  // signing principal's own IAM policy allows the signed action, so grantPut
  // is required even though the Lambda itself never uploads the bytes.
  // grantRead covers both the confirm-time HeadObject existence check and
  // Rekognition's own need to read the S3 object when the Lambda calls
  // DetectFaces with an S3Object reference instead of downloading the image.
  biometricEnrollmentsBucket.grantPut(apiFunction);
  biometricEnrollmentsBucket.grantRead(apiFunction);

  // Lets api's biometric-enrollment confirm endpoint (HEZ-31) call
  // Rekognition DetectFaces to compute biometric_enrollments.quality_score.
  // rekognition:DetectFaces does not support resource-level permissions
  // (confirmed against AWS's Service Authorization Reference - every
  // Rekognition action with no resource type listed there requires
  // Resource: "*"), so the only controllable least-privilege axis is the
  // action itself - scoped to this one action, not a wildcard
  // "rekognition:*" grant.
  apiFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["rekognition:DetectFaces"],
      resources: ["*"],
    }),
  );

  // Lets api's biometric-enrollment confirm/approve endpoints (HEZ-85) search and add to the
  // enrollment-uniqueness Rekognition Collection, and lets offboarding cleanup remove from it.
  // Unlike DetectFaces above, these three actions DO support resource-level permissions scoped to
  // a specific collection (confirmed directly against AWS's own "How Amazon Rekognition works with
  // IAM" guide, which gives exactly this ARN shape as a real example) - scoped to this one
  // collection, not every collection in the account.
  apiFunction.addToRolePolicy(
    new iam.PolicyStatement({
      actions: ["rekognition:IndexFaces", "rekognition:SearchFacesByImage", "rekognition:DeleteFaces"],
      resources: [biometricFacesCollection.attrArn],
    }),
  );

  new cdk.CfnOutput(stack, "ApiFunctionName", {
    value: apiFunction.functionName,
  });

  const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
    stack,
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
  const restApi = new apigateway.LambdaRestApi(stack, "RestApi", {
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
  const webAcl = new wafv2.CfnWebACL(stack, "WebAcl", {
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

  new wafv2.CfnWebACLAssociation(stack, "WebAclAssociation", {
    resourceArn: `arn:${cdk.Aws.PARTITION}:apigateway:${cdk.Aws.REGION}::/restapis/${restApi.restApiId}/stages/${restApi.deploymentStage.stageName}`,
    webAclArn: webAcl.attrArn,
  });

  new cdk.CfnOutput(stack, "ApiUrl", { value: restApi.url });

  return { apiFunction, restApi };
}
