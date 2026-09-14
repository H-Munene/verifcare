import 'package:flutter/material.dart';

import '../api/dependants_api.dart';
import '../auth/cognito_auth_service.dart';
import 'register_dependant_screen.dart';

/// AppBar shows identity.email ?? identity.sub, matching the caregiver app and the web app's
/// AppShell display convention. A "+ Register a dependant" action makes "skip for now" during
/// registration an actual reachable-later path, not a dead end - same screen as the optional
/// post-registration step, not new scope.
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
