import 'package:flutter/material.dart';

import '../../api/dependants_api.dart';
import '../../api/visit_schedules_api.dart';
import '../../app_ui.dart';
import '../../feed/visit_feed.dart';
import '../../widgets/dependant_switcher.dart';
import '../../widgets/states.dart';
import '../../widgets/visit_widgets.dart';
import '../check_in_code_screen.dart';
import '../upcoming_visit_screen.dart';
import '../visit_timeline_screen.dart';

const _amber = Color(0xFFB07D00);
const _amberTint = Color(0xFFFFF4D6);

/// Today, for one dependant (2026-10-12 redesign, after Birdie's and Honor's family apps): what is
/// happening now or next, then everything recorded in the last week, newest first. Answers "is my
/// parent OK today?" at a glance.
class TodayTab extends StatefulWidget {
  final Dependant dependant;

  /// Opens the dependant picker; null when there is only one dependant.
  final VoidCallback? onSwitchDependant;

  /// The signed-in family member's first name for the greeting, once known.
  final String? myFirstName;

  final DependantsApi dependantsApi;
  final VisitSchedulesApi visitSchedulesApi;

  const TodayTab({
    super.key,
    required this.dependant,
    required this.onSwitchDependant,
    required this.myFirstName,
    required this.dependantsApi,
    required this.visitSchedulesApi,
  });

  @override
  State<TodayTab> createState() => _TodayTabState();
}

class _TodayData {
  final NowState now;
  final List<FeedEvent> feed;

  /// When the visit in progress checked in, if it is in the loaded details.
  final DateTime? checkedInAt;

  const _TodayData(this.now, this.feed, this.checkedInAt);
}

class _TodayTabState extends State<TodayTab> with AutomaticKeepAliveClientMixin {
  _TodayData? _data;
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
      final api = widget.visitSchedulesApi;
      final visits = await api.listVisits(dependantId: widget.dependant.id);
      final now = DateTime.now();
      // One verification (and, for finished visits, task outcomes) call per visit of the last
      // week - a handful for a dependant with daily visits. A failed detail call only drops that
      // visit's detail events, never the whole feed.
      // ponytail: N small calls; add a batched "recent activity" endpoint if feeds grow large.
      final details = await Future.wait(
        feedVisits(visits, now).map((visit) async {
          final (audit, outcomes) = await (
            _orNull(() => api.getVerification(visit.id)),
            visit.status == 'completed'
                ? _orNull(() => api.getTaskOutcomes(visit.id))
                : Future.value(null),
          ).wait;
          return VisitWithDetails(visit, audit: audit, outcomes: outcomes);
        }),
      );
      final nowState = nowStateFor(visits, now);
      final checkedInAt = nowState is NowInProgress
          ? details
                .where((d) => d.visit.id == nowState.visit.id)
                .firstOrNull
                ?.audit
                ?.checkinAt
          : null;
      if (mounted) {
        setState(() => _data = _TodayData(nowState, buildFeed(details, now), checkedInAt));
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  static Future<T?> _orNull<T>(Future<T> Function() load) async {
    try {
      return await load();
    } catch (_) {
      return null;
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
    if (mounted) _load();
  }

  // A code only makes sense for today's visit: one due now, or later today (a caregiver may be
  // early).
  VisitSchedule? _codeVisit(NowState state) => switch (state) {
    NowAwaitingCheckin(:final visit) => visit,
    NowNext(:final visit) when DateUtils.isSameDay(visit.scheduledStart, DateTime.now()) => visit,
    _ => null,
  };

  Future<void> _showCode(VisitSchedule visit) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => CheckInCodeScreen(
          visit: visit,
          visitSchedulesApi: widget.visitSchedulesApi,
        ),
      ),
    );
    if (mounted) _load();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final dependantFirst = firstName(widget.dependant.fullName);
    final data = _data;
    return constrainedContent(
      RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 24),
          children: [
            DependantSwitcher(
              name: widget.dependant.fullName,
              onSwitch: widget.onSwitchDependant,
            ),
            const SizedBox(height: 12),
            _Greeting(name: widget.myFirstName, dependantFirst: dependantFirst),
            const SizedBox(height: 16),
            if (_error case final message?)
              ErrorState(message: message, onRetry: _load)
            else if (data == null) ...[
              const SkeletonCards(count: 1, cardHeight: 112),
              const SectionTitle('Recent activity'),
              const SkeletonCards(count: 3, cardHeight: 64),
            ] else ...[
              _NowCard(
                state: data.now,
                dependantFirst: dependantFirst,
                checkedInAt: data.checkedInAt,
                onOpen: _open,
              ),
              if (_codeVisit(data.now) case final visit?) ...[
                const SizedBox(height: 8),
                FilledButton.icon(
                  onPressed: () => _showCode(visit),
                  icon: const Icon(Icons.qr_code_2),
                  label: const Text('Show check-in code'),
                ),
              ],
              const SizedBox(height: 8),
              const SectionTitle('Recent activity'),
              if (data.feed.isEmpty)
                EmptyState(
                  icon: Icons.history,
                  title: 'Nothing in the last week',
                  message:
                      "Arrivals, check-ins and finished visits for $dependantFirst will show here "
                      'as they happen.',
                )
              else
                _Feed(events: data.feed, onOpen: _open),
            ],
          ],
        ),
      ),
    );
  }
}

