import 'package:flutter/material.dart';

import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../widgets/visit_widgets.dart';

/// A visit's four milestones - the same steps, from the same GET .../verification data, as the
/// admin web app's VisitDetailPage and the caregiver app's timeline - followed by what the
/// caregiver recorded for each care activity (GET .../task-outcomes).
/// On a missed visit every step that never happened is drawn with an X; on one still in progress
/// the steps not reached yet read "Not yet".
class VisitTimelineScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;

  const VisitTimelineScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
  });

  @override
  State<VisitTimelineScreen> createState() => _VisitTimelineScreenState();
}

class _VisitTimelineScreenState extends State<VisitTimelineScreen> {
  VerificationAudit? _audit;
  List<TaskOutcome>? _outcomes;
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final results = await Future.wait<Object>([
        widget.visitSchedulesApi.getVerification(widget.visit.id),
        widget.visitSchedulesApi.getTaskOutcomes(widget.visit.id),
      ]);
      if (results case [
        VerificationAudit audit,
        List<TaskOutcome> outcomes,
      ] when mounted) {
        setState(() {
          _audit = audit;
          _outcomes = outcomes;
        });
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  bool get _missed =>
      widget.visit.status == 'missed' || widget.visit.status == 'investigated';

  @override
  Widget build(BuildContext context) {
    final visit = widget.visit;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Visit timeline', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        RefreshIndicator(
          onRefresh: _load,
          child: ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          visit.caregiverDisplayName,
                          style: const TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w500,
                            color: inkDefault,
                          ),
                        ),
                        const SizedBox(height: 2),
                        Text(
                          formatVisitWindow(context, visit),
                          style: const TextStyle(
                            fontSize: 13,
                            color: inkTertiary,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(width: 12),
                  StatusPill(visit.status),
                ],
              ),
              const SizedBox(height: 16),
              ..._buildBody(),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _buildBody() {
    if (_error != null) {
      return [
        SectionCard(
          padding: const EdgeInsets.all(20),
          child: Column(
            children: [
              Text(_error!, style: const TextStyle(color: inkSecondary)),
              TextButton(onPressed: _load, child: const Text('Retry')),
            ],
          ),
        ),
      ];
    }
    final (audit, outcomes) = (_audit, _outcomes);
    if (audit == null || outcomes == null) {
      return const [
        Padding(
          padding: EdgeInsets.all(32),
          child: Center(child: CircularProgressIndicator()),
        ),
      ];
    }
    final steps = [
      ('Checked in', audit.checkinAt),
      ('Caregiver photo verified', audit.caregiverVerifiedAt),
      ('Dependant photo verified', audit.dependantVerifiedAt),
      ('Checked out', audit.checkoutAt),
    ];
    return [
      SectionCard(
        padding: const EdgeInsets.all(20),
        child: Column(
          children: [
            for (final (i, (label, at)) in steps.indexed)
              _TimelineStep(
                label: label,
                timestamp: at == null ? null : _dateTime(context, at),
                failed: at == null && _missed,
                isLast: i == steps.length - 1,
                nextDone: i < steps.length - 1 && steps[i + 1].$2 != null,
              ),
          ],
        ),
      ),
      // Nothing is recorded until the caregiver starts ticking activities off, so a missed or
      // just-started visit shows no section rather than an empty one.
      if (outcomes.isNotEmpty) ...[
        const SizedBox(height: 8),
        const SectionTitle('Care activities'),
        SectionCard(
          child: Column(
            children: [
              for (final (i, outcome) in outcomes.indexed) ...[
                if (i > 0) const Divider(height: 1, color: borderColor),
                _OutcomeRow(outcome),
              ],
            ],
          ),
        ),
      ],
    ];
  }

  static String _dateTime(BuildContext context, DateTime t) =>
      '${MaterialLocalizations.of(context).formatShortMonthDay(t)}, ${formatTime(context, t)}';
}

class _OutcomeRow extends StatelessWidget {
  final TaskOutcome outcome;
  const _OutcomeRow(this.outcome);

  @override
  Widget build(BuildContext context) {
    final (IconData icon, Color color, String? detail) = switch (outcome) {
      TaskOutcome(status: 'completed') => (
        Icons.check_circle,
        successGreen,
        null,
      ),
      TaskOutcome(status: 'not_applicable') => (
        Icons.remove_circle_outline,
        inkTertiary,
        'Not applicable',
      ),
      TaskOutcome(:final reason) => (
        Icons.cancel,
        dangerRed,
        describeSkipReason(reason),
      ),
    };
    final subtitle = [?detail, ?outcome.notes].join(' - ');
    return ListTile(
      leading: Icon(icon, color: color),
      title: Text(outcome.title, style: const TextStyle(fontSize: 14)),
      subtitle: subtitle.isEmpty
          ? null
          : Text(
              subtitle,
              style: const TextStyle(fontSize: 12, color: inkTertiary),
            ),
    );
  }
}

class _TimelineStep extends StatelessWidget {
  final String label;
  final String? timestamp;
  final bool failed;
  final bool isLast;
  final bool nextDone;

  const _TimelineStep({
    required this.label,
    required this.timestamp,
    required this.failed,
    required this.isLast,
    required this.nextDone,
  });

  @override
  Widget build(BuildContext context) {
    final done = timestamp != null;
    final color = done ? successGreen : (failed ? dangerRed : borderColor);
    return IntrinsicHeight(
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SizedBox(
            width: 24,
            child: Column(
              children: [
                Container(
                  width: 24,
                  height: 24,
                  decoration: BoxDecoration(
                    color: done || failed ? color : Colors.white,
                    shape: BoxShape.circle,
                    border: Border.all(color: color, width: 2),
                  ),
                  child: done || failed
                      ? Icon(
                          done ? Icons.check : Icons.close,
                          size: 14,
                          color: Colors.white,
                        )
                      : null,
                ),
                if (!isLast)
                  Expanded(
                    child: Container(
                      width: 2,
                      margin: const EdgeInsets.symmetric(vertical: 2),
                      color: done && nextDone ? successGreen : borderColor,
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Padding(
              padding: EdgeInsets.only(top: 2, bottom: isLast ? 0 : 24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    label,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w500,
                      color: failed ? dangerRed : inkDefault,
                    ),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    timestamp ?? (failed ? 'Missed' : 'Not yet'),
                    style: const TextStyle(fontSize: 12, color: inkTertiary),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
