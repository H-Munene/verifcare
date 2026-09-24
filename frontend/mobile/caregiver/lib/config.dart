// The real, deployed Cognito User Pool and API Gateway - same non-secret values documented
// elsewhere in this repo (see backend/.env.example, frontend/web/.env.example,
// frontend/mobile/family_member/lib/config.dart). Checked in directly rather than via an env
// file/package - there is nothing here to keep out of source control.
class AppConfig {
  static const String userPoolId = 'eu-west-1_901G3wGkr';

  // infra/lib/auth.ts's CaregiverAppUserPoolClient, CfnOutput CaregiverUserPoolClientId.
  static const String caregiverUserPoolClientId = '4th550b5rk8st5fmgfdio465tr';

  // Points at the real deployed API Gateway, not localhost - this app is tested on a physical
  // phone, where "localhost" would resolve to the phone itself, not the dev machine. Not used by
  // anything yet (login is the only screen so far), but kept here matching the family-member
  // app's own config shape, since the next piece of work will need it.
  static const String apiBaseUrl = 'https://1fipq7yhjd.execute-api.eu-west-1.amazonaws.com/prod';
}
