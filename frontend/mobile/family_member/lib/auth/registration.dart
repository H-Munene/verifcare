import 'package:amazon_cognito_identity_dart_2/cognito.dart';

import '../api/users_api.dart';
import 'cognito_auth_service.dart';

/// For an identity without a role: calls POST /users, then refreshes the ID token so the new role
/// is in it. Returns the identity unchanged if it already has a role.
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
