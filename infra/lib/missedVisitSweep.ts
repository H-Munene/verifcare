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

  // Stub only (HEZ-23) - see backend/src/missedVisitSweep.ts for why the
  // real query/SNS-publish logic is deliberately deferred, not built here.
  // Still VPC-attached to eu-west-1c and given the same environment
  // variables api has, even though the stub doesn't use them yet - matches
  // this project's consistent pattern of wiring networking/environment
  // ahead of the code that will need it.
  const missedVisitSweepFunction = new NodejsFunction(stack, "MissedVisitSweepFunction", {
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

  // Every 15 minutes (user decision 2026-09-24, replacing the earlier
  // every-6-hours choice): the caregiver app's calendar turns a day red as
  // soon as a visit is marked missed, and a 6-hour lag made that signal
  // useless on the day. ~2,880 invocations/month stays inside the Lambda
  // free tier; worst case (a cold start per run) is ~2,880 Secrets Manager
  // GetSecretValue calls/month, about $0.015 - flagged in project-state.md.
  new events.Rule(stack, "MissedVisitSweepSchedule", {
    schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    targets: [new eventsTargets.LambdaFunction(missedVisitSweepFunction)],
  });

  new cdk.CfnOutput(stack, "MissedVisitSweepFunctionName", {
    value: missedVisitSweepFunction.functionName,
  });
  new cdk.CfnOutput(stack, "AlertsTopicArn", { value: alertsTopic.topicArn });

  return { alertsTopic, missedVisitSweepFunction };
}
