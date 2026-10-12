import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:flutter/material.dart';

import '../auth/cognito_auth_service.dart';
import '../utils/kenyan_phone.dart';
import '../widgets/password_field.dart';

/// Creates the Cognito account. There's no verification-code step yet; accounts are confirmed
/// manually until SES is set up.
class SignUpScreen extends StatefulWidget {
  final CognitoAuthService authService;

  const SignUpScreen({super.key, required this.authService});

  @override
  State<SignUpScreen> createState() => _SignUpScreenState();
}

class _SignUpScreenState extends State<SignUpScreen> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _phoneController = TextEditingController();
  final _fullNameController = TextEditingController();
  final _passwordController = TextEditingController();
  final _confirmPasswordController = TextEditingController();

  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _emailController.dispose();
    _phoneController.dispose();
    _fullNameController.dispose();
    _passwordController.dispose();
    _confirmPasswordController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }
    if (_passwordController.text != _confirmPasswordController.text) {
      setState(() => _error = 'Passwords do not match.');
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    final email = _emailController.text.trim();
    // The field validator already rejected invalid numbers.
    final phoneNumber = normalizeKenyanPhoneNumber(_phoneController.text)!;
    try {
      await widget.authService.signUp(
        email: email,
        phoneNumber: phoneNumber,
        fullName: _fullNameController.text.trim(),
        password: _passwordController.text,
      );
      if (mounted) {
        await _showAccountCreatedDialog(email);
      }
    } on CognitoClientException catch (err) {
      if (err.code == 'UsernameExistsException') {
        setState(
          () => _error =
              'An account already exists for this email. If it still needs confirming, ask an '
              'administrator; otherwise use "Sign in" instead.',
        );
        return;
      }
      setState(() => _error = 'Could not create account: $err');
    } catch (err) {
      setState(() => _error = 'Could not create account: $err');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  Future<void> _showAccountCreatedDialog(String email) async {
    await showDialog<void>(
      context: context,
      barrierDismissible: false,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Account created'),
        content: Text(
          'An account was created for $email. An administrator needs to confirm it before you '
          'can sign in - once that\'s done, come back and sign in.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('OK'),
          ),
        ],
      ),
    );
    if (mounted) {
      Navigator.of(context).pop();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Create account')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Form(
          key: _formKey,
          child: ListView(
            children: [
              TextFormField(
                controller: _emailController,
                keyboardType: TextInputType.emailAddress,
                autofillHints: const [AutofillHints.email],
                decoration: const InputDecoration(labelText: 'Email'),
                validator: (value) => (value == null || value.trim().isEmpty)
                    ? 'Email is required.'
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                autofillHints: const [AutofillHints.telephoneNumber],
                decoration: const InputDecoration(
                  labelText: 'Phone number',
                  hintText: '0712345678',
                ),
                // Accepts 0712345678, 254712345678 or +254712345678; normalized to E.164.
                validator: (value) {
                  final trimmed = value?.trim() ?? '';
                  if (trimmed.isEmpty) {
                    return 'Phone number is required.';
                  }
                  if (normalizeKenyanPhoneNumber(trimmed) == null) {
                    return 'Enter a valid Kenyan mobile number, e.g. 0712345678.';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _fullNameController,
                autofillHints: const [AutofillHints.name],
                decoration: const InputDecoration(labelText: 'Full name'),
                validator: (value) => (value == null || value.trim().isEmpty)
                    ? 'Full name is required.'
                    : null,
              ),
              const SizedBox(height: 12),
              PasswordField(
                controller: _passwordController,
                labelText: 'Password',
                helperText: passwordPolicyHint,
                autofillHints: const [AutofillHints.newPassword],
                validator: (value) => (value == null || value.isEmpty)
                    ? 'Password is required.'
                    : null,
              ),
              const SizedBox(height: 12),
              PasswordField(
                controller: _confirmPasswordController,
                labelText: 'Confirm password',
                autofillHints: const [AutofillHints.newPassword],
                validator: (value) => (value == null || value.isEmpty)
                    ? 'Please confirm your password.'
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
                child: Text(
                  _submitting ? 'Creating account...' : 'Create account',
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
