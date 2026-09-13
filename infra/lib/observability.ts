import * as cdk from "aws-cdk-lib/core";
import * as rds from "aws-cdk-lib/aws-rds";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cloudwatchActions from "aws-cdk-lib/aws-cloudwatch-actions";

export interface ObservabilityParams {
  apiFunction: NodejsFunction;
  missedVisitSweepFunction: NodejsFunction;
  restApi: apigateway.LambdaRestApi;
  database: rds.DatabaseInstance;
}

export function createObservability(stack: cdk.Stack, params: ObservabilityParams): void {
  const { apiFunction, missedVisitSweepFunction, restApi, database } = params;

  // Deliberately a separate topic from AlertsTopic - architecture.md's
  // Observability row says CloudWatch alarms are "distinct from the
  // business-facing SNS alerts" (missed-visit/cognitive-risk, sent to the
  // supervisor). This one is for operational/system health, not product
  // alerts. No email subscription yet, same reasoning as AlertsTopic - no
  // real recipient address is settled anywhere.
  const opsAlertsTopic = new sns.Topic(stack, "OpsAlertsTopic", {
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
  const apiFunctionErrorsAlarm = new cloudwatch.Alarm(stack, "ApiFunctionErrorsAlarm", {
    alarmDescription: "api Lambda function errors",
    metric: apiFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  });
  apiFunctionErrorsAlarm.addAlarmAction(opsAlarmAction);

  const missedVisitSweepErrorsAlarm = new cloudwatch.Alarm(stack, "MissedVisitSweepErrorsAlarm", {
    alarmDescription: "missed-visit-sweep Lambda function errors",
    metric: missedVisitSweepFunction.metricErrors({ period: cdk.Duration.minutes(5) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  });
  missedVisitSweepErrorsAlarm.addAlarmAction(opsAlarmAction);

  const apiGatewayErrorsAlarm = new cloudwatch.Alarm(stack, "ApiGatewayErrorsAlarm", {
    alarmDescription: "REST API 5xx server errors",
    metric: restApi.metricServerError({ period: cdk.Duration.minutes(5) }),
    threshold: 1,
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  });
  apiGatewayErrorsAlarm.addAlarmAction(opsAlarmAction);

  const databaseCpuAlarm = new cloudwatch.Alarm(stack, "DatabaseCpuAlarm", {
    alarmDescription: "RDS CPU utilization high",
    metric: database.metricCPUUtilization({ period: cdk.Duration.minutes(5) }),
    threshold: 80,
    evaluationPeriods: 3,
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
  });
  databaseCpuAlarm.addAlarmAction(opsAlarmAction);

  const databaseStorageAlarm = new cloudwatch.Alarm(stack, "DatabaseStorageAlarm", {
    alarmDescription: "RDS free storage space low",
    metric: database.metricFreeStorageSpace({ period: cdk.Duration.minutes(5) }),
    threshold: 2 * 1024 * 1024 * 1024, // 2 GiB, in bytes
    evaluationPeriods: 1,
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_OR_EQUAL_TO_THRESHOLD,
  });
  databaseStorageAlarm.addAlarmAction(opsAlarmAction);

  new cloudwatch.Dashboard(stack, "Dashboard", {
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

  new cdk.CfnOutput(stack, "OpsAlertsTopicArn", { value: opsAlertsTopic.topicArn });
}