class _Greeting extends StatelessWidget {
  final String? name;
  final String dependantFirst;

  const _Greeting({required this.name, required this.dependantFirst});

  @override
  Widget build(BuildContext context) {
    final hour = DateTime.now().hour;
    final part = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          name == null ? 'Good $part' : 'Good $part, $name',
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: inkDefault),
        ),
        const SizedBox(height: 4),
        Text(
          "Here's how $dependantFirst's care is going.",
          style: const TextStyle(fontSize: 14, color: inkSecondary),
        ),
      ],
    );
  }
}

/// "Today", "Tomorrow", "Yesterday", or the date.
String _dayLabel(BuildContext context, DateTime t) {
  final today = DateUtils.dateOnly(DateTime.now());
  final days = DateUtils.dateOnly(t).difference(today).inDays;
  return switch (days) {
    0 => 'Today',
    1 => 'Tomorrow',
    -1 => 'Yesterday',
    _ => MaterialLocalizations.of(context).formatMediumDate(t),
  };
}

class _NowCard extends StatelessWidget {
  final NowState state;
  final String dependantFirst;
  final DateTime? checkedInAt;
  final void Function(VisitSchedule visit) onOpen;

  const _NowCard({
    required this.state,
    required this.dependantFirst,
    required this.checkedInAt,
    required this.onOpen,
  });

