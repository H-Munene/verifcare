import 'package:amazon_cognito_identity_dart_2/cognito.dart';

import '../config.dart';
import 'shared_preferences_cognito_storage.dart';

// Thin wrapper around amazon_cognito_identity_dart_2, mirroring
// frontend/web/src/auth/cognito.ts's shape (signIn / completeNewPassword / getCurrentIdentity /
// signOut) - trimmed from frontend/mobile/family_member/lib/auth/cognito_auth_service.dart's own
// version, which this is a sibling of. No signUp() here at all - unlike a family member, a
// caregiver never self-registers, every caregiver identity is created by a supervisor via
// AdminCreateUser. No refreshIdentity() either - that only exists to pick up a role assigned
// *after* first token issuance (a family member's self-signup starts role-less), which can never
// happen here: custom:role: caregiver is already set in the same AdminCreateUser call that
// creates the identity, so it's on the very first token this app ever sees.

// Mirrors frontend/web/src/auth/cognito.ts's IdentityClaims, extended with phoneNumber/fullName.
// Decoded for display/convenience only - never trusted as an authorization decision, since only
// the backend's independent signature verification (aws-jwt-verify) is authoritative.
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

/// Returned by [CognitoAuthService.signIn] when the account still needs to set a permanent
/// password. Real, not hypothetical, for every caregiver's first sign-in specifically: every
/// caregiver identity is created via AdminCreateUser, which always issues a Cognito-generated
/// temporary password - there is no other way a caregiver identity gets created, so this
/// challenge isn't an edge case here, it's the only case on a first sign-in.
class NewPasswordRequiredChallenge {
  final CognitoUser _user;
  final List<String> requiredAttributes;

  NewPasswordRequiredChallenge(this._user, this.requiredAttributes);

  Future<CognitoUserSession> complete(
    String newPassword, {
    String? fullName,
  }) async {
    final attributes = <String, String>{};
    if (requiredAttributes.contains('name') &&
        fullName != null &&
        fullName.isNotEmpty) {
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

/// The account's password was reset by an administrator (AdminResetUserPassword, e.g. from the
/// Cognito console): Cognito refuses the old password and has already emailed a reset code, so
/// sign-in continues in the forgot-password screen's code step rather than failing outright.
class SignInPasswordResetRequired extends SignInResult {}

class CognitoAuthService {
  final CognitoUserPool _pool = CognitoUserPool(
    AppConfig.userPoolId,
    AppConfig.caregiverUserPoolClientId,
    storage: SharedPreferencesCognitoStorage(),
  );

  Future<SignInResult> signIn(String email, String password) async {
    final user = CognitoUser(email, _pool);
    final authDetails = AuthenticationDetails(
      username: email,
      password: password,
    );
    try {
      final session = await user.authenticateUser(authDetails);
      if (session == null) {
        throw Exception('Sign in failed: no session returned.');
      }
      return SignInSuccess(session);
    } on CognitoUserNewPasswordRequiredException catch (e) {
      // The package's SRP code path (used here, since this app client only allows
      // USER_SRP_AUTH) does not strip the raw Cognito API's "userAttributes." prefix from
      // requiredAttributes, unlike its own username/password code path - verified by reading the
      // package's source (cognito_user.dart) rather than assuming.
      const prefix = 'userAttributes.';
      final required = (e.requiredAttributes ?? const [])
          .map((attribute) => attribute.toString())
          .map(
            (attribute) => attribute.startsWith(prefix)
                ? attribute.substring(prefix.length)
                : attribute,
          )
          .toList();
      return SignInNewPasswordRequired(
        NewPasswordRequiredChallenge(user, required),
      );
    } on CognitoClientException catch (e) {
      if (e.code == 'PasswordResetRequiredException') {
        return SignInPasswordResetRequired();
      }
      rethrow;
    }
  }

  /// Starts self-service password reset: Cognito emails a code to the account's verified email
  /// (the pool's account recovery is email-only, see infra/lib/auth.ts). With user-existence
  /// errors prevented on this app client, an unknown email also completes normally without
  /// sending anything, so the screen must not claim a code was definitely sent.
  Future<void> requestPasswordReset(String email) async {
    await CognitoUser(email, _pool).forgotPassword();
  }

  /// Sets the new password using the emailed code (ConfirmForgotPassword). The user signs in
  /// with it afterwards - this call returns no session.
  Future<void> confirmPasswordReset({
    required String email,
    required String code,
    required String newPassword,
  }) async {
    await CognitoUser(email, _pool).confirmPassword(code, newPassword);
  }

  /// Resolves a previously cached, still-valid session (transparently refreshed via the package's
  /// own getSession()), or null otherwise.
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

  /// Mirrors AuthContext.tsx's mount-time check: resolves the signed-in identity from a
  /// previously cached session if one still exists and is valid, or null otherwise.
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
