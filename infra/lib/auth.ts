import * as cdk from "aws-cdk-lib/core";
import * as cognito from "aws-cdk-lib/aws-cognito";

export interface Auth {
  userPool: cognito.UserPool;
  userPoolClient: cognito.UserPoolClient;
  caregiverAppUserPoolClient: cognito.UserPoolClient;
  familyMemberAppUserPoolClient: cognito.UserPoolClient;
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
    // custom:role must not be writable, or any self-signup could make itself a supervisor.
    // Roles are set by the api Lambda via AdminUpdateUserAttributes.
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
  });

  // Caregiver mobile app client. Public client: SRP-only, no secret, custom:role not writable.
  const caregiverAppUserPoolClient = userPool.addClient("CaregiverAppUserPoolClient", {
    authFlows: {
      userSrp: true,
    },
    generateSecret: false,
    disableOAuth: true,
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
  });

  // Family-member mobile app client. Same setup as the caregiver client, but family members sign
  // themselves up, so SignUp needs email and phoneNumber to be writable. Their role is set later
  // by POST /users.
  const familyMemberAppUserPoolClient = userPool.addClient("FamilyMemberAppUserPoolClient", {
    authFlows: {
      userSrp: true,
    },
    generateSecret: false,
    disableOAuth: true,
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({
      fullname: true,
      email: true,
      phoneNumber: true,
    }),
  });

  new cdk.CfnOutput(stack, "UserPoolId", { value: userPool.userPoolId });
  new cdk.CfnOutput(stack, "UserPoolClientId", {
    value: userPoolClient.userPoolClientId,
  });
  new cdk.CfnOutput(stack, "CaregiverUserPoolClientId", {
    value: caregiverAppUserPoolClient.userPoolClientId,
  });
  new cdk.CfnOutput(stack, "FamilyMemberUserPoolClientId", {
    value: familyMemberAppUserPoolClient.userPoolClientId,
  });

  return {
    userPool,
    userPoolClient,
    caregiverAppUserPoolClient,
    familyMemberAppUserPoolClient,
  };
}
