// The Today tab's data, worked out from a dependant's visits (2026-10-12, family app redesign):
// what is happening now or next, and a feed of what happened recently. Only things the backend
// actually recorded become feed events - a caregiver's verified arrival, check-in, check-out, and
// a visit the missed-visit sweep marked missed - so the feed never claims something it can't show.

import '../api/visit_schedules_api.dart';

/// How far back the feed reaches.
const feedWindow = Duration(days: 7);

/// The Today tab's top card.
sealed class NowState {
  const NowState();
}

/// A caregiver is with the dependant: checked in and not yet checked out.
class NowInProgress extends NowState {
  final VisitSchedule visit;
  const NowInProgress(this.visit);
}

/// The visit's window has started but the caregiver hasn't checked in yet. (The sweep marks it
/// missed once the window ends.)
class NowAwaitingCheckin extends NowState {
  final VisitSchedule visit;
  const NowAwaitingCheckin(this.visit);
}

/// Nothing is happening now; this is the next scheduled visit.
class NowNext extends NowState {
  final VisitSchedule visit;
  const NowNext(this.visit);
}

/// Nothing now and nothing scheduled.
class NowNothing extends NowState {
  const NowNothing();
}

NowState nowStateFor(List<VisitSchedule> visits, DateTime now) {
  final inProgress =
      visits.where((v) => v.status == 'in_progress').toList()
        ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
  if (inProgress.isNotEmpty) return NowInProgress(inProgress.first);

  final scheduled =
      visits
          .where((v) => v.status == 'scheduled' && v.scheduledEnd.isAfter(now))
          .toList()
        ..sort((a, b) => a.scheduledStart.compareTo(b.scheduledStart));
  if (scheduled.isEmpty) return const NowNothing();
  final first = scheduled.first;
  return first.scheduledStart.isAfter(now)
      ? NowNext(first)
      : NowAwaitingCheckin(first);
}

/// The visits whose details the feed needs: started within [feedWindow] and past the point where
/// something can have happened (cancelled and still-scheduled visits have no events).
List<VisitSchedule> feedVisits(List<VisitSchedule> visits, DateTime now) {
  final since = now.subtract(feedWindow);
  return visits
      .where(
        (v) =>
            !v.scheduledStart.isBefore(since) &&
            !v.scheduledStart.isAfter(now) &&
            const {
              'in_progress',
              'completed',
              'missed',
              'investigated',
            }.contains(v.status),
      )
      .toList();
}

/// A visit plus whatever of its details loaded. Either can be null if that request failed; the
/// visit then contributes only the events its status alone proves.
class VisitWithDetails {
  final VisitSchedule visit;
  final VerificationAudit? audit;
  final List<TaskOutcome>? outcomes;

  const VisitWithDetails(this.visit, {this.audit, this.outcomes});
}

enum FeedKind { arrived, started, finished, missed }

class FeedEvent {
  final DateTime at;
  final FeedKind kind;
  final VisitSchedule visit;

  /// For [FeedKind.finished]: care tasks done, out of those that applied. Null when no outcomes
  /// were recorded or they couldn't be loaded.
  final ({int done, int total})? tasks;

  /// For [FeedKind.started]: who showed the code, or that a supervisor started it instead.
  final String? confirmedBy;
  final bool startedBySupervisor;

  const FeedEvent(
    this.at,
    this.kind,
    this.visit, {
    this.tasks,
    this.confirmedBy,
    this.startedBySupervisor = false,
  });
}

/// Newest first. Events later than [now] (clock skew) are left out.
List<FeedEvent> buildFeed(Iterable<VisitWithDetails> visits, DateTime now) {
  final events = <FeedEvent>[];
  for (final item in visits) {
    final visit = item.visit;
    final audit = item.audit;
    if (audit?.arrivedAt case final at?) {
      events.add(FeedEvent(at, FeedKind.arrived, visit));
    }
    if (audit?.checkinAt case final at?) {
      events.add(
        FeedEvent(
          at,
          FeedKind.started,
          visit,
          confirmedBy: audit?.qrFamilyMemberName,
          startedBySupervisor: audit?.checkinMethod == 'supervisor_override',
        ),
      );
    }
    if (audit?.checkoutAt case final at?) {
      events.add(
        FeedEvent(at, FeedKind.finished, visit, tasks: _taskCount(item.outcomes)),
      );
    }
    if (visit.status == 'missed' || visit.status == 'investigated') {
      events.add(FeedEvent(visit.scheduledEnd, FeedKind.missed, visit));
    }
  }
  return events.where((e) => !e.at.isAfter(now)).toList()
    ..sort((a, b) => b.at.compareTo(a.at));
}

({int done, int total})? _taskCount(List<TaskOutcome>? outcomes) {
  final applicable = outcomes?.where((o) => o.status != 'not_applicable').toList();
  if (applicable == null || applicable.isEmpty) return null;
  return (
    done: applicable.where((o) => o.status == 'completed').length,
    total: applicable.length,
  );
}

/// "Grace" from "Grace Wanjiru".
String firstName(String fullName) => fullName.trim().split(RegExp(r'\s+')).first;
