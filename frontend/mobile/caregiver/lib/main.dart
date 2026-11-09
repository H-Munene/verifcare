import 'package:flutter/material.dart';

import 'api/api_client.dart';
import 'api/checkin_api.dart';
import 'api/terms_api.dart';
import 'api/visit_schedules_api.dart';
import 'app_ui.dart';
import 'auth/cognito_auth_service.dart';
import 'screens/account_screen.dart';
import 'screens/checkin_screen.dart';
import 'screens/consent_screen.dart';
import 'screens/home_screen.dart';
import 'screens/login_screen.dart';
import 'screens/schedule_calendar_screen.dart';
import 'screens/visit_in_progress_screen.dart';
import 'screens/visit_timeline_screen.dart';
import 'visit_notifications.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await VisitNotifications.init();
  runApp(MzaziCareCaregiverApp(authService: CognitoAuthService()));
}

class MzaziCareCaregiverApp extends StatelessWidget {
  final CognitoAuthService authService;

  const MzaziCareCaregiverApp({super.key, required this.authService});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Mzazi Care - Caregiver',
      theme: buildAppTheme(),
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
  // Lives here rather than in the shell, since the consent screen comes before the shell exists.
  late final _termsApi = TermsApi(ApiClient(widget.authService.getIdToken));

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
      // The whole signed-in app sits behind the consent screen (2026-09-26): nothing loads, and
      // no notification opens a visit, until the current terms are accepted.
      return ConsentGate(
        termsApi: _termsApi,
        sub: identity.sub,
        child: _AuthenticatedShell(
          authService: widget.authService,
          identity: identity,
          onSignedOut: () => setState(() => _identity = null),
        ),
      );
    }
    return LoginScreen(
      authService: widget.authService,
      onAuthenticated: (identity) => setState(() => _identity = identity),
    );
  }
}

