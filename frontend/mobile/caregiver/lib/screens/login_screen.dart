import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:flutter/material.dart';

import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../widgets/password_field.dart';
import 'forgot_password_screen.dart';

/// The only entry point into this app - a caregiver never self-registers, so unlike
/// frontend/mobile/family_member/lib/screens/login_screen.dart (which this is trimmed from),
/// there's no "create an account instead" path and no post-sign-in self-registration step: a
/// caregiver's identity, including its role, always already exists by the time this screen runs.
/// Handles NEW_PASSWORD_REQUIRED as the normal first-sign-in case, not an edge case - every
/// caregiver identity is created via AdminCreateUser, which always issues a temporary password.
/// "Forgot password?" and an account an administrator reset both continue in
/// [ForgotPasswordScreen].
class LoginScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final void Function(IdentityClaims identity) onAuthenticated;

  const LoginScreen({
    super.key,
    required this.authService,
    required this.onAuthenticated,
  });

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();

  NewPasswordRequiredChallenge? _challenge;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _finish(CognitoUserSession session) async {
    final identity = widget.authService.decodeIdentity(session);
    // Defensive, not just a port from family_member's version: this app client is only ever
    // handed to caregivers, but nothing stops someone from typing a supervisor's or family
    // member's own credentials into it by mistake. Without this check they'd land on a home
    // screen with a role that doesn't match what this app is for, rather than a clear message.
    if (identity.role != 'caregiver') {
      await widget.authService.signOut();
      setState(() {
        _challenge = null;
        _error = "This account isn't registered as a caregiver.";
      });
      return;
    }
    widget.onAuthenticated(identity);
  }

  Future<void> _submitSignIn() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final result = await widget.authService.signIn(
        _emailController.text.trim(),
        _passwordController.text,
      );
      switch (result) {
        case SignInSuccess(session: final session):
          await _finish(session);
        case SignInNewPasswordRequired(challenge: final challenge):
          setState(() => _challenge = challenge);
        case SignInPasswordResetRequired():
          await _openPasswordReset(codeAlreadySent: true);
      }
    } catch (err) {
      setState(() => _error = signInErrorText(err));
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  Future<void> _openPasswordReset({bool codeAlreadySent = false}) async {
    final email = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) => ForgotPasswordScreen(
          authService: widget.authService,
          initialEmail: _emailController.text.trim(),
          codeAlreadySent: codeAlreadySent,
        ),
      ),
    );
    if (email == null || !mounted) return;
    _emailController.text = email;
    _passwordController.clear();
    setState(() => _error = null);
    showSnack(
      context,
      'Password changed. Sign in with your new password.',
      error: false,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Mzazi Care - Caregiver sign in')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: _challenge == null
            ? _SignInForm(
                formKey: _formKey,
                emailController: _emailController,
                passwordController: _passwordController,
                submitting: _submitting,
                error: _error,
                onSubmit: _submitSignIn,
                onForgotPassword: _openPasswordReset,
              )
            : _NewPasswordForm(challenge: _challenge!, onCompleted: _finish),
      ),
    );
  }
}

/// Cognito's own sign-in messages are already readable ("Incorrect username or password.",
/// "Password attempts exceeded", "User is disabled."), unlike the exception's raw toString. With
/// user-existence errors prevented on this app client, an unknown email arrives as the same
/// NotAuthorizedException as a wrong password.
String signInErrorText(Object error) => switch (error) {
  CognitoClientException(code: 'NotAuthorizedException', :final message?) =>
    message,
  CognitoClientException(code: 'NetworkError') =>
    'Could not reach the server. Check your connection and try again.',
  _ => 'Sign in failed: $error',
};

class _SignInForm extends StatelessWidget {
  final GlobalKey<FormState> formKey;
  final TextEditingController emailController;
  final TextEditingController passwordController;
  final bool submitting;
  final String? error;
  final VoidCallback onSubmit;
  final VoidCallback onForgotPassword;

  const _SignInForm({
    required this.formKey,
    required this.emailController,
    required this.passwordController,
    required this.submitting,
    required this.error,
    required this.onSubmit,
    required this.onForgotPassword,
  });

  @override
  Widget build(BuildContext context) {
    return Form(
      key: formKey,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          TextFormField(
            controller: emailController,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.username],
            decoration: const InputDecoration(labelText: 'Email'),
            validator: (value) => (value == null || value.trim().isEmpty)
                ? 'Email is required.'
                : null,
          ),
          const SizedBox(height: 12),
          PasswordField(
            controller: passwordController,
            labelText: 'Password',
            validator: (value) => (value == null || value.isEmpty)
                ? 'Password is required.'
                : null,
          ),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: submitting ? null : onForgotPassword,
              child: const Text('Forgot password?'),
            ),
          ),
          const SizedBox(height: 8),
          if (error != null) ...[
            Text(
              error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            const SizedBox(height: 12),
          ],
          FilledButton(
            onPressed: submitting ? null : onSubmit,
            child: Text(submitting ? 'Signing in...' : 'Sign in'),
          ),
        ],
      ),
    );
  }
}

class _NewPasswordForm extends StatefulWidget {
  final NewPasswordRequiredChallenge challenge;
  final Future<void> Function(CognitoUserSession session) onCompleted;

  const _NewPasswordForm({required this.challenge, required this.onCompleted});

  @override
  State<_NewPasswordForm> createState() => _NewPasswordFormState();
}

class _NewPasswordFormState extends State<_NewPasswordForm> {
  final _formKey = GlobalKey<FormState>();
  final _fullNameController = TextEditingController();
  final _newPasswordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();

  bool _submitting = false;
  String? _error;

  bool get _needsName => widget.challenge.requiredAttributes.contains('name');

  @override
  void dispose() {
    _fullNameController.dispose();
    _newPasswordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }
    if (_newPasswordController.text != _confirmPasswordController.text) {
      setState(() => _error = 'Passwords do not match.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final session = await widget.challenge.complete(
        _newPasswordController.text,
        fullName: _needsName ? _fullNameController.text.trim() : null,
      );
      await widget.onCompleted(session);
    } catch (err) {
      setState(
        () => _error =
            err is CognitoClientException &&
                err.code == 'InvalidPasswordException'
            ? passwordResetErrorText(err)
            : 'Could not set new password: $err',
      );
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Form(
      key: _formKey,
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('Set a new password to finish signing in.'),
          const SizedBox(height: 16),
          if (_needsName) ...[
            TextFormField(
              controller: _fullNameController,
              decoration: const InputDecoration(labelText: 'Full name'),
              validator: (value) => (value == null || value.trim().isEmpty)
                  ? 'Full name is required.'
                  : null,
            ),
            const SizedBox(height: 12),
          ],
          PasswordField(
            controller: _newPasswordController,
            labelText: 'New password',
            helperText: passwordPolicyHint,
            autofillHints: const [AutofillHints.newPassword],
            validator: (value) => (value == null || value.isEmpty)
                ? 'New password is required.'
                : null,
          ),
          const SizedBox(height: 12),
          PasswordField(
            controller: _confirmPasswordController,
            labelText: 'Confirm new password',
            autofillHints: const [AutofillHints.newPassword],
            validator: (value) => (value == null || value.isEmpty)
                ? 'Please confirm the new password.'
                : null,
          ),
          const SizedBox(height: 20),
          if (_error != null) ...[
            Text(
              _error!,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            const SizedBox(height: 12),
          ],
          FilledButton(
            onPressed: _submitting ? null : _submit,
            child: Text(_submitting ? 'Saving...' : 'Set password and sign in'),
          ),
        ],
      ),
    );
  }
}
