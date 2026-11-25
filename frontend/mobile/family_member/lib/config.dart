// Deployed Cognito and API Gateway ids. None of these are secret.
class AppConfig {
  static const String userPoolId = 'eu-west-1_bBLdq7eZm';

  // CfnOutput FamilyMemberUserPoolClientId.
  static const String familyMemberUserPoolClientId = '7d0fdlfn3isonmgaatmrvtnmd2';

  // The deployed API, since the app runs on a physical phone where localhost isn't the dev machine.
  static const String apiBaseUrl = 'https://tufk7s369e.execute-api.eu-west-1.amazonaws.com/prod';
}
