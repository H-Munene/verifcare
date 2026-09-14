import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:flutter/material.dart';

import '../api/users_api.dart';
import '../auth/cognito_auth_service.dart';
import '../auth/registration.dart';

/// Serves two kinds of returning users, distinguished only after a successful sign-in: someone
/// whose identity already has role: family_member (a supervisor created it, or they finished
/// registration previously) goes straight to Home; someone who confirmed a sign-up but never
/// finished registration (closed the app first) has their registration completed here instead of
/// forcing them back through the sign-up chain. Also handles NEW_PASSWORD_REQUIRED - real for this
/// app, since a supervisor can create a family member's Cognito identity via AdminCreateUser
/// (issuing a temporary password) from the web app's "New user" path.
class LoginScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final UsersApi usersApi;
  final void Function(IdentityClaims identity, {required bool justRegistered}) onAuthenticated;
  final VoidCallback onCreateAccountInstead;

  const LoginScreen({
    super.key,
    required this.authService,
    required this.usersApi,
    required this.onAuthenticated,
    required this.onCreateAccountInstead,
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
    final wasAlreadyRegistered = widget.authService.decodeIdentity(session).role != null;
    final identity = await completeSelfRegistrationIfNeeded(
      widget.authService,
      widget.usersApi,
      session,
    );
    widget.onAuthenticated(identity, justRegistered: !wasAlreadyRegistered);
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
      }
    } catch (err) {
      setState(() => _error = 'Sign in failed: $err');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Sign in')),
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
                onCreateAccountInstead: widget.onCreateAccountInstead,
              )
            : _NewPasswordForm(challenge: _challenge!, onCompleted: _finish),
      ),
    );
  }
}

class _SignInForm extends StatelessWidget {
  final GlobalKey<FormState> formKey;
  final TextEditingController emailController;
  final TextEditingController passwordController;
  final bool submitting;
  final String? error;
  final VoidCallback onSubmit;
  final VoidCallback onCreateAccountInstead;

  const _SignInForm({
    required this.formKey,
    required this.emailController,
    required this.passwordController,
    required this.submitting,
    required this.error,
    required this.onSubmit,
    required this.onCreateAccountInstead,
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
            validator: (value) =>
                (value == null || value.trim().isEmpty) ? 'Email is required.' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: passwordController,
            obscureText: true,
            autofillHints: const [AutofillHints.password],
            decoration: const InputDecoration(labelText: 'Password'),
            validator: (value) =>
                (value == null || value.isEmpty) ? 'Password is required.' : null,
          ),
          const SizedBox(height: 20),
          if (error != null) ...[
            Text(error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
            const SizedBox(height: 12),
          ],
          FilledButton(
            onPressed: submitting ? null : onSubmit,
            child: Text(submitting ? 'Signing in...' : 'Sign in'),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: submitting ? null : onCreateAccountInstead,
            child: const Text("Don't have an account? Create one"),
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
      setState(() => _error = 'Could not set new password: $err');
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
              validator: (value) =>
                  (value == null || value.trim().isEmpty) ? 'Full name is required.' : null,
            ),
            const SizedBox(height: 12),
          ],
          TextFormField(
            controller: _newPasswordController,
            obscureText: true,
            autofillHints: const [AutofillHints.newPassword],
            decoration: const InputDecoration(labelText: 'New password'),
            validator: (value) =>
                (value == null || value.isEmpty) ? 'New password is required.' : null,
          ),
          const SizedBox(height: 12),
          TextFormField(
            controller: _confirmPasswordController,
            obscureText: true,
            autofillHints: const [AutofillHints.newPassword],
            decoration: const InputDecoration(labelText: 'Confirm new password'),
            validator: (value) =>
                (value == null || value.isEmpty) ? 'Please confirm the new password.' : null,
          ),
          const SizedBox(height: 20),
          if (_error != null) ...[
            Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
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
