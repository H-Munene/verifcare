import 'package:flutter/material.dart';

import '../api/visit_schedules_api.dart';
import '../app_ui.dart';

const _neutralTint = Color(0xFFF0F0F0);

typedef StatusStyle = ({String label, Color ink, Color tint});

/// How each visit status reads to a family member. "Completed" rather than the caregiver app's
/// "Checked out", since the family member didn't check anything out themselves.
StatusStyle visitStatusStyle(VisitStatus status) => switch (status) {
  'scheduled' => (label: 'Scheduled', ink: primaryGreen, tint: primaryTint),
  'in_progress' => (
    label: 'In progress',
    ink: primaryGreen,
    tint: primaryTint,
  ),
  'completed' => (label: 'Completed', ink: successGreen, tint: successTint),
  'missed' => (label: 'Missed', ink: dangerRed, tint: dangerTint),
  // A missed visit a supervisor is looking into.
  'investigated' => (label: 'Under review', ink: dangerRed, tint: dangerTint),
  'cancelled' => (label: 'Cancelled', ink: inkSecondary, tint: _neutralTint),
  _ => (
    label: status.replaceAll('_', ' '),
    ink: inkSecondary,
    tint: _neutralTint,
  ),
};

class StatusPill extends StatelessWidget {
  final VisitStatus status;
  const StatusPill(this.status, {super.key});

  @override
  Widget build(BuildContext context) {
    final style = visitStatusStyle(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: style.tint,
        borderRadius: BorderRadius.zero,
      ),
      child: Text(
        style.label,
        style: TextStyle(
          fontSize: 12,
          fontWeight: FontWeight.w500,
          color: style.ink,
        ),
      ),
    );
  }
}

String formatTime(BuildContext context, DateTime t) =>
    TimeOfDay.fromDateTime(t).format(context);

/// "Thu, Sep 24, 9:00 AM - 10:00 AM"
String formatVisitWindow(BuildContext context, VisitSchedule visit) {
  final date = MaterialLocalizations.of(
    context,
  ).formatMediumDate(visit.scheduledStart);
  return '$date, ${formatTime(context, visit.scheduledStart)} - '
      '${formatTime(context, visit.scheduledEnd)}';
}

/// White rounded card with a hairline border - the container every section of the visit screens
/// sits in.
class SectionCard extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;

  const SectionCard({
    super.key,
    required this.child,
    this.padding = EdgeInsets.zero,
  });

  @override
  Widget build(BuildContext context) => Container(
    padding: padding,
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.zero,
      border: Border.all(color: borderColor),
    ),
    child: child,
  );
}

class SectionTitle extends StatelessWidget {
  final String text;
  const SectionTitle(this.text, {super.key});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 4, top: 8, bottom: 8),
    child: Text(
      text,
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w500,
        color: inkSecondary,
      ),
    ),
  );
}
