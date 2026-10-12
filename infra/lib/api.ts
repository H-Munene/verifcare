import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
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
  } = params;

  // No acoustic-model Lambda yet: CDK can't create a container-image Lambda
  // until the ECR repository has an image.
  const apiFunction = new NodejsFunction(stack, "ApiFunction", {
    // Absolute path: under tsx, NodejsFunction can't resolve relative entries.
    entry: path.join(__dirname, "../../backend/src/lambda.ts"),
    // backend/ has its own lockfile, so projectRoot has to point there too.
    projectRoot: path.join(__dirname, "../../backend"),
    depsLockFilePath: path.join(__dirname, "../../backend/package-lock.json"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    vpc,
    // Single AZ, like RDS. PRIVATE_WITH_EGRESS alone would also pick eu-west-1a.
    vpcSubnets: {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      subnetFilters: [ec2.SubnetFilter.availabilityZones(["eu-west-1c"])],
    },
    environment: {
      DATABASE_SECRET_ARN: databaseSecret.secretArn,
      USER_POOL_ID: userPool.userPoolId,
      // The token verifier must accept tokens from all three app clients.
      USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId,
      CAREGIVER_USER_POOL_CLIENT_ID: caregiverAppUserPoolClient.userPoolClientId,
      FAMILY_MEMBER_USER_POOL_CLIENT_ID: familyMemberAppUserPoolClient.userPoolClientId,
      BIOMETRIC_ENROLLMENTS_BUCKET_NAME: biometricEnrollmentsBucket.bucketName,
      VISIT_AUDIO_BUCKET_NAME: visitAudioBucket.bucketName,
    },
  });

  // Security group rule letting api reach RDS.
  database.connections.allowDefaultPortFrom(apiFunction);

  // For backend/src/db/lambdaDb.ts to read DB credentials at runtime.
  databaseSecret.grantRead(apiFunction);

  // POST /users sets custom:role server-side; app clients can't write it.
  userPool.grant(apiFunction, "cognito-idp:AdminUpdateUserAttributes");

  // Lets supervisors create Cognito users for new family contacts.
  userPool.grant(apiFunction, "cognito-idp:AdminCreateUser");

  new cdk.CfnOutput(stack, "ApiFunctionName", {
    value: apiFunction.functionName,
  });

  const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(
    stack,
    "CognitoAuthorizer",
    { cognitoUserPools: [userPool] },
  );

  // REST API rather than HTTP API because WAF can't be attached to HTTP APIs.
  // Proxy mode sends everything to Express.
  const restApi = new apigateway.LambdaRestApi(stack, "RestApi", {
    restApiName: "mzazi-care-api",
    handler: apiFunction,
    proxy: true,
    defaultMethodOptions: {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: cognitoAuthorizer,
    },
  });

  // WAF: a rate-based rule plus the AWS managed IP reputation list.
  // The rate limit (2000 req / 5 min / IP) is a placeholder, not yet reviewed.
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
