import * as path from "node:path";
import * as cdk from "aws-cdk-lib/core";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as events from "aws-cdk-lib/aws-events";
import * as eventsTargets from "aws-cdk-lib/aws-events-targets";

export interface MissedVisitSweepParams {
  vpc: ec2.Vpc;
  database: rds.DatabaseInstance;
  databaseSecret: rds.DatabaseSecret;
}

export interface MissedVisitSweep {
  alertsTopic: sns.Topic;
  missedVisitSweepFunction: NodejsFunction;
}

export function createMissedVisitSweep(
  stack: cdk.Stack,
  params: MissedVisitSweepParams,
): MissedVisitSweep {
  const { vpc, database, databaseSecret } = params;

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
  const alertsTopic = new sns.Topic(stack, "AlertsTopic", {
    topicName: "mzazi-care-alerts",
  });

  // Marks overdue scheduled/in_progress visits as missed (see
  // backend/src/missedVisitSweep.ts). VPC-attached to eu-west-1c, same as api,
  // since it queries RDS directly.
  const missedVisitSweepFunction = new NodejsFunction(stack, "MissedVisitSweepFunction", {
    entry: path.join(__dirname, "../../backend/src/missedVisitSweep.ts"),
    projectRoot: path.join(__dirname, "../../backend"),
    depsLockFilePath: path.join(__dirname, "../../backend/package-lock.json"),
    handler: "handler",
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    // Not the 3s default: a cold start fetches the DB secret and opens a TLS
    // connection to RDS before the query runs, which can exceed 3s - the same
    // reason migrationRunner.ts raises its own timeout.
    timeout: cdk.Duration.seconds(30),
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
  // The stub never read the secret, so this grant was never added - once the
  // real sweep logic shipped, every run failed with AccessDenied on
  // GetSecretValue before reaching the database (found 2026-09-24).
  databaseSecret.grantRead(missedVisitSweepFunction);

  // Every minute (2026-11-09): this also runs missed-visit recovery, where an offer lasts five
  // minutes and each one passing to the next caregiver is time a dependant is left waiting. About
  // 43,200 invocations a month, inside the Lambda free tier.
  new events.Rule(stack, "MissedVisitSweepSchedule", {
    schedule: events.Schedule.rate(cdk.Duration.minutes(1)),
    targets: [new eventsTargets.LambdaFunction(missedVisitSweepFunction)],
  });

  new cdk.CfnOutput(stack, "MissedVisitSweepFunctionName", {
    value: missedVisitSweepFunction.functionName,
  });
  new cdk.CfnOutput(stack, "AlertsTopicArn", { value: alertsTopic.topicArn });

  return { alertsTopic, missedVisitSweepFunction };
}
