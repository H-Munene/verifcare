import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/visit_schedules_api.dart';
import 'package:family_member/screens/check_in_code_screen.dart';
import 'package:family_member/widgets/visit_recording_card.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:qr_flutter/qr_flutter.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

final _visit = VisitSchedule(
  id: 'v1',
  dependantId: 'd1',
  caregiverDisplayName: 'Grace Wanjiru',
  dependantDisplayName: 'Wanjiku Kamau',
  scheduledStart: DateTime(2026, 11, 9, 9),
  scheduledEnd: DateTime(2026, 11, 9, 10),
  status: 'scheduled',
);

Future<void> _pumpCode(WidgetTester tester) async {
  await tester.pumpWidget(
    MaterialApp(
      home: CheckInCodeScreen(
        visit: _visit,
        visitSchedulesApi: VisitSchedulesApi(ApiClient(() async => null)),
      ),
    ),
  );
  await tester.pump();
  await tester.pump();
}

Future<void> _pumpCard(WidgetTester tester, VerificationAudit audit) =>
    tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: VisitRecordingCard(
            visitScheduleId: 'v1',
            audit: audit,
            visitSchedulesApi: VisitSchedulesApi(ApiClient(() async => null)),
          ),
        ),
      ),
    );

void main() {
  group('CheckInCodeScreen', () {
    testWidgets(
      'shows the QR code with its 6 digits underneath, sending no location',
      (tester) async {
        Map<String, dynamic>? sent;
        final backend = MockClient((request) async {
          sent = jsonDecode(request.body) as Map<String, dynamic>;
          return _json({
            'token': 'opaque-token',
            'code': '482913',
            'expiresAt': '2026-11-09T09:01:00Z',
            'caregiverDisplayName': 'Grace Wanjiru',
          }, 201);
        });
        await http.runWithClient(() async {
          await _pumpCode(tester);

          expect(find.byType(QrImageView), findsOneWidget);
          expect(find.text('482 913'), findsOneWidget);
          expect(find.text('Is Grace Wanjiru with you?'), findsOneWidget);
          expect(find.textContaining('refreshes'), findsNothing);
          expect(sent, isEmpty);
          await tester.pumpWidget(const SizedBox());
        }, () => backend);
      },
    );

    testWidgets('explains a refusal and offers to try again', (tester) async {
      final backend = MockClient(
        (_) async => _json({
          'title': 'Forbidden',
          'status': 403,
          'detail':
              'The family member who showed the check-in code confirms this check-out.',
        }, 403),
      );
      await http.runWithClient(() async {
        await _pumpCode(tester);

        expect(find.byType(QrImageView), findsNothing);
        expect(
          find.textContaining('who showed the check-in code'),
          findsOneWidget,
        );
        expect(find.text('Try again'), findsOneWidget);
        await tester.pumpWidget(const SizedBox());
      }, () => backend);
    });

    testWidgets('reports the visit as started once the code has been used', (
      tester,
    ) async {
      final backend = MockClient(
        (_) async => _json({
          'title': 'Conflict',
          'status': 409,
          'detail': 'Not waiting.',
        }, 409),
      );
      await http.runWithClient(() async {
        await _pumpCode(tester);

        expect(find.text('Visit started with Grace Wanjiru'), findsOneWidget);
      }, () => backend);
    });
  });

  group('VisitRecordingCard', () {
    testWidgets('offers the recording without fetching it until asked', (
      tester,
    ) async {
      var requests = 0;
      final backend = MockClient((_) async {
        requests++;
        return _json({});
      });
      await http.runWithClient(() async {
        await _pumpCard(
          tester,
          VerificationAudit(
            audioRecordedAt: DateTime.now(),
            audioDurationSeconds: 30,
          ),
        );

        expect(find.text('Listen to the visit'), findsOneWidget);
        expect(find.text('30 seconds'), findsOneWidget);
        expect(requests, 0);
      }, () => backend);
    });

    testWidgets('says when a recording has passed the 90 days', (tester) async {
      await _pumpCard(
        tester,
        VerificationAudit(
          audioRecordedAt: DateTime.now().subtract(const Duration(days: 91)),
          audioDurationSeconds: 30,
        ),
      );

      expect(find.textContaining('Recording expired'), findsOneWidget);
      expect(find.text('Listen to the visit'), findsNothing);
    });

    testWidgets('gives the reason when there is no recording', (tester) async {
      await _pumpCard(
        tester,
        VerificationAudit(audioSkipReason: 'dependant_declined'),
      );

      expect(
        find.textContaining('preferred not to be recorded'),
        findsOneWidget,
      );
    });

    testWidgets('adds the note for an "other" reason', (tester) async {
      await _pumpCard(
        tester,
        VerificationAudit(
          audioSkipReason: 'other',
          audioSkipNote: 'Fire alarm',
        ),
      );

      expect(find.textContaining('Fire alarm'), findsOneWidget);
    });
  });
}