  @override
  Widget build(BuildContext context) {
    String window(VisitSchedule v) =>
        '${formatTime(context, v.scheduledStart)} - ${formatTime(context, v.scheduledEnd)}';
    final (eyebrow, accent, tint, title, detail, visit) = switch (state) {
      NowInProgress(:final visit) => (
        'WITH ${dependantFirst.toUpperCase()} NOW',
        primaryGreen,
        primaryTint,
        '${firstName(visit.caregiverDisplayName)} is visiting',
        [
          if (checkedInAt case final at?) 'Checked in ${formatTime(context, at)}',
          'until ${formatTime(context, visit.scheduledEnd)}',
        ].join(' · '),
        visit,
      ),
      NowAwaitingCheckin(:final visit) => (
        'STARTING NOW',
        _amber,
        _amberTint,
        'Waiting for ${firstName(visit.caregiverDisplayName)} to check in',
        'Visit window ${window(visit)}',
        visit,
      ),
      NowNext(:final visit) => (
        'NEXT VISIT',
        primaryGreen,
        primaryTint,
        '${_dayLabel(context, visit.scheduledStart)}, ${window(visit)}',
        'With ${visit.caregiverDisplayName}',
        visit,
      ),
      NowNothing() => (null, null, null, null, null, null),
    };
    if (visit == null) {
      return EmptyState(
        icon: Icons.event_busy_outlined,
        title: 'No visits scheduled',
        message: "The agency hasn't scheduled $dependantFirst's next visit yet.",
      );
    }
    return Material(
      color: Colors.white,
      shape: const RoundedRectangleBorder(side: BorderSide(color: borderColor)),
      child: InkWell(
        onTap: () => onOpen(visit),
        child: IntrinsicHeight(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(width: 4, color: accent),
              Expanded(
                child: Padding(
                  padding: const EdgeInsets.fromLTRB(16, 16, 8, 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
                        color: tint,
                        child: Text(
                          eyebrow!,
                          style: TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 0.8,
                            color: accent,
                          ),
                        ),
                      ),
                      const SizedBox(height: 10),
                      Text(
                        title!,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w600,
                          color: inkDefault,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(detail!, style: const TextStyle(fontSize: 14, color: inkSecondary)),
                    ],
                  ),
                ),
              ),
              const Padding(
                padding: EdgeInsets.only(right: 12),
                child: Icon(Icons.chevron_right, color: inkTertiary),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Feed extends StatelessWidget {
  final List<FeedEvent> events;
  final void Function(VisitSchedule visit) onOpen;

  const _Feed({required this.events, required this.onOpen});

  @override
  Widget build(BuildContext context) {
    final children = <Widget>[];
    String? day;
    for (final event in events) {
      final label = _dayLabel(context, event.at);
      if (label != day) {
        day = label;
        children.add(
          Padding(
            padding: EdgeInsets.only(top: children.isEmpty ? 0 : 14, bottom: 6, left: 2),
            child: Text(
              label.toUpperCase(),
              style: const TextStyle(
                fontSize: 11,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.8,
                color: inkTertiary,
              ),
            ),
          ),
        );
      }
      children.add(_FeedRow(event: event, onTap: () => onOpen(event.visit)));
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }
}

class _FeedRow extends StatelessWidget {
  final FeedEvent event;
  final VoidCallback onTap;

  const _FeedRow({required this.event, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final visit = event.visit;
    final caregiver = firstName(visit.caregiverDisplayName);
    final (icon, ink, tint, title, detail) = switch (event.kind) {
      FeedKind.arrived => (
        Icons.how_to_reg_outlined,
        primaryGreen,
        primaryTint,
        '$caregiver arrived',
        'Confirmed at the home by location.',
      ),
      FeedKind.started => (
        Icons.play_arrow_outlined,
        primaryGreen,
        primaryTint,
        'Visit started',
        event.startedBySupervisor
            ? 'Started by a supervisor, as nobody from the family could show the code.'
            : switch (event.confirmedBy) {
                final name? => '${firstName(name)} confirmed $caregiver with the check-in code.',
                null => '$caregiver checked in.',
              },
      ),
      FeedKind.finished => (
        Icons.check,
        successGreen,
        successTint,
        'Visit finished',
        switch (event.tasks) {
          (:final done, :final total) =>
            '$done of $total care ${total == 1 ? 'task' : 'tasks'} done with $caregiver.',
          null => 'With $caregiver.',
        },
      ),
      FeedKind.missed => (
        Icons.event_busy_outlined,
        dangerRed,
        dangerTint,
        'Missed visit',
        "$caregiver didn't check in for the ${formatTime(context, visit.scheduledStart)} visit."
            '${visit.status == 'investigated' ? ' A supervisor is following up.' : ''}',
      ),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Material(
        color: Colors.white,
        shape: const RoundedRectangleBorder(side: BorderSide(color: borderColor)),
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: 36,
                  height: 36,
                  color: tint,
                  child: Icon(icon, size: 20, color: ink),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title,
                        style: const TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: inkDefault,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(detail, style: const TextStyle(fontSize: 13, color: inkSecondary)),
                    ],
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  formatTime(context, event.at),
                  style: const TextStyle(fontSize: 12, color: inkTertiary),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
