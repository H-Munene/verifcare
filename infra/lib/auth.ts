import * as cdk from "aws-cdk-lib/core";
import * as cognito from "aws-cdk-lib/aws-cognito";

export interface Auth {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
}

export function createAuth(stack: cdk.Stack): Auth {
  const userPool = new cognito.UserPool(stack, "UserPool", {
    userPoolName: "mzazi-care-users",
    selfSignUpEnabled: true,
    signInAliases: { email: true, phone: true },
    autoVerify: { email: true, phone: true },
    standardAttributes: {
      fullname: { required: true, mutable: true },
    },
    customAttributes: {
      role: new cognito.StringAttribute({ minLen: 1, maxLen: 20, mutable: true }),
    },
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  const userPoolClient = userPool.addClient("UserPoolClient", {
    authFlows: {
      userSrp: true,
    },
    generateSecret: false,
    disableOAuth: true,
    // custom:role is deliberately excluded from this client's writable attributes (HEZ-29,
    // 2026-09-13, a real finding not a hypothetical): without this, Cognito's default lets ANY
    // self-signing-up user set custom:role to anything - including "supervisor" - via the public
    // SignUp/UpdateUserAttributes APIs, with zero backend involvement. The custom attribute stays
    // `mutable: true` above (it must, so a role can still be assigned at all), but role assignment
    // now only happens via AdminUpdateUserAttributes, an IAM-authenticated API this client cannot
    // call - only the api Lambda's execution role can (see infra/lib/api.ts). Read access is left
    // at the default (permissive): this fix only needed to close the write path.
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
  });

  new cdk.CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
  new cdk.CfnOutput(stack, "UserPoolClientId", {
    value: userPoolClient.userPoolClientId,
  });

  return { userPool, userPoolClient };
}
