import 'package:flutter/material.dart';

import '../api/dependants_api.dart';
import '../auth/cognito_auth_service.dart';
import 'register_dependant_screen.dart';

/// Home screen, with a way to register a dependant if that was skipped during sign-up.
class HomeScreen extends StatelessWidget {
  final CognitoAuthService authService;
  final DependantsApi dependantsApi;
  final IdentityClaims identity;
  final VoidCallback onSignedOut;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.dependantsApi,
    required this.identity,
    required this.onSignedOut,
  });

  Future<void> _signOut() async {
    await authService.signOut();
    onSignedOut();
  }

  void _registerDependant(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => RegisterDependantScreen(
          dependantsApi: dependantsApi,
          identity: identity,
          onDone: () => Navigator.of(context).pop(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(identity.email ?? identity.sub),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: _signOut,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _registerDependant(context),
        icon: const Icon(Icons.add),
        label: const Text('Register a dependant'),
      ),
    );
  }
}
