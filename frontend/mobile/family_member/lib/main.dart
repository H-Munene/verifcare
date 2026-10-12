import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'api/biometric_enrollments_api.dart';
import 'api/dependants_api.dart';
import 'api/family_link_requests_api.dart';
import 'api/terms_api.dart';
import 'api/users_api.dart';
import 'api/visit_schedules_api.dart';
import 'app_ui.dart';
import 'auth/cognito_auth_service.dart';
import 'auth/registration.dart';
import 'screens/consent_screen.dart';
import 'screens/dependant_choice_screen.dart';
import 'screens/home_screen.dart';
import 'screens/join_family_screen.dart';
import 'screens/login_screen.dart';
import 'screens/dependant_wizard_screen.dart';
import 'screens/sign_up_screen.dart';

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
      theme: buildAppTheme(),
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

/// Picks the start screen from the cached session. A role-less session (registration was never
/// finished) gets registered on the spot.
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
    // Signed out, the app opens straight on sign-in (2026-10-12: the Welcome screen was removed at
    // the user's request); creating an account is one tap away from here.
    return LoginScreen(
      authService: widget.authService,
      usersApi: widget.usersApi,
      onAuthenticated: _onAuthenticated,
      onCreateAccountInstead: () => _pushSignUp(context),
    );
  }

  // Sign-up returns to sign-in; once the account is confirmed, LoginScreen finishes registration.
  void _pushSignUp(BuildContext context) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SignUpScreen(authService: widget.authService),
      ),
    );
  }
}
