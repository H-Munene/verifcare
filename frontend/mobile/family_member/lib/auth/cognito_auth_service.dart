import 'package:amazon_cognito_identity_dart_2/cognito.dart';

import '../config.dart';
import 'shared_preferences_cognito_storage.dart';

// Thin wrapper around amazon_cognito_identity_dart_2, mirroring
// frontend/web/src/auth/cognito.ts's shape (signIn / completeNewPassword / getCurrentIdentity /
// signOut), plus self-service sign-up support this app needs that the web app and the caregiver
// app don't (those two only ever authenticate identities a supervisor already created).

// Mirrors frontend/web/src/auth/cognito.ts's IdentityClaims, extended with phoneNumber/fullName -
// this app needs both to complete self-registration (POST /users) for a returning user who
// confirmed their sign-up but never finished it (closed the app before completing registration,
// then came back through the plain Login screen instead of the sign-up chain). Reading them off
// the ID token works because this app client's read access is left at Cognito's permissive
// default (see infra/lib/auth.ts - only write access is restricted). Decoded for display/
// convenience only - never trusted as an authorization decision, since only the backend's
// independent signature verification (aws-jwt-verify) is authoritative.
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
/// password. This is real, not hypothetical, for this app specifically: a supervisor can already
/// create a brand-new family-member Cognito identity from the web app (FamilyMemberResolver's
/// "New user" path), which uses AdminCreateUser and always issues a temporary password - that
/// person's first mobile sign-in hits this challenge exactly like it does on the web app.
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
    AppConfig.familyMemberUserPoolClientId,
    storage: SharedPreferencesCognitoStorage(),
  );

  /// Self-service Cognito sign-up (distinct from AdminCreateUser) - the User Pool's own
  /// `selfSignUpEnabled: true` is what lets this app register a brand-new family member directly,
  /// without any supervisor involvement.
  ///
  /// No in-app verification-code step follows this (2026-09-14, user request): Cognito's default
  /// email delivery proved unreliable in testing, so accounts are confirmed manually for now
  /// (e.g. `aws cognito-idp admin-confirm-sign-up`) - see docs/project-state.md. Revisit once this
  /// project has a real Amazon SES configuration for the user pool.
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
  /// UserNotFoundException is treated the same way in case the client ever answers the legacy
  /// way, so the screen never reveals whether an email is registered.
  Future<void> requestPasswordReset(String email) async {
    try {
      await CognitoUser(email, _pool).forgotPassword();
    } on CognitoClientException catch (e) {
      if (e.code != 'UserNotFoundException') rethrow;
    }
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

  /// Forces a fresh ID token via the REFRESH_TOKEN_AUTH flow. Required immediately after a
  /// brand-new self-signup completes POST /users: that call assigns custom:role server-side via
  /// AdminUpdateUserAttributes, but the ID token this app is already holding was issued before
  /// that happened and won't retroactively pick up the new claim - Cognito only computes ID token
  /// claims fresh at each token issuance. Without this call, every subsequent requireAuth-gated
  /// request (including registering a dependant) would 401 despite the role now existing.
  Future<IdentityClaims> refreshIdentity(CognitoUserSession session) async {
    final user = await _pool.getCurrentUser();
    final refreshToken = session.getRefreshToken();
    if (user == null || refreshToken == null) {
      throw Exception(
        'Cannot refresh session: no current user or refresh token available.',
      );
    }
    final refreshed = await user.refreshSession(refreshToken);
    if (refreshed == null) {
      throw Exception('Failed to refresh session.');
    }
    return decodeIdentity(refreshed);
  }

  /// Resolves a previously cached, still-valid session (transparently refreshed via the package's
  /// own getSession(), same as the web app's getCurrentIdToken), or null otherwise. Exposed
  /// separately from getCurrentIdentity so a caller that needs to act on a role-less cached
  /// session (see main.dart's startup check, for someone who confirmed sign-up but never finished
  /// registration) has the session object completeSelfRegistrationIfNeeded needs, not just the
  /// decoded claims.
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
