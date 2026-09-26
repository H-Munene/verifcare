import 'package:flutter/material.dart';

import '../api/biometric_enrollments_api.dart';
import '../api/dependants_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../widgets/visit_widgets.dart';
import 'dependant_wizard_screen.dart';
import 'upcoming_visit_screen.dart';
import 'visit_timeline_screen.dart';

/// One dependant: a header with their details, then two tabs - Visits (in progress, upcoming,
/// history) and Family (every linked member). Each tab loads and fails on its own. The primary
/// contact also gets an Edit action. (A Photos tab was removed 2026-09-26 at the user's request -
/// the enrolled photo is managed from Edit's Photo step.)
class DependantDetailScreen extends StatefulWidget {
  final Dependant dependant;
  final String? myUserId;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;
  final BiometricEnrollmentsApi enrollmentsApi;

  const DependantDetailScreen({
    super.key,
    required this.dependant,
    required this.myUserId,
    required this.dependantsApi,
    required this.visitSchedulesApi,
    required this.enrollmentsApi,
  });

  @override
  State<DependantDetailScreen> createState() => _DependantDetailScreenState();
}

class _DependantDetailScreenState extends State<DependantDetailScreen> {
  late Dependant _dependant = widget.dependant;
  bool _isPrimaryContact = false;
  // Bumped after an edit, so every tab rebuilds and reloads (e.g. a replaced photo).
  int _version = 0;

  @override
  void initState() {
    super.initState();
    _checkPrimaryContact();
  }

  // Only the primary contact may edit (the backend enforces it too) - so the Edit action is
  // shown only once the caller's own link is confirmed as primary. Any failure leaves it hidden.
  Future<void> _checkPrimaryContact() async {
    final myUserId = widget.myUserId;
    if (myUserId == null) return;
    try {
      final members = await widget.dependantsApi.listFamilyMembers(
        _dependant.id,
      );
      final isPrimary = members.any(
        (m) => m.userId == myUserId && m.isPrimaryContact,
      );
      if (mounted) setState(() => _isPrimaryContact = isPrimary);
    } catch (_) {}
  }

  Future<void> _edit() async {
    final updated = await Navigator.of(context).push<Dependant>(
      MaterialPageRoute(
        builder: (_) => DependantWizardScreen.edit(
          dependantsApi: widget.dependantsApi,
          enrollmentsApi: widget.enrollmentsApi,
          existing: _dependant,
        ),
      ),
    );
    if (!mounted) return;
    // A photo may have been replaced even when the details weren't saved, so reload either way.
    setState(() {
      _dependant = updated ?? _dependant;
      _version++;
    });
    if (updated != null) showSnack(context, 'Details saved.', error: false);
  }