/// Bottom-nav shell for a signed-in caregiver: Home (greeting and today's visits), Calendar (03b)
/// and Account (sign out), the last added 2026-10-12.
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
  int _visitsRefreshToken = 0;
  // The caregiver's checked-in visit, if any - read from the server rather than stored on the
  // phone, so the banner comes back correctly after the app is closed and reopened.
  VisitSchedule? _ongoingVisit;

  @override
  void initState() {
    super.initState();
    _apiClient = ApiClient(widget.authService.getIdToken);
    _visitSchedulesApi = VisitSchedulesApi(_apiClient);
    _checkinApi = CheckinApi(_apiClient);
    _loadOngoingVisit();
    VisitNotifications.tappedVisitId.addListener(_openTappedVisit);
    // A tap that cold-launched the app landed before this shell existed (or before sign-in).
    WidgetsBinding.instance.addPostFrameCallback((_) => _openTappedVisit());
  }

  @override
  void dispose() {
    VisitNotifications.tappedVisitId.removeListener(_openTappedVisit);
    super.dispose();
  }

  Future<void> _loadOngoingVisit() async {
    try {
      final page = await _visitSchedulesApi.listVisitSchedules(
        const ListVisitSchedulesParams(status: 'in_progress', limit: 1),
      );
      if (!mounted) return;
      final ongoing = page.items.firstOrNull;
      setState(() => _ongoingVisit = ongoing);
      // Keeps the pinned notification in step with the server: re-shown after a restart,
      // cleared if the visit ended some other way (e.g. marked missed).
      await (ongoing == null
          ? VisitNotifications.cancelOngoing()
          : VisitNotifications.showOngoing(ongoing));
    } on ApiException {
      // Best-effort - the calendar tab already surfaces real connectivity errors itself.
    }
  }

  void _refreshVisits() {
    setState(() => _visitsRefreshToken++);
    _loadOngoingVisit();
  }

  Future<void> _openTappedVisit() async {
    final visitId = VisitNotifications.tappedVisitId.value;
    if (visitId == null) return;
    VisitNotifications.tappedVisitId.value = null;
    try {
      final visit = await _visitSchedulesApi.getVisitSchedule(visitId);
      if (!mounted) return;
      Navigator.of(context).popUntil((route) => route.isFirst);
      await _openVisit(visit);
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.problem.detail ?? e.problem.title);
    }
  }

  // ScheduleCalendarScreen doesn't navigate itself - it only reports which visit was tapped, so
  // this shell (which owns the api instances every visit screen needs) decides where it goes by
  // status. Pushed as full routes, not tabs, since the wireframe's check-in flow (screens 4-9) is
  // explicitly "full-screen linear, no nav chrome" - it should cover the bottom bar too.
  Future<void> _openVisit(VisitSchedule visit) async {
    final navigator = Navigator.of(context);
    final Widget screen = switch (visit.status) {
      'in_progress' => VisitInProgressScreen(
        visit: visit,
        visitSchedulesApi: _visitSchedulesApi,
      ),
      'completed' || 'missed' => VisitTimelineScreen(
        visit: visit,
        visitSchedulesApi: _visitSchedulesApi,
      ),
      _ => CheckInScreen(
        visit: visit,
        visitSchedulesApi: _visitSchedulesApi,
        checkinApi: _checkinApi,
        onBack: navigator.pop,
        onCheckedIn: () => _startVisit(visit),
      ),
    };
    await navigator.push(MaterialPageRoute<void>(builder: (_) => screen));
    _refreshVisits();
  }

  // The visit has started: swap the whole check-in stack for the in-progress visit screen.
  void _startVisit(VisitSchedule visit) {
    Navigator.of(context).popUntil((route) => route.isFirst);
    _openVisit(
      VisitSchedule(
        id: visit.id,
        caregiverId: visit.caregiverId,
        dependantId: visit.dependantId,
        caregiverDisplayName: visit.caregiverDisplayName,
        dependantDisplayName: visit.dependantDisplayName,
        scheduledStart: visit.scheduledStart,
        scheduledEnd: visit.scheduledEnd,
        status: 'in_progress',
        createdBy: visit.createdBy,
        createdAt: visit.createdAt,
        updatedAt: visit.updatedAt,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final tabs = [
      HomeScreen(
        identity: widget.identity,
        visitSchedulesApi: _visitSchedulesApi,
        onSelectVisit: _openVisit,
        refreshToken: _visitsRefreshToken,
      ),
      ScheduleCalendarScreen(
        visitSchedulesApi: _visitSchedulesApi,
        onSelectVisit: _openVisit,
        refreshToken: _visitsRefreshToken,
      ),
      AccountScreen(
        authService: widget.authService,
        identity: widget.identity,
        onSignedOut: widget.onSignedOut,
      ),
    ];

    final ongoing = _ongoingVisit;
    return Scaffold(
      body: Column(
        children: [
          if (ongoing != null)
            _OngoingVisitBanner(
              visit: ongoing,
              onTap: () => _openVisit(ongoing),
            ),
          Expanded(
            // The banner already took the status-bar inset - stop each tab's own SafeArea from
            // adding it a second time.
            child: MediaQuery.removePadding(
              context: context,
              removeTop: ongoing != null,
              child: IndexedStack(index: _tabIndex, children: tabs),
            ),
          ),
        ],
      ),
      // Same bar as the family app (2026-10-12): Home, Calendar, and Account for signing out.
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tabIndex,
        onDestinationSelected: (index) => setState(() => _tabIndex = index),
        backgroundColor: Colors.white,
        indicatorColor: primaryTint,
        destinations: const [
          NavigationDestination(
            icon: Icon(Icons.home_outlined),
            selectedIcon: Icon(Icons.home, color: primaryGreen),
            label: 'Home',
          ),
          NavigationDestination(
            icon: Icon(Icons.calendar_today_outlined),
            selectedIcon: Icon(Icons.calendar_today, color: primaryGreen),
            label: 'Calendar',
          ),
          NavigationDestination(
            icon: Icon(Icons.person_outline),
            selectedIcon: Icon(Icons.person, color: primaryGreen),
            label: 'Account',
          ),
        ],
      ),
    );
  }
}

/// Pinned above both tabs while a visit is checked in - the way back to its checklist.
class _OngoingVisitBanner extends StatelessWidget {
  final VisitSchedule visit;
  final VoidCallback onTap;

  const _OngoingVisitBanner({required this.visit, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Material(
      color: primaryGreen,
      child: InkWell(
        onTap: onTap,
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                const Icon(Icons.timelapse, color: Colors.white, size: 20),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Ongoing visit',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      Text(
                        '${visit.dependantDisplayName} - tap to return to the checklist',
                        style: const TextStyle(
                          color: Colors.white70,
                          fontSize: 12,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: Colors.white),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
