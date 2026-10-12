import * as cdk from "aws-cdk-lib/core";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Match, Template } from "aws-cdk-lib/assertions";
import { createWeb } from "../lib/web";

// Needs frontend/web/dist to exist (cdk.json's "build", or `npm run build` in frontend/web).
function webTemplate(): Template {
  const stack = new cdk.Stack(new cdk.App(), "WebTestStack");
  const restApi = new apigateway.RestApi(stack, "Api");
  restApi.root.addMethod("GET", new apigateway.MockIntegration());
  const userPool = new cognito.UserPool(stack, "Pool");
  const userPoolClient = userPool.addClient("Client");
  createWeb(stack, { restApi, userPool, userPoolClient });
  return Template.fromStack(stack);
}

test("the web bucket is private and is not an S3 website", () => {
  const template = webTemplate();
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
    WebsiteConfiguration: Match.absent(),
  });
});

test("CloudFront reads the bucket through OAC and falls back to index.html for app routes", () => {
  const template = webTemplate();
  template.resourceCountIs("AWS::CloudFront::OriginAccessControl", 1);
  template.hasResourceProperties("AWS::CloudFront::Distribution", {
    DistributionConfig: Match.objectLike({
      DefaultRootObject: "index.html",
      DefaultCacheBehavior: Match.objectLike({ ViewerProtocolPolicy: "redirect-to-https" }),
      CustomErrorResponses: [403, 404].map((code) => ({
        ErrorCode: code,
        ResponseCode: 200,
        ResponsePagePath: "/index.html",
        ErrorCachingMinTTL: 0,
      })),
    }),
  });
});