  @override
  Widget build(BuildContext context) {
    final dependant = _dependant;
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        backgroundColor: const Color(0xFFF7F7F7),
        appBar: AppBar(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.white,
          title: Text(dependant.fullName, style: const TextStyle(fontSize: 16)),
          actions: [
            if (_isPrimaryContact)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: TextButton(onPressed: _edit, child: const Text('Edit')),
              ),
          ],
        ),
        body: NestedScrollView(
          headerSliverBuilder: (context, _) => [
            SliverToBoxAdapter(child: _Header(dependant)),
            const SliverPersistentHeader(
              pinned: true,
              delegate: _TabBarHeader(),
            ),
          ],
          body: TabBarView(
            children: [
              _VisitsTab(
                key: ValueKey('visits-$_version'),
                dependant: dependant,
                dependantsApi: widget.dependantsApi,
                visitSchedulesApi: widget.visitSchedulesApi,
              ),
              _FamilyTab(
                key: ValueKey('family-$_version'),
                dependantId: dependant.id,
                myUserId: widget.myUserId,
                dependantsApi: widget.dependantsApi,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final Dependant dependant;
  const _Header(this.dependant);

  @override
  Widget build(BuildContext context) {
    final age = dependant.ageOn(DateTime.now());
    final facts = [
      '$age years',
      if (dependant.gender case final gender?)
        '${gender[0].toUpperCase()}${gender.substring(1)}',
      if (!dependant.active) 'Deactivated',
    ].join(' · ');
    final address = [?dependant.homeAddressText, ?dependant.areaText];

    return Container(
      color: Colors.white,
      child: constrainedContent(
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                facts,
                style: const TextStyle(fontSize: 14, color: inkSecondary),
              ),
              for (final line in address)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Text(
                    line,
                    style: const TextStyle(fontSize: 13, color: inkTertiary),
                  ),
                ),
              if (dependant.primaryConditionSummary case final condition?)
                Padding(
                  padding: const EdgeInsets.only(top: 8),
                  child: Text(
                    condition,
                    style: const TextStyle(fontSize: 13, color: inkSecondary),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _TabBarHeader extends SliverPersistentHeaderDelegate {
  const _TabBarHeader();

  static const _height = 48.0;

  @override
  double get minExtent => _height;
  @override
  double get maxExtent => _height;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlaps) =>
      const ColoredBox(
        color: Colors.white,
        child: TabBar(
          labelColor: primaryBlue,
          indicatorColor: primaryBlue,
          unselectedLabelColor: inkSecondary,
          tabs: [
            Tab(text: 'Visits'),
            Tab(text: 'Family'),
          ],
        ),
      );

  @override
  bool shouldRebuild(_TabBarHeader oldDelegate) => false;
}

/// Shared shell for a tab: loading, error-with-retry, then content, all pull-to-refresh.
class _TabBody<T> extends StatelessWidget {
  final T? data;
  final String? error;
  final Future<void> Function() onRefresh;
  final List<Widget> Function(T data) builder;

  const _TabBody({
    required this.data,
    required this.error,
    required this.onRefresh,
    required this.builder,
  });

  @override
  Widget build(BuildContext context) {
    final data = this.data;
    final children = switch ((data, error)) {
      (_, final String message) => [
        SectionCard(
          padding: const EdgeInsets.all(16),
          child: Column(
            children: [
              Text(message, style: const TextStyle(color: inkSecondary)),
              TextButton(onPressed: onRefresh, child: const Text('Retry')),
            ],
          ),
        ),
      ],
      (null, _) => [
        const Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        ),
      ],
      (final T data, _) => builder(data),
    };
    return constrainedContent(
      RefreshIndicator(
        onRefresh: onRefresh,
        child: ListView(padding: const EdgeInsets.all(16), children: children),
      ),
    );
  }
}

class _Empty extends StatelessWidget {
  final String text;
  const _Empty(this.text);

  @override
  Widget build(BuildContext context) => SectionCard(
    padding: const EdgeInsets.all(16),
    child: Text(text, style: const TextStyle(color: inkTertiary)),
  );
}

// ---------------------------------------------------------------------------------------------
// Visits

class _VisitsTab extends StatefulWidget {
  final Dependant dependant;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;

  const _VisitsTab({
    super.key,
    required this.dependant,
    required this.dependantsApi,
    required this.visitSchedulesApi,
  });

  @override
  State<_VisitsTab> createState() => _VisitsTabState();
}

class _VisitsTabState extends State<_VisitsTab>
    with AutomaticKeepAliveClientMixin {
  List<VisitSchedule>? _visits;
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final visits = await widget.visitSchedulesApi.listVisits(
        dependantId: widget.dependant.id,
      );
      if (mounted) setState(() => _visits = visits);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _open(VisitSchedule visit) async {
    final Widget screen = visit.status == 'scheduled'
        ? UpcomingVisitScreen(
            visit: visit,
            dependant: widget.dependant,
            dependantsApi: widget.dependantsApi,
          )
        : VisitTimelineScreen(
            visit: visit,
            visitSchedulesApi: widget.visitSchedulesApi,
          );
    await Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => screen));
    // A visit may have moved on (e.g. checked out) while the caregiver was being watched.
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return _TabBody<List<VisitSchedule>>(
      data: _visits,
      error: _error,
      onRefresh: _load,
      builder: (visits) {
        List<VisitSchedule> where(bool Function(VisitSchedule) test) =>
            visits.where(test).toList();
        final ongoing = where((v) => v.status == 'in_progress')
          ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
        final upcoming = where((v) => v.status == 'scheduled')
          ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
        final history = where(
          (v) => v.status != 'scheduled' && v.status != 'in_progress',
        )..sort((a, b) => b.scheduledStart.compareTo(a.scheduledStart));
        return [
          if (ongoing.isNotEmpty) ...[
            const SectionTitle('In progress'),
            _visitList(ongoing),
            const SizedBox(height: 8),
          ],
          const SectionTitle('Upcoming'),
          upcoming.isEmpty
              ? const _Empty('No upcoming visits.')
              : _visitList(upcoming),
          const SizedBox(height: 8),
          const SectionTitle('History'),
          history.isEmpty
              ? const _Empty('No past visits yet.')
              : _visitList(history),
        ];
      },
    );
  }

  Widget _visitList(List<VisitSchedule> visits) => SectionCard(
    child: Column(
      children: [
        for (final (i, visit) in visits.indexed) ...[
          if (i > 0) const Divider(height: 1, color: borderColor),
          _VisitRow(
            visit: visit,
            // A cancelled visit never happened, so there is no timeline to show.
            onTap: visit.status == 'cancelled' ? null : () => _open(visit),
          ),
        ],
      ],
    ),
  );
}

class _VisitRow extends StatelessWidget {
  final VisitSchedule visit;
  final VoidCallback? onTap;

  const _VisitRow({required this.visit, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    formatVisitWindow(context, visit),
                    style: const TextStyle(fontSize: 14, color: inkDefault),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    visit.caregiverDisplayName,
                    style: const TextStyle(fontSize: 12, color: inkTertiary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            StatusPill(visit.status),
            SizedBox(
              width: 32,
              child: onTap == null
                  ? null
                  : const Icon(Icons.chevron_right, color: inkTertiary),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Family

class _FamilyTab extends StatefulWidget {
  final String dependantId;
  final String? myUserId;
  final DependantsApi dependantsApi;

  const _FamilyTab({
    super.key,
    required this.dependantId,
    required this.myUserId,
    required this.dependantsApi,
  });

  @override
  State<_FamilyTab> createState() => _FamilyTabState();
}

class _FamilyTabState extends State<_FamilyTab>
    with AutomaticKeepAliveClientMixin {
  List<FamilyMemberLink>? _members;
  String? _error;

  @override
  bool get wantKeepAlive => true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final members = await widget.dependantsApi.listFamilyMembers(
        widget.dependantId,
      );
      // Primary contact first, then alphabetical.
      members.sort(
        (a, b) => a.isPrimaryContact != b.isPrimaryContact
            ? (a.isPrimaryContact ? -1 : 1)
            : a.fullName.compareTo(b.fullName),
      );
      if (mounted) setState(() => _members = members);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return _TabBody<List<FamilyMemberLink>>(
      data: _members,
      error: _error,
      onRefresh: _load,
      builder: (members) => [
        SectionCard(
          child: Column(
            children: [
              for (final (i, member) in members.indexed) ...[
                if (i > 0) const Divider(height: 1, color: borderColor),
                ListTile(
                  leading: CircleAvatar(
                    backgroundColor: const Color(0xFFE6F1FC),
                    foregroundColor: primaryBlue,
                    child: Text(_initials(member.fullName)),
                  ),
                  title: Text(
                    member.userId == widget.myUserId
                        ? '${member.fullName} (You)'
                        : member.fullName,
                    style: const TextStyle(fontSize: 14),
                  ),
                  subtitle: Text(
                    member.relationship ?? 'Relationship not set',
                    style: const TextStyle(fontSize: 12, color: inkTertiary),
                  ),
                  trailing: member.isPrimaryContact
                      ? const Text(
                          'Primary contact',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w500,
                            color: primaryBlue,
                          ),
                        )
                      : null,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }

  static String _initials(String name) => name
      .split(RegExp(r'\s+'))
      .where((part) => part.isNotEmpty)
      .take(2)
      .map((part) => part[0].toUpperCase())
      .join();
}
