import 'dart:convert';

import 'package:caregiver/api/api_client.dart';
import 'package:caregiver/api/visit_schedules_api.dart';
import 'package:caregiver/widgets/recovery_offer_banner.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

final _offerJson = {
  'id': 'offer-1',
  'proposedStart': '2026-11-10T07:00:00Z',
  'proposedEnd': '2026-11-10T08:00:00Z',
  'distanceMeters': 2400,
  'expiresAt': '2026-11-10T06:35:00Z',
  'ward': 'KILELESHWA',
};

Widget _sheet(RecoveryOffer offer, void Function(bool) onDone) => MaterialApp(
  home: Scaffold(
    body: Builder(
      builder: (context) => TextButton(
        child: const Text('open'),
        onPressed: () => showModalBottomSheet<void>(
          context: context,
          builder: (_) => RecoveryOfferSheet(
            offer: offer,
            api: VisitSchedulesApi(ApiClient(() async => null)),
            onDone: onDone,
          ),
        ),
      ),
    ),
  ),
);

void main() {
  test('RecoveryOffer reads the ward and times, and copes without a ward', () {
    final offer = RecoveryOffer.fromJson(_offerJson);
    expect(offer.ward, 'KILELESHWA');
    expect(offer.distanceMeters, 2400);
    expect(RecoveryOffer.fromJson({..._offerJson, 'ward': null}).ward, isNull);
  });

  test('VisitSchedule reads its route position', () {
    final json = {
      'id': 'v',
      'caregiverId': 'c',
      'dependantId': 'd',
      'caregiverDisplayName': 'A',
      'dependantDisplayName': 'B',
      'scheduledStart': '2026-11-10T07:00:00Z',
      'scheduledEnd': '2026-11-10T08:00:00Z',
      'status': 'scheduled',
      'createdBy': 's',
      'createdAt': '2026-11-01T07:00:00Z',
      'updatedAt': '2026-11-01T07:00:00Z',
    };
    expect(VisitSchedule.fromJson(json).routeSequence, isNull);
    expect(
      VisitSchedule.fromJson({...json, 'routeSequence': 3}).routeSequence,
      3,
    );
  });

  testWidgets('accepting tells the server and closes the sheet', (
    tester,
  ) async {
    final requests = <String>[];
    final backend = MockClient((request) async {
      requests.add(request.url.path);
      return _json({'visitScheduleId': 'v2'});
    });
    bool? outcome;
    await http.runWithClient(() async {
      await tester.pumpWidget(
        _sheet(RecoveryOffer.fromJson(_offerJson), (a) => outcome = a),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      expect(find.text('KILELESHWA'), findsOneWidget);
      expect(find.text('2.4 km away'), findsOneWidget);

      await tester.tap(find.widgetWithText(ElevatedButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(requests.single, endsWith('/recovery-offers/offer-1/accept'));
      expect(outcome, isTrue);
      expect(find.text('Cover a visit'), findsNothing);
    }, () => backend);
  });

  testWidgets('declining passes on the offer', (tester) async {
    final requests = <String>[];
    final backend = MockClient((request) async {
      requests.add(request.url.path);
      return http.Response('', 204);
    });
    bool? outcome;
    await http.runWithClient(() async {
      await tester.pumpWidget(
        _sheet(RecoveryOffer.fromJson(_offerJson), (a) => outcome = a),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
      await tester.pumpAndSettle();

      expect(requests.single, endsWith('/recovery-offers/offer-1/decline'));
      expect(outcome, isFalse);
    }, () => backend);
  });

  testWidgets('says so if the visit no longer needs cover', (tester) async {
    final backend = MockClient(
      (_) async => _json({
        'title': 'Conflict',
        'status': 409,
        'detail': 'This visit no longer needs cover.',
      }, 409),
    );
    await http.runWithClient(() async {
      await tester.pumpWidget(
        _sheet(RecoveryOffer.fromJson(_offerJson), (_) {}),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();

      await tester.tap(find.widgetWithText(ElevatedButton, 'Accept'));
      await tester.pumpAndSettle();

      expect(find.text('This visit no longer needs cover.'), findsOneWidget);
    }, () => backend);
  });
}
