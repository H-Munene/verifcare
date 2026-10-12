import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:flutter/material.dart';

import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../widgets/password_field.dart';

/// Self-service password reset in two steps: the email, then the emailed code with the new
/// password typed twice. Pops with the email once the password is changed, so the sign-in screen
/// can fill it in. Everything goes straight to Cognito (ForgotPassword / ConfirmForgotPassword);
/// the Mzazi Care API isn't involved.
class ForgotPasswordScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final String initialEmail;

  /// Set when sign-in found an account an administrator reset: Cognito has already emailed that
  /// code, so the screen opens on the code step instead of sending another.
  final bool codeAlreadySent;

  const ForgotPasswordScreen({
    super.key,
    required this.authService,
    this.initialEmail = '',
    this.codeAlreadySent = false,
  });

  @override
  State<ForgotPasswordScreen> createState() => _ForgotPasswordScreenState();
}

/// A message for each way a reset can fail. Cognito's own text is only shown for a password that
/// breaks the policy, where it names the missing rule; the rest are written for the user.
String passwordResetErrorText(Object error) {
  if (error is! CognitoClientException) {
    return 'Something went wrong. Please try again.';
  }
  const policyPrefix = 'Password does not conform to policy: ';
  return switch (error.code) {
    'CodeMismatchException' =>
      "That code isn't right. Check the email and try again.",
    'ExpiredCodeException' =>
      'That code has expired. Tap "Send a new code" for another one.',
    'InvalidPasswordException' => switch (error.message) {
      final String message when message.startsWith(policyPrefix) =>
        message.substring(policyPrefix.length),
      _ => "That password isn't allowed. $passwordPolicyHint",
    },
    'LimitExceededException' ||
    'TooManyRequestsException' ||
    'TooManyFailedAttemptsException' =>
      'Too many attempts. Please wait a while, then try again.',
    // Cognito's answer for an account still on the temporary password from its invitation.
    'NotAuthorizedException' =>
      "This account hasn't been set up yet. Sign in with the temporary password from your "
          'invitation email - if it has expired, ask a supervisor to send a new one.',
    // No verified email on the account to send a code to.
    'InvalidParameterException' =>
      "A code can't be sent to this account. Ask a supervisor to reset your password.",
    'NetworkError' =>
      'Could not reach the server. Check your connection and try again.',
    _ => 'Something went wrong. Please try again.',
  };
}

class _ForgotPasswordScreenState extends State<ForgotPasswordScreen> {
  final _emailFormKey = GlobalKey<FormState>();
  final _resetFormKey = GlobalKey<FormState>();
  late final _emailController = TextEditingController(
    text: widget.initialEmail,
  );
  final _codeController = TextEditingController();
  final _newPasswordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();

  late bool _codeStep = widget.codeAlreadySent;
  // Only the administrator's own code - cleared once the user asks for a code themselves.
  late bool _adminReset = widget.codeAlreadySent;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _codeController.dispose();
    _newPasswordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  String get _email => _emailController.text.trim();

  Future<void> _run(Future<void> Function() action) async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await action();
    } catch (e) {
      if (mounted) setState(() => _error = passwordResetErrorText(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  Future<void> _sendCode() async {
    if (!_emailFormKey.currentState!.validate()) return;
    await _run(() async {
      await widget.authService.requestPasswordReset(_email);
      if (mounted) {
        setState(() {
          _codeStep = true;
          _adminReset = false;
        });
      }
    });
  }

  Future<void> _resendCode() => _run(() async {
    await widget.authService.requestPasswordReset(_email);
    if (!mounted) return;
    setState(() => _adminReset = false);
    showSnack(context, 'A new code is on its way.', error: false);
  });

  Future<void> _reset() async {
    if (!_resetFormKey.currentState!.validate()) return;
    await _run(() async {
      await widget.authService.confirmPasswordReset(
        email: _email,
        code: _codeController.text.trim(),
        newPassword: _newPasswordController.text,
      );
      if (mounted) Navigator.of(context).pop(_email);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: constrainedContent(
            _codeStep ? _buildCodeStep() : _buildEmailStep(),
          ),
        ),
      ),
    );
  }

  Widget _buildEmailStep() {
    return Form(
      key: _emailFormKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            "Enter the email you sign in with and we'll send you a code to reset your password.",
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _emailController,
            keyboardType: TextInputType.emailAddress,
            autofillHints: const [AutofillHints.email],
            decoration: const InputDecoration(labelText: 'Email'),
            validator: (value) => (value == null || value.trim().isEmpty)
                ? 'Email is required.'
                : null,
          ),
          const SizedBox(height: 20),
          ..._errorLine(),
          FilledButton(
            onPressed: _submitting ? null : _sendCode,
            child: Text(_submitting ? 'Sending...' : 'Send code'),
          ),
        ],
      ),
    );
  }

  Widget _buildCodeStep() {
    return Form(
      key: _resetFormKey,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Worded for both outcomes: an unknown email gets the same response as a known one.
          Text(
            _adminReset
                ? 'Your password was reset. Enter the code we emailed to $_email and choose a '
                      'new password.'
                : "If there's an account for $_email, we've emailed it a code. Enter it below "
                      'and choose a new password. The code expires in an hour.',
          ),
          const SizedBox(height: 16),
          TextFormField(
            controller: _codeController,
            keyboardType: TextInputType.number,
            autofillHints: const [AutofillHints.oneTimeCode],
            decoration: const InputDecoration(labelText: 'Code'),
            validator: (value) => (value == null || value.trim().isEmpty)
                ? 'Enter the code from the email.'
                : null,
          ),
          const SizedBox(height: 12),
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
            validator: (value) => switch (value) {
              null || '' => 'Please confirm the new password.',
              final v when v != _newPasswordController.text =>
                'Passwords do not match.',
              _ => null,
            },
          ),
          const SizedBox(height: 20),
          ..._errorLine(),
          FilledButton(
            onPressed: _submitting ? null : _reset,
            child: Text(_submitting ? 'Saving...' : 'Reset password'),
          ),
          const SizedBox(height: 12),
          TextButton(
            onPressed: _submitting ? null : _resendCode,
            child: const Text('Send a new code'),
          ),
          TextButton(
            onPressed: _submitting
                ? null
                : () => setState(() {
                    _codeStep = false;
                    _error = null;
                  }),
            child: const Text('Use a different email'),
          ),
        ],
      ),
    );
  }

  List<Widget> _errorLine() => [
    if (_error != null) ...[
      Text(
        _error!,
        style: TextStyle(color: Theme.of(context).colorScheme.error),
      ),
      const SizedBox(height: 12),
    ],
  ];
}
