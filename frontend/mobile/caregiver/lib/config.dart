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
  // Google Directions web-service key for the route to the dependant's home on the check-in map
  // (2026-09-26). Supplied at build time so it's never committed:
  //   flutter run --dart-define=DIRECTIONS_API_KEY=<key>
  // Empty means no route is drawn; the map works as before. It must be a key allowed to call the
  // Directions API - an Android-app-restricted Maps SDK key is refused by the web service.
  static const String directionsApiKey = String.fromEnvironment(
    'DIRECTIONS_API_KEY',
  );

  static const String apiBaseUrl =
      'https://1fipq7yhjd.execute-api.eu-west-1.amazonaws.com/prod';
}
