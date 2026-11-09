import 'package:flutter/material.dart';

import '../../api/dependants_api.dart';
import '../../api/visit_schedules_api.dart';
import '../../app_ui.dart';
import '../../widgets/dependant_switcher.dart';
import '../../widgets/states.dart';
import '../../widgets/visit_widgets.dart';
import '../upcoming_visit_screen.dart';
import '../visit_timeline_screen.dart';

/// Every visit for one dependant: in progress, upcoming (soonest first) and history (latest
/// first). Moved from the old dependant page's Visits tab in the 2026-10-12 redesign.
class VisitsTab extends StatefulWidget {
  final Dependant dependant;

  /// Opens the dependant picker; null when there is only one dependant.
  final VoidCallback? onSwitchDependant;
  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;

  const VisitsTab({
    super.key,
    required this.dependant,
    required this.onSwitchDependant,
    required this.dependantsApi,
    required this.visitSchedulesApi,
  });

  @override
  State<VisitsTab> createState() => _VisitsTabState();
}

class _VisitsTabState extends State<VisitsTab> with AutomaticKeepAliveClientMixin {
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
        : VisitTimelineScreen(visit: visit, visitSchedulesApi: widget.visitSchedulesApi);
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => screen));
    // A visit may have moved on (e.g. checked out) while it was open.
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final visits = _visits;
    final firstName = widget.dependant.fullName.split(' ').first;
    final List<Widget> children;
    if (_error case final message?) {
      children = [ErrorState(message: message, onRetry: _load)];
    } else if (visits == null) {
      children = const [SectionTitle('Upcoming'), SkeletonCards(count: 4, cardHeight: 64)];
    } else {
      List<VisitSchedule> where(bool Function(VisitSchedule) test) =>
          visits.where(test).toList();
      final ongoing = where((v) => v.status == 'in_progress')
        ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
      final upcoming = where((v) => v.status == 'scheduled')
        ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
      final history = where((v) => v.status != 'scheduled' && v.status != 'in_progress')
        ..sort((a, b) => b.scheduledStart.compareTo(a.scheduledStart));
      children = [
        if (ongoing.isNotEmpty) ...[
          const SectionTitle('In progress'),
          _visitList(ongoing),
          const SizedBox(height: 8),
        ],
        const SectionTitle('Upcoming'),
        upcoming.isEmpty
            ? EmptyState(
                icon: Icons.event_available_outlined,
                title: 'No upcoming visits',
                message: "New visits for $firstName will appear here once they're scheduled.",
              )
            : _visitList(upcoming),
        const SizedBox(height: 8),
        const SectionTitle('History'),
        history.isEmpty
            ? const EmptyState(
                icon: Icons.history,
                title: 'No past visits yet',
                message: 'Finished and missed visits will be listed here.',
              )
            : _visitList(history),
      ];
    }
    return constrainedContent(
      RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
          children: [
            DependantSwitcher(
              name: widget.dependant.fullName,
              onSwitch: widget.onSwitchDependant,
            ),
            const SizedBox(height: 4),
            ...children,
          ],
        ),
      ),
    );
  }

  Widget _visitList(List<VisitSchedule> visits) => SectionCard(
    child: Column(
      children: [
        for (final (i, visit) in visits.indexed) ...[
          if (i > 0) const Divider(height: 1, color: borderColor),
          _VisitRow(
            visit: visit,
            // A cancelled or reassigned visit never happened, so there is no timeline to show.
            onTap: visit.status == 'cancelled' || visit.status == 'reassigned'
                ? null
                : () => _open(visit),
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
        padding: const EdgeInsets.fromLTRB(16, 14, 8, 14),
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
                    style: const TextStyle(fontSize: 13, color: inkSecondary),
                  ),
                ],
              ),
            ),
            const SizedBox(width: 8),
            StatusPill(visit.status),
            SizedBox(
              width: 32,
              child: onTap == null ? null : const Icon(Icons.chevron_right, color: inkTertiary),
            ),
          ],
        ),
      ),
    );
  }
}
