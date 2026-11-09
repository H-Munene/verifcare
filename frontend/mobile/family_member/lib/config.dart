// Deployed Cognito and API Gateway ids. None of these are secret.
class AppConfig {
  static const String userPoolId = 'eu-west-1_DyvwyuZL6';

  // CfnOutput FamilyMemberUserPoolClientId.
  static const String familyMemberUserPoolClientId = '6b3lpmgevup4tn8vej9m0j4ij2';

  // The deployed API, since the app runs on a physical phone where localhost isn't the dev machine.
  static const String apiBaseUrl = 'https://l4n2gm07ok.execute-api.eu-west-1.amazonaws.com/prod';
}
