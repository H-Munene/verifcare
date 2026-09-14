import 'package:amazon_cognito_identity_dart_2/cognito.dart';

import '../api/users_api.dart';
import 'cognito_auth_service.dart';

/// Shared by both entry points that can land on a role-less identity: the sign-up chain
/// (ConfirmSignUpScreen, right after a brand-new signup confirms and signs in for the first time)
/// and the plain Login screen (a returning user who confirmed their sign-up but closed the app
/// before finishing registration). Both cases need the same fix: call POST /users, then force a
/// fresh ID token so the newly-assigned role is actually usable for the next request - see
/// CognitoAuthService.refreshIdentity's doc comment for why the refresh step can't be skipped.
///
/// If the identity already has a role (a supervisor created this family member's Cognito identity
/// directly, so it was never role-less to begin with), this is a no-op that just returns it.
Future<IdentityClaims> completeSelfRegistrationIfNeeded(
  CognitoAuthService authService,
  UsersApi usersApi,
  CognitoUserSession session,
) async {
  final identity = authService.decodeIdentity(session);
  if (identity.role != null) {
    return identity;
  }

  final email = identity.email;
  final phoneNumber = identity.phoneNumber;
  final fullName = identity.fullName;
  if (email == null || phoneNumber == null || fullName == null) {
    throw Exception(
      'Cannot complete registration: the ID token is missing email, phone_number, or name.',
    );
  }

  await usersApi.registerSelf(
    cognitoSub: identity.sub,
    email: email,
    phoneNumber: phoneNumber,
    fullName: fullName,
  );

  return authService.refreshIdentity(session);
}
