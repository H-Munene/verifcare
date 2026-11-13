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
  visitAudioBucket: s3.Bucket;
  voiceFunction: lambda.IFunction;
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
    visitAudioBucket,
    voiceFunction,
  } = params;

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
    // A visit recording's upload waits on the voice check (up to 20 s, backend/src/voiceService.ts),
    // so this sits just under API Gateway's 29 s limit. The default was 3 s.
    timeout: cdk.Duration.seconds(28),
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
      CAREGIVER_USER_POOL_CLIENT_ID:
        caregiverAppUserPoolClient.userPoolClientId,
      FAMILY_MEMBER_USER_POOL_CLIENT_ID:
        familyMemberAppUserPoolClient.userPoolClientId,
      VISIT_AUDIO_BUCKET_NAME: visitAudioBucket.bucketName,
      VOICE_FUNCTION_NAME: voiceFunction.functionName,
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
  // Also used by POST /caregivers (2026-09-22, HEZ-54) - a caregiver never
  // self-registers, so every caregiver's Cognito identity is created here
  // too, not just linked. Scoped to this user pool only, not a wildcard -
  // same pattern as the grant above.
  userPool.grant(apiFunction, "cognito-idp:AdminCreateUser");

  // Lets api sign presigned URLs for the visit recording that S3 will honor: a presigned URL is
  // only valid if the signing principal's own IAM policy allows the signed action, so grantPut and
  // grantRead are needed even though the Lambda never handles the audio bytes. grantRead also covers
  // the size check at confirm time and the KMS decrypt that playback needs.
  visitAudioBucket.grantPut(apiFunction);
  visitAudioBucket.grantRead(apiFunction);

  // The voice check (2026-11-13): api calls the voice Lambda, and nothing else may.
  voiceFunction.grantInvoke(apiFunction);

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
  // A browser's CORS preflight is an unauthenticated OPTIONS request by definition - without this,
  // it would hit the same Cognito-authorized proxy method every other verb does and get rejected
  // before ever reaching Express, which is exactly the gap frontend/web/.env's own comment flagged
  // ("pointing this at the real deployed ApiUrl... needs a CORS entry added... first - not done
  // yet"). `defaultCorsPreflightOptions` makes CDK add a separate, unauthenticated mock OPTIONS
  // integration per resource just for this. Origin left wide open deliberately, not restricted to
  // one deployed frontend origin: this API's real authorization boundary is the Cognito JWT
  // authorizer on every actual method, never CORS itself (a non-browser client can already call it
  // from anywhere regardless of these headers) - the same reasoning app.ts's own permissive cors()
  // and storage.ts's biometric-enrollments bucket CORS already rely on. X-Checkin-Session-Token
  // added on top of the default header allowlist since the check-in flow (HEZ-33/34/35) sends it
  // as a real custom header, not one of API Gateway's own CORS defaults.
  const restApi = new apigateway.LambdaRestApi(stack, "RestApi", {
    restApiName: "mzazi-care-api",
    handler: apiFunction,
    proxy: true,
    defaultCorsPreflightOptions: {
      allowOrigins: apigateway.Cors.ALL_ORIGINS,
      allowMethods: apigateway.Cors.ALL_METHODS,
      allowHeaders: [
        ...apigateway.Cors.DEFAULT_HEADERS,
        "X-Checkin-Session-Token",
      ],
    },
    defaultMethodOptions: {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: cognitoAuthorizer,
    },
    // Stage-wide throttle (2026-10-12). Without it the only cap was the account's 10,000 req/s,
    // and a burst could scale the api Lambda far enough to exhaust db.t4g.micro's connections
    // (each environment holds a pool of 2). 50 req/s steady, bursting to 100, is far above this
    // project's real traffic while keeping Lambda concurrency, and so RDS connections, bounded.
    // Requests over it get a 429 from API Gateway. Per-client limits are WAF's job (below).
    deployOptions: {
      throttlingRateLimit: 50,
      throttlingBurstLimit: 100,
    },
  });

  // API Gateway's own error responses (authorizer 401s, throttling 429s, 5xx) carry no CORS
  // headers by default, so a browser hides them behind a generic "Failed to fetch" and the web
  // console can't tell an expired session or a rate limit from a network failure.
  const corsErrorHeaders = { "Access-Control-Allow-Origin": "'*'" };
  restApi.addGatewayResponse("Default4xxResponse", {
    type: apigateway.ResponseType.DEFAULT_4XX,
    responseHeaders: corsErrorHeaders,
  });
  restApi.addGatewayResponse("Default5xxResponse", {
    type: apigateway.ResponseType.DEFAULT_5XX,
    responseHeaders: corsErrorHeaders,
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
        // 429 rather than WAF's default 403, so clients see "too many requests", not "forbidden";
        // with the CORS header so the browser lets the web console read it.
        action: {
          block: {
            customResponse: {
              responseCode: 429,
              responseHeaders: [{ name: "Access-Control-Allow-Origin", value: "*" }],
            },
          },
        },
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
