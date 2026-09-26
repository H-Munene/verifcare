import 'package:flutter/material.dart';

import '../api/biometric_enrollments_api.dart';
import '../api/dependants_api.dart';
import '../api/users_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../widgets/visit_widgets.dart';
import 'dependant_detail_screen.dart';
import 'register_dependant_screen.dart';

/// The family member's dependants, each marked "In progress" while a caregiver is with them.
/// The "Register a dependant" action keeps the post-sign-up "skip for now" choice reachable later.
class HomeScreen extends StatefulWidget {
  final CognitoAuthService authService;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final UsersApi usersApi;
  final IdentityClaims identity;
  final VoidCallback onSignedOut;

  const HomeScreen({
    super.key,
    required this.authService,
    required this.dependantsApi,
    required this.visitSchedulesApi,
    required this.enrollmentsApi,
    required this.usersApi,
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

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
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
        builder: (_) => RegisterDependantScreen(
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
      return const [
        SectionCard(
          padding: EdgeInsets.all(20),
          child: Text(
            "You haven't registered or been linked to a dependant yet. "
            'Register one with the button below.',
            style: TextStyle(color: inkSecondary),
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
