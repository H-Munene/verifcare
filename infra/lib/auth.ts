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
  });

  new cdk.CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
  new cdk.CfnOutput(stack, "UserPoolClientId", {
    value: userPoolClient.userPoolClientId,
  });

  return { userPool, userPoolClient };
}
