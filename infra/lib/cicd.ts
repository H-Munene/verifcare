import * as cdk from "aws-cdk-lib/core";
import * as iam from "aws-cdk-lib/aws-iam";

export function createCicd(stack: cdk.Stack): void {
  // GitHub Actions OIDC role, assumable only from this repo's main branch.
  // It can only assume the cdk bootstrap roles, which do the actual deploy.
  const githubOidcProvider = new iam.OpenIdConnectProvider(stack, "GitHubOidcProvider", {
    url: "https://token.actions.githubusercontent.com",
    clientIds: ["sts.amazonaws.com"],
  });

  const githubDeployRole = new iam.Role(stack, "GitHubDeployRole", {
    roleName: "mzazi-care-github-deploy",
    assumedBy: new iam.OpenIdConnectPrincipal(githubOidcProvider, {
      StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
      StringLike: { "token.actions.githubusercontent.com:sub": "repo:H-Munene/mzazi_care:ref:refs/heads/main" },
    }),
  });

  githubDeployRole.addToPolicy(new iam.PolicyStatement({
    actions: ["sts:AssumeRole"],
    resources: [
      `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-cfn-exec-role-${stack.account}-${stack.region}`,
      `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-file-publishing-role-${stack.account}-${stack.region}`,
      `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-image-publishing-role-${stack.account}-${stack.region}`,
      `arn:aws:iam::${stack.account}:role/cdk-hnb659fds-lookup-role-${stack.account}-${stack.region}`,
    ],
  }));

  new cdk.CfnOutput(stack, "GitHubDeployRoleArn", { value: githubDeployRole.roleArn });
}
