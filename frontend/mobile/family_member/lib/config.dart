// Deployed Cognito and API Gateway ids. None of these are secret.
class AppConfig {
  static const String userPoolId = 'eu-west-1_901G3wGkr';

  // CfnOutput FamilyMemberUserPoolClientId.
  static const String familyMemberUserPoolClientId = '7b63vkbmrooqvu4g5to6c1gtvk';

  // The deployed API, since the app runs on a physical phone where localhost isn't the dev machine.
  static const String apiBaseUrl = 'https://1fipq7yhjd.execute-api.eu-west-1.amazonaws.com/prod';
}
