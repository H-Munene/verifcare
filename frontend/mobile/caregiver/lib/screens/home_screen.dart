import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../widgets/states.dart';

/// The caregiver's Home (2026-10-12, replacing the 2026-09-22 stub; same greeting style as the
/// family app's Today): a greeting, today's visits in order, and the next visit after today.
/// Tapping a visit hands it to the shell, which opens check-in, the visit in progress or its
/// timeline by status.
class HomeScreen extends StatefulWidget {
  final IdentityClaims identity;
  final VisitSchedulesApi visitSchedulesApi;
  final void Function(VisitSchedule visit) onSelectVisit;

  /// Bumped by the shell after a visit screen closes, so the list reloads.
  final int refreshToken;

  const HomeScreen({
    super.key,
    required this.identity,
    required this.visitSchedulesApi,
    required this.onSelectVisit,
    required this.refreshToken,
  });

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  List<VisitSchedule>? _visits;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(HomeScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.refreshToken != widget.refreshToken) _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    final today = DateUtils.dateOnly(DateTime.now());
    try {
      // Today and the coming fortnight - enough to always find "next" for a regular schedule.
      final page = await widget.visitSchedulesApi.listVisitSchedules(
        ListVisitSchedulesParams(
          scheduledStartFrom: today,
          scheduledStartTo: today.add(const Duration(days: 15)),
          limit: 100,
        ),
      );
      final visits = page.items.where((v) => v.status != 'cancelled').toList()
        ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
      if (mounted) setState(() => _visits = visits);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.problem.detail ?? e.problem.title);
    } catch (_) {
      if (mounted) {
        setState(
          () => _error = 'Could not reach the server. Check your connection and try again.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final visits = _visits;
    final today = DateUtils.dateOnly(DateTime.now());
    final todays = visits
        ?.where((v) => DateUtils.isSameDay(v.scheduledStart, today))
        .toList();
    final tomorrow = today.add(const Duration(days: 1));
    final next = visits?.where((v) => !v.scheduledStart.isBefore(tomorrow)).firstOrNull;
    final name = widget.identity.fullName?.trim().split(RegExp(r'\s+')).first;

    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      body: SafeArea(
        child: constrainedContent(
          RefreshIndicator(
            onRefresh: _load,
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
              children: [
                _Greeting(name: name, todayCount: todays?.length),
                const SizedBox(height: 20),
                if (_error case final message?)
                  ErrorState(message: message, onRetry: _load)
                else if (todays == null) ...[
                  const _SectionTitle('Today'),
                  const SkeletonCards(count: 2, cardHeight: 76),
                ] else ...[
                  const _SectionTitle('Today'),
                  if (todays.isEmpty)
                    const EmptyState(
                      icon: Icons.event_available_outlined,
                      title: 'No visits today',
                      message: 'Enjoy the break. Your next visits are below and in the Calendar.',
                    )
                  else
                    for (final visit in todays)
                      _VisitCard(visit: visit, onTap: () => widget.onSelectVisit(visit)),
                  const SizedBox(height: 12),
                  const _SectionTitle('Coming up'),
                  if (next == null)
                    const EmptyState(
                      icon: Icons.event_note_outlined,
                      title: 'Nothing scheduled yet',
                      message: 'New visits appear here as soon as a supervisor schedules them.',
                    )
                  else
                    _VisitCard(visit: next, showDate: true, onTap: () => widget.onSelectVisit(next)),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Greeting extends StatelessWidget {
  final String? name;

  /// Today's visit count, once loaded.
  final int? todayCount;

  const _Greeting({required this.name, required this.todayCount});

  @override
  Widget build(BuildContext context) {
    final hour = DateTime.now().hour;
    final part = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
    final count = todayCount;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          name == null || name!.isEmpty ? 'Good $part' : 'Good $part, $name',
          style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, color: inkDefault),
        ),
        const SizedBox(height: 4),
        Text(
          switch (count) {
            null => "Here's your day.",
            0 => 'You have no visits today.',
            1 => 'You have 1 visit today.',
            _ => 'You have $count visits today.',
          },
          style: const TextStyle(fontSize: 14, color: inkSecondary),
        ),
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  final String text;
  const _SectionTitle(this.text);

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 2, bottom: 8),
    child: Text(
      text.toUpperCase(),
      style: const TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.8,
        color: inkTertiary,
      ),
    ),
  );
}

class _VisitCard extends StatelessWidget {
  final VisitSchedule visit;
  final bool showDate;
  final VoidCallback onTap;

  const _VisitCard({required this.visit, this.showDate = false, required this.onTap});

  @override
  Widget build(BuildContext context) {
    String time(DateTime t) => TimeOfDay.fromDateTime(t).format(context);
    final window = '${time(visit.scheduledStart)} - ${time(visit.scheduledEnd)}';
    // Same wording as the Calendar and the admin web app for the two check-in states.
    final (label, ink, tint, accent) = switch (visit.status) {
      'in_progress' => ('Checked in', primaryGreen, primaryTint, primaryGreen),
      'completed' => ('Checked out', successGreen, successTint, successGreen),
      'missed' || 'investigated' => ('Missed', dangerRed, dangerTint, dangerRed),
      _ => ('Scheduled', inkSecondary, const Color(0xFFF0F0F0), borderColor),
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: Colors.white,
        shape: const RoundedRectangleBorder(side: BorderSide(color: borderColor)),
        child: InkWell(
          onTap: onTap,
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(width: 4, color: accent),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 14, 8, 14),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          showDate
                              ? '${MaterialLocalizations.of(context).formatMediumDate(visit.scheduledStart)}, $window'
                              : window,
                          style: const TextStyle(fontSize: 13, color: inkSecondary),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          visit.dependantDisplayName,
                          style: const TextStyle(
                            fontSize: 16,
                            fontWeight: FontWeight.w600,
                            color: inkDefault,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                Center(
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                    color: tint,
                    child: Text(
                      label,
                      style: TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: ink),
                    ),
                  ),
                ),
                const Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8),
                  child: Icon(Icons.chevron_right, color: inkTertiary),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
