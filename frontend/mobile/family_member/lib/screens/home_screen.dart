import 'dart:async';

import 'package:flutter/material.dart';

import '../api/biometric_enrollments_api.dart';
import '../api/dependants_api.dart';
import '../api/family_link_requests_api.dart';
import '../api/users_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../widgets/link_requests_sheet.dart';
import '../widgets/visit_widgets.dart';
import 'dependant_detail_screen.dart';
import 'dependant_wizard_screen.dart';
import 'join_family_screen.dart';

/// The family member's dependants, each marked "In progress" while a caregiver is with them.
/// The "Register a dependant" action keeps the post-sign-up "skip for now" choice reachable later.
/// The bell holds family link requests: ones waiting for the caller's answer as a primary contact,
/// and the outcome of the caller's own (the in-app notification, 2026-09-26).
class HomeScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final UsersApi usersApi;
  final FamilyLinkRequestsApi linkRequestsApi;
  final IdentityClaims identity;
  final VoidCallback onSignedOut;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.dependantsApi,
    required this.visitSchedulesApi,
    required this.enrollmentsApi,
    required this.usersApi,
    required this.linkRequestsApi,
    required this.identity,
    required this.onSignedOut,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<Dependant>? _dependants;
  Set<String> _dependantsWithOngoingVisit = {};
  String? _myUserId;
  String? _error;
  // Link requests needing the caller's attention - the bell's count.
  int _attention = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _loadRequests() async {
    try {
      final requests = await widget.linkRequestsApi.list();
      if (mounted) setState(() => _attention = requests.attentionCount);
    } catch (_) {
      // Only the bell's count - the sheet itself shows any error when opened.
    }
  }

  Future<void> _openRequests() async {
    await showLinkRequestsSheet(
      context,
      linkRequestsApi: widget.linkRequestsApi,
      onJoinFamily: () {
        Navigator.of(context).pop();
        _joinFamily();
      },
      // An approval can add dependants to someone's list, and seen outcomes clear the count.
      onChanged: _load,
    );
    if (mounted) _load();
  }

  Future<void> _joinFamily() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            JoinFamilyScreen(linkRequestsApi: widget.linkRequestsApi),
      ),
    );
    if (mounted) _loadRequests();
  }

  Future<void> _load() async {
    unawaited(_loadRequests());
    setState(() => _error = null);
    try {
      // One in_progress query covers every dependant (it's already scoped to the caller's own),
      // rather than one visits call per dependant.
      final results = await Future.wait<Object>([
        widget.dependantsApi.listDependants(),
        widget.visitSchedulesApi.listVisits(status: 'in_progress'),
      ]);
      if (results case [
        List<Dependant> dependants,
        List<VisitSchedule> ongoing,
      ] when mounted) {
        // Deactivated dependants go last; otherwise alphabetical.
        dependants.sort(
          (a, b) => a.active != b.active
              ? (a.active ? -1 : 1)
              : a.fullName.compareTo(b.fullName),
        );
        setState(() {
          _dependants = dependants;
          _dependantsWithOngoingVisit = {
            for (final v in ongoing) v.dependantId,
          };
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
    // Only used to mark the caller's own row "You" on the Family tab, so a failure here just
    // leaves that label off rather than blocking the list.
    if (_myUserId == null) {
      try {
        final me = await widget.usersApi.getMe();
        if (mounted) setState(() => _myUserId = me.id);
      } catch (_) {}
    }
  }

  Future<void> _signOut() async {
    await widget.authService.signOut();
    widget.onSignedOut();
  }

  Future<void> _registerDependant() async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DependantWizardScreen.register(
          dependantsApi: widget.dependantsApi,
          enrollmentsApi: widget.enrollmentsApi,
          usersApi: widget.usersApi,
          identity: widget.identity,
          onDone: () => Navigator.of(context).pop(),
        ),
      ),
    );
    if (mounted) _load();
  }

  Future<void> _openDependant(Dependant dependant) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => DependantDetailScreen(
          dependant: dependant,
          myUserId: _myUserId,
          dependantsApi: widget.dependantsApi,
          visitSchedulesApi: widget.visitSchedulesApi,
          enrollmentsApi: widget.enrollmentsApi,
        ),
      ),
    );
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('My dependants', style: TextStyle(fontSize: 16)),
        actions: [
          IconButton(
            tooltip: 'Family requests',
            onPressed: _openRequests,
            icon: Badge(
              isLabelVisible: _attention > 0,
              label: Text('$_attention'),
              child: const Icon(Icons.notifications_none),
            ),
          ),
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Sign out',
            onPressed: _signOut,
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _registerDependant,
        icon: const Icon(Icons.add),
        label: const Text('Register a dependant'),
      ),
      body: constrainedContent(
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            // Bottom padding keeps the last card clear of the floating button.
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
            children: _buildBody(),
          ),
        ),
      ),
    );
  }

  List<Widget> _buildBody() {
    if (_error case final message?) {
      return [
        SectionCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              Text(message, style: const TextStyle(color: inkSecondary)),
              TextButton(onPressed: _load, child: const Text('Retry')),
            ],
          ),
        ),
      ];
    }
    final dependants = _dependants;
    if (dependants == null) {
      return const [
        Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        ),
      ];
    }
    if (dependants.isEmpty) {
      return [
        SectionCard(
          padding: const EdgeInsets.all(20),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text(
                "You haven't registered or been linked to a dependant yet. Register one with "
                'the button below, or if someone in your family already registered them, ask '
                'them to link you.',
                style: TextStyle(color: inkSecondary),
              ),
              const SizedBox(height: 8),
              TextButton.icon(
                onPressed: _joinFamily,
                icon: const Icon(Icons.group_add_outlined),
                label: const Text('Ask to join a family'),
              ),
            ],
          ),
        ),
      ];
    }
    final today = DateTime.now();
    return [
      for (final dependant in dependants)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: _DependantCard(
            dependant: dependant,
            age: dependant.ageOn(today),
            visitInProgress: _dependantsWithOngoingVisit.contains(dependant.id),
            onTap: () => _openDependant(dependant),
          ),
        ),
    ];
  }
}

