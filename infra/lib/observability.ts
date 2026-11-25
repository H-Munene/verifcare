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
  database: rds.IDatabaseInstance;
}

export function createObservability(stack: cdk.Stack, params: ObservabilityParams): void {
  const { apiFunction, missedVisitSweepFunction, restApi, database } = params;

  // System health alarms, kept separate from the product AlertsTopic.
  // No subscriptions yet.
  const opsAlertsTopic = new sns.Topic(stack, "OpsAlertsTopic", {
    topicName: "mzazi-care-ops-alerts",
  });
  const opsAlarmAction = new cloudwatchActions.SnsAction(opsAlertsTopic);

  // Error alarms only, one per resource, to stay within the 5-alarm budget.
  // TODO: latency alarms and an acoustic-model alarm.
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
