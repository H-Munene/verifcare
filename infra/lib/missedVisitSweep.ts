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

  // Shared by missed-visit and cognitive-risk alerts. No subscriptions yet.
  const alertsTopic = new sns.Topic(stack, "AlertsTopic", {
    topicName: "mzazi-care-alerts",
  });

  // The handler is still a stub, but it gets the same VPC and env as api.
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

  // Every 6 hours.
  new events.Rule(stack, "MissedVisitSweepSchedule", {
    schedule: events.Schedule.rate(cdk.Duration.hours(6)),
    targets: [new eventsTargets.LambdaFunction(missedVisitSweepFunction)],
  });

  new cdk.CfnOutput(stack, "MissedVisitSweepFunctionName", {
    value: missedVisitSweepFunction.functionName,
  });
  new cdk.CfnOutput(stack, "AlertsTopicArn", { value: alertsTopic.topicArn });

  return { alertsTopic, missedVisitSweepFunction };
}
