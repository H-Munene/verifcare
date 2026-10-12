import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';

/// A finished (completed or missed) visit's four milestones - the same steps, from the same
/// GET .../verification data, as the admin web app's VisitDetailPage. On a missed visit every
/// step that never happened is drawn with an X.
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
  String? _error;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() => _error = null);
    try {
      final audit = await widget.visitSchedulesApi.getVerification(
        widget.visit.id,
      );
      if (mounted) setState(() => _audit = audit);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.problem.detail ?? e.problem.title);
    }
  }

  @override
  Widget build(BuildContext context) {
    final visit = widget.visit;
    final missed = visit.status == 'missed';
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Visit timeline', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        visit.dependantDisplayName,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w500,
                          color: inkDefault,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${MaterialLocalizations.of(context).formatMediumDate(visit.scheduledStart)}, '
                        '${_time(context, visit.scheduledStart)} - ${_time(context, visit.scheduledEnd)}',
                        style: const TextStyle(
                          fontSize: 13,
                          color: inkTertiary,
                        ),
                      ),
                    ],
                  ),
                ),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: missed ? dangerTint : successTint,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    missed ? 'Missed' : 'Checked out',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: missed ? dangerRed : successGreen,
                    ),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: borderColor),
              ),
              child: _buildBody(missed),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildBody(bool missed) {
    if (_error != null) {
      return Column(
        children: [
          Text(_error!, style: const TextStyle(color: inkSecondary)),
          TextButton(onPressed: _load, child: const Text('Retry')),
        ],
      );
    }
    final audit = _audit;
    if (audit == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final steps = [
      ('Checked in', audit.checkinAt),
      ('Caregiver photo verified', audit.caregiverVerifiedAt),
      ('Dependant photo verified', audit.dependantVerifiedAt),
      ('Checked out', audit.checkoutAt),
    ];
    return Column(
      children: [
        for (final (i, (label, at)) in steps.indexed)
          _TimelineStep(
            label: label,
            timestamp: at == null ? null : _dateTime(context, at),
            failed: at == null && missed,
            isLast: i == steps.length - 1,
            nextDone: i < steps.length - 1 && steps[i + 1].$2 != null,
          ),
      ],
    );
  }

  static String _time(BuildContext context, DateTime t) =>
      TimeOfDay.fromDateTime(t).format(context);

  static String _dateTime(BuildContext context, DateTime t) =>
      '${MaterialLocalizations.of(context).formatShortMonthDay(t)}, ${_time(context, t)}';
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
