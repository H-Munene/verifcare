import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { MzaziCareStack } from "../lib/mzazicarestack";

// Synthesizes the whole stack (bundles the Lambdas, and needs frontend/web/dist like web.test.ts).
const template = Template.fromStack(
  new MzaziCareStack(new cdk.App(), "ApiTestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  }),
);

test("the API stage is throttled", () => {
  template.hasResourceProperties("AWS::ApiGateway::Stage", {
    MethodSettings: Match.arrayWith([
      Match.objectLike({
        HttpMethod: "*",
        ResourcePath: "/*",
        ThrottlingRateLimit: 50,
        ThrottlingBurstLimit: 100,
      }),
    ]),
  });
});

test("API Gateway's own 4xx and 5xx responses carry a CORS header", () => {
  for (const type of ["DEFAULT_4XX", "DEFAULT_5XX"]) {
    template.hasResourceProperties("AWS::ApiGateway::GatewayResponse", {
      ResponseType: type,
      ResponseParameters: {
        "gatewayresponse.header.Access-Control-Allow-Origin": "'*'",
      },
    });
  }
});

test("WAF's per-IP rate limit answers 429 with a CORS header", () => {
  template.hasResourceProperties("AWS::WAFv2::WebACL", {
    Rules: Match.arrayWith([
      Match.objectLike({
        Name: "RateLimit",
        Action: {
          Block: {
            CustomResponse: {
              ResponseCode: 429,
              ResponseHeaders: [{ Name: "Access-Control-Allow-Origin", Value: "*" }],
            },
          },
        },
        Statement: { RateBasedStatement: { Limit: 2000, AggregateKeyType: "IP" } },
      }),
    ]),
  });
});
