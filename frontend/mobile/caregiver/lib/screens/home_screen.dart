import 'package:flutter/material.dart';

import '../auth/cognito_auth_service.dart';

/// Deliberately a stub (2026-09-22) - login is the only thing this app does so far. AppBar shows
/// identity.email ?? identity.sub, matching the family-member and web app's own display
/// convention. No feature actions yet - there's nothing behind them until a caregiver-facing
/// backend endpoint exists to build against (routes/caregivers.ts is entirely
/// requireRole('supervisor')-only right now).
class HomeScreen extends StatelessWidget {
  final CognitoAuthService authService;
  final IdentityClaims identity;
  final VoidCallback onSignedOut;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.identity,
    required this.onSignedOut,
  });

  Future<void> _signOut() async {
    await authService.signOut();
    onSignedOut();
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
      body: const Center(child: Text('Signed in as a caregiver.')),
    );
  }
}
