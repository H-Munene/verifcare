import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'api/dependants_api.dart';
import 'api/users_api.dart';
import 'auth/cognito_auth_service.dart';
import 'auth/registration.dart';
import 'screens/dependant_choice_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/register_dependant_screen.dart';
import 'screens/sign_up_screen.dart';
import 'screens/welcome_screen.dart';

void main() {
  final authService = CognitoAuthService();
  final apiClient = ApiClient(authService.getIdToken);
  runApp(MzaziCareFamilyMemberApp(
    authService: authService,
    usersApi: UsersApi(apiClient),
    dependantsApi: DependantsApi(apiClient),
  ));
}

class MzaziCareFamilyMemberApp extends StatelessWidget {
  final CognitoAuthService authService;
  final UsersApi usersApi;
  final DependantsApi dependantsApi;

  const MzaziCareFamilyMemberApp({
    super.key,
    required this.authService,
    required this.usersApi,
    required this.dependantsApi,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mzazi Care - Family Member',
      theme: ThemeData(colorSchemeSeed: const Color(0xFF0077E6), useMaterial3: true),
      home: _RootScreen(
        authService: authService,
        usersApi: usersApi,
        dependantsApi: dependantsApi,
      ),
    );
  }
}

/// Picks the start screen from the cached session. A role-less session (registration was never
/// finished) gets registered on the spot.
class _RootScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final UsersApi usersApi;
  final DependantsApi dependantsApi;

  const _RootScreen({
    required this.authService,
    required this.usersApi,
    required this.dependantsApi,
  });

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
    final session = await widget.authService.getCurrentSession();
    IdentityClaims? identity;
    if (session != null) {
      try {
        identity = await completeSelfRegistrationIfNeeded(
          widget.authService,
          widget.usersApi,
          session,
        );
      } catch (_) {
        // Fall back to the welcome screen.
        identity = null;
      }
    }
    if (!mounted) {
      return;
    }
    setState(() {
      _identity = identity;
      _loading = false;
    });
  }

  void _goToHome(IdentityClaims identity) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => HomeScreen(
          authService: widget.authService,
          dependantsApi: widget.dependantsApi,
          identity: identity,
          onSignedOut: () => setState(() => _identity = null),
        ),
      ),
      (route) => false,
    );
  }

  void _goToDependantChoice(IdentityClaims identity) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => DependantChoiceScreen(
          onRegisterNow: () {
            Navigator.of(context).pushReplacement(
              MaterialPageRoute(
                builder: (_) => RegisterDependantScreen(
                  dependantsApi: widget.dependantsApi,
                  identity: identity,
                  onDone: () => _goToHome(identity),
                ),
              ),
            );
          },
          onSkip: () => _goToHome(identity),
        ),
      ),
      (route) => false,
    );
  }

  void _onAuthenticated(IdentityClaims identity, {required bool justRegistered}) {
    setState(() => _identity = identity);
    if (justRegistered) {
      _goToDependantChoice(identity);
    } else {
      _goToHome(identity);
    }
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
        dependantsApi: widget.dependantsApi,
        identity: identity,
        onSignedOut: () => setState(() => _identity = null),
      );
    }
    return WelcomeScreen(
      onSignIn: () {
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => LoginScreen(
              authService: widget.authService,
              usersApi: widget.usersApi,
              onAuthenticated: _onAuthenticated,
              onCreateAccountInstead: () {
                Navigator.of(context).pop();
                _pushSignUp(context);
              },
            ),
          ),
        );
      },
      onSignUp: () => _pushSignUp(context),
    );
  }

  // Sign-up returns to Welcome; once the account is confirmed, LoginScreen finishes registration.
  void _pushSignUp(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(builder: (_) => SignUpScreen(authService: widget.authService)),
    );
  }
}
