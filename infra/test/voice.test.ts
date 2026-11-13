import * as cdk from "aws-cdk-lib/core";
import { Match, Template } from "aws-cdk-lib/assertions";
import { MzaziCareStack } from "../lib/mzazicarestack";

// Synthesizes the whole stack (bundles the Lambdas, and needs frontend/web/dist like web.test.ts).
const template = Template.fromStack(
  new MzaziCareStack(new cdk.App(), "VoiceTestStack", {
    env: { account: "123456789012", region: "eu-west-1" },
  }),
);

const voiceFunction = () =>
  Object.entries(template.findResources("AWS::Lambda::Function", { Properties: { PackageType: "Image" } }));

test("the voice Lambda is one container image with no VPC", () => {
  const functions = voiceFunction();
  expect(functions).toHaveLength(1);
  const [, resource] = functions[0]!;
  expect(resource.Properties).toMatchObject({ MemorySize: 3008, Timeout: 60 });
  expect(resource.Properties.VpcConfig).toBeUndefined();
});

test("only the API may invoke it, and the API waits long enough for it", () => {
  const [voiceId] = voiceFunction()[0]!;
  const invokers = Object.values(template.findResources("AWS::IAM::Policy")).filter((policy) =>
    JSON.stringify(policy.Properties.PolicyDocument).includes('"lambda:InvokeFunction"') &&
    JSON.stringify(policy.Properties.PolicyDocument).includes(voiceId),
  );
  expect(invokers).toHaveLength(1);
  expect(JSON.stringify(invokers[0]!.Properties.Roles)).toContain("ApiFunction");

  template.hasResourceProperties("AWS::Lambda::Function", {
    Handler: "index.handler",
    Timeout: 28,
    Environment: { Variables: Match.objectLike({ VOICE_FUNCTION_NAME: { Ref: voiceId } }) },
  });
});

test("voiceprints have their own encrypted, private bucket and rotating key", () => {
  template.hasResourceProperties("AWS::KMS::Key", {
    Description: "Encrypts the voiceprint S3 bucket",
    EnableKeyRotation: true,
  });
  template.hasResourceProperties("AWS::S3::Bucket", {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        Match.objectLike({
          BucketKeyEnabled: true,
          ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: "aws:kms" }),
        }),
      ],
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });
});
