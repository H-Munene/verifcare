import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'api/biometric_enrollments_api.dart';
import 'api/dependants_api.dart';
import 'api/family_link_requests_api.dart';
import 'api/terms_api.dart';
import 'api/users_api.dart';
import 'api/visit_schedules_api.dart';
import 'auth/cognito_auth_service.dart';
import 'auth/registration.dart';
import 'screens/consent_screen.dart';
import 'screens/dependant_choice_screen.dart';
import 'screens/home_screen.dart';
import 'screens/join_family_screen.dart';
import 'screens/login_screen.dart';
import 'screens/dependant_wizard_screen.dart';
import 'screens/sign_up_screen.dart';
import 'screens/welcome_screen.dart';

void main() {
  final authService = CognitoAuthService();
  final apiClient = ApiClient(authService.getIdToken);
  runApp(
    MzaziCareFamilyMemberApp(
      authService: authService,
      usersApi: UsersApi(apiClient),
      dependantsApi: DependantsApi(apiClient),
      visitSchedulesApi: VisitSchedulesApi(apiClient),
      enrollmentsApi: BiometricEnrollmentsApi(apiClient),
      termsApi: TermsApi(apiClient),
      linkRequestsApi: FamilyLinkRequestsApi(apiClient),
    ),
  );
}

class MzaziCareFamilyMemberApp extends StatelessWidget {
  final CognitoAuthService authService;
  final UsersApi usersApi;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final TermsApi termsApi;
  final FamilyLinkRequestsApi linkRequestsApi;

  const MzaziCareFamilyMemberApp({
    super.key,
    required this.authService,
    required this.usersApi,
    required this.dependantsApi,
    required this.visitSchedulesApi,
    required this.enrollmentsApi,
    required this.termsApi,
    required this.linkRequestsApi,
  });

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mzazi Care - Family Member',
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF0077E6),
        useMaterial3: true,
      ),
      home: _RootScreen(
        authService: authService,
        usersApi: usersApi,
        dependantsApi: dependantsApi,
        visitSchedulesApi: visitSchedulesApi,
        enrollmentsApi: enrollmentsApi,
        termsApi: termsApi,
        linkRequestsApi: linkRequestsApi,
      ),
    );
  }
}

/// Mirrors AuthContext.tsx's mount-time behavior: checks for an already-valid cached session
/// before deciding whether to land on WelcomeScreen or HomeScreen first. If the cached session is
/// role-less (someone confirmed sign-up but the app closed before POST /users completed),
/// finishes registration silently rather than sending them back through the sign-up chain -
/// same fix completeSelfRegistrationIfNeeded gives the plain Login screen.
class _RootScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final UsersApi usersApi;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final TermsApi termsApi;
  final FamilyLinkRequestsApi linkRequestsApi;

  const _RootScreen({
    required this.authService,
    required this.usersApi,
    required this.dependantsApi,
    required this.visitSchedulesApi,
    required this.enrollmentsApi,
    required this.termsApi,
    required this.linkRequestsApi,
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
        // Leave identity null - falls back to the welcome screen rather than getting stuck.
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

  // Everything reachable once signed in sits behind the consent screen (2026-09-26): the home
  // screen, and the "register a dependant now?" screen a brand-new account lands on first.
  Widget _behindConsent(IdentityClaims identity, Widget child) =>
      ConsentGate(termsApi: widget.termsApi, sub: identity.sub, child: child);

  void _goToHome(IdentityClaims identity) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => _behindConsent(
          identity,
          HomeScreen(
            authService: widget.authService,
            dependantsApi: widget.dependantsApi,
            visitSchedulesApi: widget.visitSchedulesApi,
            enrollmentsApi: widget.enrollmentsApi,
            usersApi: widget.usersApi,
            linkRequestsApi: widget.linkRequestsApi,
            identity: identity,
            onSignedOut: () => setState(() => _identity = null),
          ),
        ),
      ),
      (route) => false,
    );
  }

  void _goToDependantChoice(IdentityClaims identity) {
    Navigator.of(context).pushAndRemoveUntil(
      MaterialPageRoute(
        builder: (_) => _behindConsent(
          identity,
          DependantChoiceScreen(
            onRegisterNow: () {
              Navigator.of(context).pushReplacement(
                MaterialPageRoute(
                  builder: (_) => DependantWizardScreen.register(
                    dependantsApi: widget.dependantsApi,
                    enrollmentsApi: widget.enrollmentsApi,
                    usersApi: widget.usersApi,
                    identity: identity,
                    onDone: () => _goToHome(identity),
                  ),
                ),
              );
            },
            onJoinFamily: () async {
              await Navigator.of(context).push(
                MaterialPageRoute<void>(
                  builder: (_) =>
                      JoinFamilyScreen(linkRequestsApi: widget.linkRequestsApi),
                ),
              );
              _goToHome(identity);
            },
            onSkip: () => _goToHome(identity),
          ),
        ),
      ),
      (route) => false,
    );
  }

  void _onAuthenticated(
    IdentityClaims identity, {
    required bool justRegistered,
  }) {
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
      return _behindConsent(
        identity,
        HomeScreen(
          authService: widget.authService,
          dependantsApi: widget.dependantsApi,
          visitSchedulesApi: widget.visitSchedulesApi,
          enrollmentsApi: widget.enrollmentsApi,
          usersApi: widget.usersApi,
          linkRequestsApi: widget.linkRequestsApi,
          identity: identity,
          onSignedOut: () => setState(() => _identity = null),
        ),
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

  // No in-app verification-code chain (2026-09-14, user request - see SignUpScreen's own
  // comment): SignUpScreen creates the account and tells the user it needs manual confirmation,
  // then pops itself back to Welcome. Signing in afterward (once confirmed) goes through
  // LoginScreen, whose _onAuthenticated already knows how to finish self-registration for a
  // role-less identity via completeSelfRegistrationIfNeeded.
  void _pushSignUp(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SignUpScreen(authService: widget.authService),
      ),
    );
  }
}
