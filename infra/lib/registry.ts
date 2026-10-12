import * as cdk from "aws-cdk-lib/core";
import * as ecr from "aws-cdk-lib/aws-ecr";

export function createRegistry(stack: cdk.Stack): ecr.Repository {
  // Only acoustic-model is a container image; api is a zip Lambda.
  const acousticModelRepository = new ecr.Repository(stack, "AcousticModelRepository", {
    repositoryName: "acoustic-model",
    imageScanOnPush: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
    lifecycleRules: [
      {
        description: "Expire untagged images after 14 days",
        tagStatus: ecr.TagStatus.UNTAGGED,
        maxImageAge: cdk.Duration.days(14),
      },
    ],
  });

  new cdk.CfnOutput(stack, "AcousticModelRepositoryUri", {
    value: acousticModelRepository.repositoryUri,
  });

  return acousticModelRepository;
}
