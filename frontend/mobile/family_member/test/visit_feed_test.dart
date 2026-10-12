import 'package:family_member/api/visit_schedules_api.dart';
import 'package:family_member/feed/visit_feed.dart';
import 'package:flutter_test/flutter_test.dart';

final _now = DateTime(2026, 10, 12, 11);

VisitSchedule _visit(String id, String status, DateTime start, {int hours = 2}) =>
    VisitSchedule(
      id: id,
      dependantId: 'd1',
      caregiverDisplayName: 'Grace Wanjiru',
      dependantDisplayName: 'Wanjiku Kamau',
      scheduledStart: start,
      scheduledEnd: start.add(Duration(hours: hours)),
      status: status,
    );

TaskOutcome _task(String status) =>
    TaskOutcome(title: 't', required: true, status: status);

void main() {
  group('nowStateFor', () {
    test('a visit in progress wins over everything else', () {
      final state = nowStateFor([
        _visit('next', 'scheduled', _now.add(const Duration(hours: 3))),
        _visit('now', 'in_progress', _now.subtract(const Duration(hours: 1))),
      ], _now);
      expect(state, isA<NowInProgress>());
      expect((state as NowInProgress).visit.id, 'now');
    });

    test('a scheduled visit whose window has started is awaiting check-in', () {
      final state = nowStateFor([
        _visit('late', 'scheduled', _now.subtract(const Duration(minutes: 20))),
        _visit('later', 'scheduled', _now.add(const Duration(days: 1))),
      ], _now);
      expect(state, isA<NowAwaitingCheckin>());
      expect((state as NowAwaitingCheckin).visit.id, 'late');
    });

    test('otherwise the earliest future visit is next', () {
      final state = nowStateFor([
        _visit('b', 'scheduled', _now.add(const Duration(days: 2))),
        _visit('a', 'scheduled', _now.add(const Duration(days: 1))),
        _visit('done', 'completed', _now.subtract(const Duration(days: 1))),
      ], _now);
      expect((state as NowNext).visit.id, 'a');
    });

    test('a scheduled visit whose window already ended is not next', () {
      // The sweep hasn't marked it missed yet; it isn't "upcoming" either.
      final state = nowStateFor([
        _visit('stale', 'scheduled', _now.subtract(const Duration(hours: 5))),
      ], _now);
      expect(state, isA<NowNothing>());
    });
  });

  test('feedVisits keeps the last 7 days of visits that can have events', () {
    final visits = feedVisits([
      _visit('done', 'completed', _now.subtract(const Duration(days: 1))),
      _visit('old', 'completed', _now.subtract(const Duration(days: 8))),
      _visit('off', 'cancelled', _now.subtract(const Duration(days: 1))),
      _visit('future', 'scheduled', _now.add(const Duration(hours: 1))),
      _visit('missed', 'missed', _now.subtract(const Duration(days: 2))),
    ], _now);
    expect(visits.map((v) => v.id), ['done', 'missed']);
  });

  test('buildFeed turns recorded moments into events, newest first', () {
    final done = _visit('done', 'completed', _now.subtract(const Duration(days: 1)));
    final missed = _visit('missed', 'investigated', _now.subtract(const Duration(days: 2)));
    final arrived = done.scheduledStart.add(const Duration(minutes: 2));
    final feed = buildFeed([
      VisitWithDetails(
        done,
        audit: VerificationAudit(
          caregiverVerifiedAt: arrived,
          checkinAt: arrived.add(const Duration(minutes: 3)),
          checkoutAt: arrived.add(const Duration(hours: 2)),
        ),
        outcomes: [
          _task('completed'),
          _task('completed'),
          _task('not_completed'),
          _task('not_applicable'),
        ],
      ),
      // Its details failed to load: only the status-based event remains.
      VisitWithDetails(missed),
    ], _now);

    expect(feed.map((e) => e.kind), [
      FeedKind.finished,
      FeedKind.started,
      FeedKind.arrived,
      FeedKind.missed,
    ]);
    // Not-applicable tasks don't count towards the total.
    expect(feed.first.tasks, (done: 2, total: 3));
    expect(feed.last.at, missed.scheduledEnd);
  });

  test('buildFeed leaves out events stamped in the future', () {
    final visit = _visit('now', 'in_progress', _now.subtract(const Duration(hours: 1)));
    final feed = buildFeed([
      VisitWithDetails(
        visit,
        audit: VerificationAudit(checkinAt: _now.add(const Duration(minutes: 5))),
      ),
    ], _now);
    expect(feed, isEmpty);
  });

  test('firstName', () {
    expect(firstName('  Grace   Wanjiru '), 'Grace');
  });
}
