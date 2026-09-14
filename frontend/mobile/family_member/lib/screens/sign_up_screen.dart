import 'package:flutter/material.dart';

import '../auth/cognito_auth_service.dart';

class SignUpScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final void Function(String email, String password) onSignedUp;

  const SignUpScreen({super.key, required this.authService, required this.onSignedUp});

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
    final password = _passwordController.text;
    try {
      await widget.authService.signUp(
        email: email,
        phoneNumber: _phoneController.text.trim(),
        fullName: _fullNameController.text.trim(),
        password: password,
      );
      widget.onSignedUp(email, password);
    } catch (err) {
      setState(() => _error = 'Could not create account: $err');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
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
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Email is required.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _phoneController,
                keyboardType: TextInputType.phone,
                autofillHints: const [AutofillHints.telephoneNumber],
                decoration: const InputDecoration(labelText: 'Phone number'),
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Phone number is required.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _fullNameController,
                autofillHints: const [AutofillHints.name],
                decoration: const InputDecoration(labelText: 'Full name'),
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Full name is required.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _passwordController,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                decoration: const InputDecoration(labelText: 'Password'),
                validator: (value) =>
                    (value == null || value.isEmpty) ? 'Password is required.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _confirmPasswordController,
                obscureText: true,
                autofillHints: const [AutofillHints.newPassword],
                decoration: const InputDecoration(labelText: 'Confirm password'),
                validator: (value) =>
                    (value == null || value.isEmpty) ? 'Please confirm your password.' : null,
              ),
              const SizedBox(height: 20),
              if (_error != null) ...[
                Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                const SizedBox(height: 12),
              ],
              FilledButton(
                onPressed: _submitting ? null : _submit,
                child: Text(_submitting ? 'Creating account...' : 'Create account'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