class _DependantCard extends StatelessWidget {
  final Dependant dependant;
  final int age;
  final bool visitInProgress;
  final VoidCallback onTap;

  const _DependantCard({
    required this.dependant,
    required this.age,
    required this.visitInProgress,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final subtitle = ['$age years', ?dependant.areaText].join(' · ');
    return Opacity(
      opacity: dependant.active ? 1 : 0.6,
      child: Material(
        color: Colors.white,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: borderColor),
        ),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        dependant.fullName,
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w500,
                          color: inkDefault,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        subtitle,
                        style: const TextStyle(
                          fontSize: 13,
                          color: inkTertiary,
                        ),
                      ),
                      if (dependant.needsPhoto)
                        Padding(
                          padding: const EdgeInsets.only(top: 6),
                          child: Row(
                            children: [
                              const Icon(
                                Icons.photo_camera_outlined,
                                size: 14,
                                color: dangerRed,
                              ),
                              const SizedBox(width: 4),
                              // Wraps rather than overflowing on a narrow phone, where the
                              // "In progress" pill shares the row.
                              Flexible(
                                child: Text(
                                  dependant.checkinPhotoStatus ==
                                          CheckinPhotoStatus.awaitingReview
                                      ? 'Photo awaiting review'
                                      : 'Photo needed',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    color: dangerRed,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                    ],
                  ),
                ),
                if (!dependant.active)
                  const Text(
                    'Deactivated',
                    style: TextStyle(fontSize: 12, color: inkSecondary),
                  )
                else if (visitInProgress)
                  const StatusPill('in_progress'),
                const SizedBox(width: 4),
                const Icon(Icons.chevron_right, color: inkTertiary),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
