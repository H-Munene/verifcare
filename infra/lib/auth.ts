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
    // Password-reset codes go by email only (2026-09-26, mobile forgot-password flow). Left unset,
    // Cognito tries a verified phone number first - this pool's recovery order was
    // verified_phone_number, then verified_email - which would text Kenyan numbers (the still-open
    // SMS pricing question since HEZ-17) instead of emailing the address the user just typed.
    accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });

  // On every app client below (2026-09-26, user decision): an unknown email gets the same answer
  // as a known one, so the public forgot-password and sign-in calls can't be used to find out
  // which emails are registered. ForgotPassword then "succeeds" for an unknown email without
  // sending anything, and sign-in with an unknown email reads as a wrong email or password.
  const preventUserExistenceErrors = true;

  const userPoolClient = userPool.addClient("UserPoolClient", {
    authFlows: {
      userSrp: true,
    },
    generateSecret: false,
    disableOAuth: true,
    preventUserExistenceErrors,
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

  // A separate app client for the caregiver Flutter mobile app (2026-09-14, HEZ-63 scaffold),
  // rather than reusing the web app's client above - each distinct client application gets its
  // own app client id, per AWS's own guidance ("An app client might be linked to the code
  // platform of an app... you might create an app for a server-side application and a different
  // Android app. Each app has its own app client ID." -
  // https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-client-apps.html).
  // This lets the mobile app's token validity, revocation, or auth-flow config change
  // independently of the web app later without touching either one. Same security posture as the
  // web client: SRP-only, no secret (a mobile app is a public client, same as a browser), no
  // OAuth, and custom:role stays non-writable for the same privilege-escalation reason as above.
  const caregiverAppUserPoolClient = userPool.addClient("CaregiverAppUserPoolClient", {
    authFlows: {
      userSrp: true,
    },
    generateSecret: false,
    disableOAuth: true,
    preventUserExistenceErrors,
    writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
  });

  // A separate app client for the family-member Flutter mobile app (2026-09-14, HEZ-76
  // scaffold), same "one app client per application" reasoning as the caregiver client above -
  // this app is also a fully separate Flutter project (no shared workspace with the caregiver
  // app, per the user's explicit correction). Same security posture: SRP-only, no secret, no
  // OAuth, custom:role non-writable. This client's own self-service SignUp flow is what lets a
  // brand-new family member register themselves in Cognito directly (selfSignUpEnabled above);
  // their role only gets set afterward via POST /users -> AdminUpdateUserAttributes, never by
  // this client writing custom:role itself, so the privilege-escalation protection above still
  // holds.
  //
  // Unlike the other two clients, this one's writeAttributes also includes email and
  // phoneNumber, not just fullname - real bug found and fixed 2026-09-14, not hypothetical: the
  // other two clients never call the SignUp API (their identities are always created by a
  // supervisor via AdminCreateUser, an IAM-authenticated call with no writeAttributes
  // restriction at all), but this client's self-service SignUp call sets email, phone_number,
  // and name itself, and Cognito rejected it with "NotAuthorizedException: A client attempted to
  // write unauthorized attribute" once writeAttributes only listed fullname. custom:role is still
  // deliberately absent from this list, so the privilege-escalation protection is unaffected.
  const familyMemberAppUserPoolClient = userPool.addClient("FamilyMemberAppUserPoolClient", {
    authFlows: {
      userSrp: true,
    },
    generateSecret: false,
    disableOAuth: true,
    preventUserExistenceErrors,
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
