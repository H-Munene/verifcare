import 'package:amazon_cognito_identity_dart_2/cognito.dart';

import '../config.dart';
import 'shared_preferences_cognito_storage.dart';

// Thin wrapper around amazon_cognito_identity_dart_2, same shape as the web app's cognito.ts plus
// self-service sign-up.

// Decoded ID token claims, for display and for finishing self-registration (which needs
// phoneNumber/fullName). Not used for authorization.
class IdentityClaims {
  final String sub;
  final String? email;
  final String? phoneNumber;
  final String? fullName;
  final String? role;

  IdentityClaims({
    required this.sub,
    this.email,
    this.phoneNumber,
    this.fullName,
    this.role,
  });
}

/// Returned by [CognitoAuthService.signIn] when the account has a temporary password, e.g. one
/// created by a supervisor from the web app.
class NewPasswordRequiredChallenge {
  final CognitoUser _user;
  final List<String> requiredAttributes;

  NewPasswordRequiredChallenge(this._user, this.requiredAttributes);

  Future<CognitoUserSession> complete(String newPassword, {String? fullName}) async {
    final attributes = <String, String>{};
    if (requiredAttributes.contains('name') && fullName != null && fullName.isNotEmpty) {
      attributes['name'] = fullName;
    }
    final session = await _user.sendNewPasswordRequiredAnswer(
      newPassword,
      attributes.isEmpty ? null : attributes,
    );
    if (session == null) {
      throw Exception('Failed to complete the new-password challenge.');
    }
    return session;
  }
}

sealed class SignInResult {}

class SignInSuccess extends SignInResult {
  final CognitoUserSession session;
  SignInSuccess(this.session);
}

class SignInNewPasswordRequired extends SignInResult {
  final NewPasswordRequiredChallenge challenge;
  SignInNewPasswordRequired(this.challenge);
}

class CognitoAuthService {
  final CognitoUserPool _pool = CognitoUserPool(
    AppConfig.userPoolId,
    AppConfig.familyMemberUserPoolClientId,
    storage: SharedPreferencesCognitoStorage(),
  );

  /// Self-service sign-up.
  ///
  /// There's no verification-code step: Cognito's default email delivery is unreliable, so
  /// accounts are confirmed manually (`aws cognito-idp admin-confirm-sign-up`) until SES is set up.
  Future<void> signUp({
    required String email,
    required String phoneNumber,
    required String fullName,
    required String password,
  }) async {
    await _pool.signUp(
      email,
      password,
      userAttributes: [
        AttributeArg(name: 'email', value: email),
        AttributeArg(name: 'phone_number', value: phoneNumber),
        AttributeArg(name: 'name', value: fullName),
      ],
    );
  }

  Future<SignInResult> signIn(String email, String password) async {
    final user = CognitoUser(email, _pool);
    final authDetails = AuthenticationDetails(username: email, password: password);
    try {
      final session = await user.authenticateUser(authDetails);
      if (session == null) {
        throw Exception('Sign in failed: no session returned.');
      }
      return SignInSuccess(session);
    } on CognitoUserNewPasswordRequiredException catch (e) {
      // The package's SRP path doesn't strip the "userAttributes." prefix.
      const prefix = 'userAttributes.';
      final required = (e.requiredAttributes ?? const [])
          .map((attribute) => attribute.toString())
          .map((attribute) =>
              attribute.startsWith(prefix) ? attribute.substring(prefix.length) : attribute)
          .toList();
      return SignInNewPasswordRequired(NewPasswordRequiredChallenge(user, required));
    }
  }

  /// Forces a fresh ID token. Needed after POST /users assigns a role, since the current token
  /// doesn't have the custom:role claim yet.
  Future<IdentityClaims> refreshIdentity(CognitoUserSession session) async {
    final user = await _pool.getCurrentUser();
    final refreshToken = session.getRefreshToken();
    if (user == null || refreshToken == null) {
      throw Exception('Cannot refresh session: no current user or refresh token available.');
    }
    final refreshed = await user.refreshSession(refreshToken);
    if (refreshed == null) {
      throw Exception('Failed to refresh session.');
    }
    return decodeIdentity(refreshed);
  }

  /// Returns the cached session, refreshed if needed, or null.
  Future<CognitoUserSession?> getCurrentSession() async {
    final user = await _pool.getCurrentUser();
    if (user == null) {
      return null;
    }
    try {
      final session = await user.getSession();
      if (session == null || !session.isValid()) {
        return null;
      }
      return session;
    } on CognitoUserException {
      return null;
    }
  }

  /// Returns the signed-in identity from the cached session, or null.
  Future<IdentityClaims?> getCurrentIdentity() async {
    final session = await getCurrentSession();
    if (session == null) {
      return null;
    }
    return decodeIdentity(session);
  }

  IdentityClaims decodeIdentity(CognitoUserSession session) {
    final payload = session.getIdToken().payload as Map;
    final sub = payload['sub'];
    if (sub is! String) {
      throw Exception('ID token is missing the required "sub" claim.');
    }
    return IdentityClaims(
      sub: sub,
      email: payload['email'] as String?,
      phoneNumber: payload['phone_number'] as String?,
      fullName: payload['name'] as String?,
      role: payload['custom:role'] as String?,
    );
  }

  Future<String?> getIdToken() async {
    final user = await _pool.getCurrentUser();
    if (user == null) {
      return null;
    }
    final session = await user.getSession();
    if (session == null || !session.isValid()) {
      return null;
    }
    return session.getIdToken().getJwtToken();
  }

  Future<void> signOut() async {
    final user = await _pool.getCurrentUser();
    await user?.signOut();
  }
}
