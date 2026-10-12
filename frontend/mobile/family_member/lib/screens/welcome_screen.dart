import 'package:flutter/material.dart';

import '../widgets/auth_layout.dart';

/// The signed-out start page: what the app is for, then sign in or create an account.
class WelcomeScreen extends StatelessWidget {
  final VoidCallback onSignIn;
  final VoidCallback onSignUp;

  const WelcomeScreen({super.key, required this.onSignIn, required this.onSignUp});

  @override
  Widget build(BuildContext context) {
    return AuthScaffold(
      bottom: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FilledButton(style: authButtonStyle, onPressed: onSignIn, child: const Text('Sign in')),
          const SizedBox(height: 12),
          OutlinedButton(
            style: OutlinedButton.styleFrom(
              minimumSize: const Size.fromHeight(52),
              textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
            ),
            onPressed: onSignUp,
            child: const Text('Create account'),
          ),
        ],
      ),
      child: const AuthHeading(
        title: 'Stay close to their care',
        subtitle:
            'See when a caregiver arrives, what they did and how each visit went, wherever '
            'you are.',
      ),
    );
  }
}
