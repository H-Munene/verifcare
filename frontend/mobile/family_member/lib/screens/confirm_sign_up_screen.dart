import 'package:flutter/material.dart';

import '../api/users_api.dart';
import '../auth/cognito_auth_service.dart';
import '../auth/registration.dart';

/// Verification code -> sign in with the just-created credentials -> complete self-registration
/// (POST /users + a forced session refresh, per CognitoAuthService.refreshIdentity) -> hand back
/// the now-fully-registered identity. The password is held only in memory for this one screen
/// (passed in, never persisted) and is not read again after the sign-in call inside _submit.
class ConfirmSignUpScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final UsersApi usersApi;
  final String email;
  final String password;
  final void Function(IdentityClaims identity) onRegistered;

  const ConfirmSignUpScreen({
    super.key,
    required this.authService,
    required this.usersApi,
    required this.email,
    required this.password,
    required this.onRegistered,
  });

  @override
  State<ConfirmSignUpScreen> createState() => _ConfirmSignUpScreenState();
}

class _ConfirmSignUpScreenState extends State<ConfirmSignUpScreen> {
  final _formKey = GlobalKey<FormState>();
  final _codeController = TextEditingController();

  bool _submitting = false;
  bool _resending = false;
  String? _error;
  String? _info;

  @override
  void dispose() {
    _codeController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
      _info = null;
    });
    try {
      await widget.authService.confirmSignUp(widget.email, _codeController.text.trim());

      final result = await widget.authService.signIn(widget.email, widget.password);
      final session = switch (result) {
        SignInSuccess(session: final session) => session,
        // A brand-new signup should never need NEW_PASSWORD_REQUIRED - that challenge only
        // applies to Cognito-generated temporary passwords (AdminCreateUser), never a password
        // the user just chose themselves at sign-up.
        SignInNewPasswordRequired() =>
          throw Exception('Unexpected password-reset challenge for a brand-new account.'),
      };

      final identity = await completeSelfRegistrationIfNeeded(
        widget.authService,
        widget.usersApi,
        session,
      );
      widget.onRegistered(identity);
    } catch (err) {
      setState(() => _error = 'Could not confirm your account: $err');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  Future<void> _resend() async {
    setState(() {
      _resending = true;
      _error = null;
      _info = null;
    });
    try {
      await widget.authService.resendConfirmationCode(widget.email);
      setState(() => _info = 'A new code has been sent.');
    } catch (err) {
      setState(() => _error = 'Could not resend the code: $err');
    } finally {
      if (mounted) {
        setState(() => _resending = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Confirm your account')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Form(
          key: _formKey,
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Enter the verification code sent to your email or phone for ${widget.email}.'),
              const SizedBox(height: 16),
              TextFormField(
                controller: _codeController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Verification code'),
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Code is required.' : null,
              ),
              const SizedBox(height: 20),
              if (_error != null) ...[
                Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                const SizedBox(height: 12),
              ],
              if (_info != null) ...[
                Text(_info!),
                const SizedBox(height: 12),
              ],
              FilledButton(
                onPressed: _submitting ? null : _submit,
                child: Text(_submitting ? 'Confirming...' : 'Confirm'),
              ),
              const SizedBox(height: 12),
              TextButton(
                onPressed: _resending ? null : _resend,
                child: Text(_resending ? 'Resending...' : 'Resend code'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
