import 'package:flutter/material.dart';

import 'auth/cognito_auth_service.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';

void main() {
  runApp(MzaziCareCaregiverApp(authService: CognitoAuthService()));
}

class MzaziCareCaregiverApp extends StatelessWidget {
  final CognitoAuthService authService;

  const MzaziCareCaregiverApp({super.key, required this.authService});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mzazi Care - Caregiver',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF0077E6), useMaterial3: true),
      home: _RootScreen(authService: authService),
    );
  }
}

/// Simpler than frontend/mobile/family_member/lib/main.dart's own _RootScreen: there's no
/// sign-up/self-registration branch to route around here, since a caregiver never self-registers
/// and every caregiver identity already has its role set before this app ever sees it. So the
/// only two states are "has a valid cached session" (straight to Home) or not (straight to Login,
/// with no Welcome screen in between - sign-in is the only entry point this app has).
class _RootScreen extends StatefulWidget {
  final CognitoAuthService authService;

  const _RootScreen({required this.authService});

  @override
  State<_RootScreen> createState() => _RootScreenState();
}

class _RootScreenState extends State<_RootScreen> {
  bool _loading = true;
  IdentityClaims? _identity;

  @override
  void initState() {
    super.initState();
    _restoreSession();
  }

  Future<void> _restoreSession() async {
    final identity = await widget.authService.getCurrentIdentity();
    if (!mounted) {
      return;
    }
    setState(() {
      _identity = identity;
      _loading = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final identity = _identity;
    if (identity != null) {
      return HomeScreen(
        authService: widget.authService,
        identity: identity,
        onSignedOut: () => setState(() => _identity = null),
      );
    }
    return LoginScreen(
      authService: widget.authService,
      onAuthenticated: (identity) => setState(() => _identity = identity),
    );
  }
}
