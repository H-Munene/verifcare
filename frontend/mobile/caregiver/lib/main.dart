import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'api/checkin_api.dart';
import 'api/visit_schedules_api.dart';
import 'auth/cognito_auth_service.dart';
import 'screens/checkin_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/schedule_calendar_screen.dart';

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
      theme: ThemeData(
        colorSchemeSeed: const Color(0xFF0077E6),
        useMaterial3: true,
      ),
      home: _RootScreen(authService: authService),
    );
  }
}

/// Simpler than frontend/mobile/family_member/lib/main.dart's own _RootScreen: there's no
/// sign-up/self-registration branch to route around here, since a caregiver never self-registers
/// and every caregiver identity already has its role set before this app ever sees it. So the
/// only two states are "has a valid cached session" (straight to the authenticated shell) or not
/// (straight to Login, with no Welcome screen in between - sign-in is the only entry point this
/// app has).
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
      return _AuthenticatedShell(
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

/// Bottom-nav shell for a signed-in caregiver: Home (existing stub) and Calendar (03b), per the
/// user's own "minimal shared shell" decision - Profile isn't built yet, so it isn't in this bar.
/// Owns the one ApiClient/VisitSchedulesApi/CheckinApi instance set for the whole authenticated
/// session, so neither tab constructs its own - HomeScreen and ScheduleCalendarScreen each keep
/// their own inner Scaffold/AppBar (nesting a Scaffold inside another Scaffold's body is standard
/// for per-tab AppBars in a bottom-nav shell), this shell only owns the shared bottomNavigationBar
/// chrome around an IndexedStack (keeps both tabs' state alive across switches, so Calendar's
/// already-fetched visits aren't refetched every time the caregiver flips back to it from Home).
class _AuthenticatedShell extends StatefulWidget {
  final CognitoAuthService authService;
  final IdentityClaims identity;
  final VoidCallback onSignedOut;

  const _AuthenticatedShell({
    required this.authService,
    required this.identity,
    required this.onSignedOut,
  });

  @override
  State<_AuthenticatedShell> createState() => _AuthenticatedShellState();
}

class _AuthenticatedShellState extends State<_AuthenticatedShell> {
  late final ApiClient _apiClient;
  late final VisitSchedulesApi _visitSchedulesApi;
  late final CheckinApi _checkinApi;
  int _tabIndex = 0;

  @override
  void initState() {
    super.initState();
    _apiClient = ApiClient(widget.authService.getIdToken);
    _visitSchedulesApi = VisitSchedulesApi(_apiClient);
    _checkinApi = CheckinApi(_apiClient);
  }

  // ScheduleCalendarScreen doesn't navigate itself - it only reports which visit was tapped, so
  // this shell (which owns the api instances CheckInScreen needs) is the one place that knows how
  // to get there. Pushed as a full route, not a tab, since the wireframe's check-in flow (screens
  // 4-9) is explicitly "full-screen linear, no nav chrome" - it should cover the bottom bar too.
  void _openCheckIn(VisitSchedule visit) {
    Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => CheckInScreen(
          visit: visit,
          visitSchedulesApi: _visitSchedulesApi,
          checkinApi: _checkinApi,
          onBack: () => Navigator.of(context).pop(),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [
      HomeScreen(
        authService: widget.authService,
        identity: widget.identity,
        onSignedOut: widget.onSignedOut,
      ),
      ScheduleCalendarScreen(
        visitSchedulesApi: _visitSchedulesApi,
        onSelectVisit: _openCheckIn,
      ),
    ];

    return Scaffold(
      body: IndexedStack(index: _tabIndex, children: tabs),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _tabIndex,
        onTap: (index) => setState(() => _tabIndex = index),
        items: const [
          BottomNavigationBarItem(
            icon: Icon(Icons.home_outlined),
            label: 'Home',
          ),
          BottomNavigationBarItem(
            icon: Icon(Icons.calendar_today_outlined),
            label: 'Calendar',
          ),
        ],
      ),
    );
  }
}
