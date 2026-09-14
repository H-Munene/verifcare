// The real, deployed Cognito User Pool and API Gateway - same non-secret values documented
// elsewhere in this repo (see backend/.env.example, frontend/web/.env.example,
// frontend/mobile/caregiver/lib/config.dart). Checked in directly rather than via an env
// file/package - there is nothing here to keep out of source control.
class AppConfig {
  static const String userPoolId = 'eu-west-1_901G3wGkr';

  // Deployed 2026-09-14 - infra/lib/auth.ts's FamilyMemberAppUserPoolClient, CfnOutput
  // FamilyMemberUserPoolClientId.
  static const String familyMemberUserPoolClientId = '7b63vkbmrooqvu4g5to6c1gtvk';

  // Points at the real deployed API Gateway, not localhost - this app is tested on a physical
  // phone, where "localhost" would resolve to the phone itself, not the dev machine. A native
  // app's HTTP client isn't subject to browser CORS restrictions either, so (unlike the web app)
  // pointing directly at the deployed API needs no separate CORS/infra change.
  static const String apiBaseUrl = 'https://1fipq7yhjd.execute-api.eu-west-1.amazonaws.com/prod';
}
