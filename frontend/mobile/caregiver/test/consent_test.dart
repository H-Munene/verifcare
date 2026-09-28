import 'dart:convert';

import 'package:caregiver/api/api_client.dart';
import 'package:caregiver/api/terms_api.dart';
import 'package:caregiver/screens/consent_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _terms({String version = '1', String? acceptedAt}) => {
  'document': 'caregiver',
  'version': version,
  'title': 'Terms of Use and Privacy Notice',
  'effectiveDate': '2026-09-26',
  'sections': [
    {
      'heading': 'What we collect',
      'paragraphs': ['Your account details.'],
    },
  ],
  'acceptedAt': acceptedAt,
};

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {
    'content-type': status >= 400
        ? 'application/problem+json'
        : 'application/json',
  },
);

/// A fake backend: GET returns [current()], POST records the version sent (and the body, for the
/// consents) and answers [onAccept].
class _Backend {
  Map<String, dynamic> Function() current = _terms;
  http.Response? Function()? onAccept;
  final accepted = <String>[];
  final acceptBodies = <Map<String, dynamic>>[];
  int gets = 0;

  MockClient get client => MockClient((request) async {
    final path = request.url.path.replaceFirst('/prod', '');
    if (request.method == 'GET' && path == '/terms/current') {
      gets++;
      return _json(current());
    }
    if (request.method == 'POST' && path == '/terms/current/accept') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      final version = body['version'] as String;
      final response = onAccept?.call();
      if (response != null) return response;
      accepted.add(version);
      acceptBodies.add(body);
      return _json({
        'document': 'caregiver',
        'version': version,
        'acceptedAt': '2026-09-27T08:00:00Z',
      });
    }
    throw StateError('Unexpected request: ${request.method} ${request.url}');
  });
}

Finder get _acceptButton => find.widgetWithText(ElevatedButton, 'Accept');

bool _acceptEnabled(WidgetTester tester) =>
    tester.widget<ElevatedButton>(_acceptButton).onPressed != null;

/// Ticks both consent checkboxes, which Accept needs.
Future<void> _consentToBoth(WidgetTester tester) async {
  await tester.tap(find.byType(CheckboxListTile).at(0));
  await tester.tap(find.byType(CheckboxListTile).at(1));
  await tester.pumpAndSettle();
}

Future<TermsApi> _pumpGate(
  WidgetTester tester,
  _Backend backend, {
  TermsApi? api,
}) async {
  final termsApi = api ?? TermsApi(ApiClient(() async => null));
  await tester.pumpWidget(
    MaterialApp(
      home: ConsentGate(
        termsApi: termsApi,
        sub: 'sub-1',
        child: const Text('HOME'),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return termsApi;
}

void main() {
  testWidgets('the app stays behind the terms until they are accepted', (
    tester,
  ) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      final api = await _pumpGate(tester, backend);
      expect(find.text('Terms of Use and Privacy Notice'), findsOneWidget);
      expect(find.text('HOME'), findsNothing);

      // Back can't dismiss it.
      final popped = await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(popped, isTrue);
      expect(find.text('Terms of Use and Privacy Notice'), findsOneWidget);

      await _consentToBoth(tester);
      await tester.tap(_acceptButton);
      await tester.pumpAndSettle();
      expect(backend.accepted, ['1']);
      expect(find.text('HOME'), findsOneWidget);

      // Remembered for this run: another screen behind the gate opens without asking or loading.
      final getsBefore = backend.gets;
      await _pumpGate(tester, backend, api: api);
      expect(find.text('HOME'), findsOneWidget);
      expect(backend.gets, getsBefore);
    }, () => backend.client);
  });

  testWidgets('someone who already accepted goes straight in', (tester) async {
    final backend = _Backend()
      ..current = (() => _terms(acceptedAt: '2026-09-20T08:00:00Z'));
    await http.runWithClient(() async {
      await _pumpGate(tester, backend);
      expect(find.text('HOME'), findsOneWidget);
    }, () => backend.client);
  });

  testWidgets(
    'declining on Android closes the app without recording anything',
    (tester) async {
      final calls = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          calls.add(call.method);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      final backend = _Backend();
      await http.runWithClient(() async {
        await _pumpGate(tester, backend);
        await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
        await tester.pumpAndSettle();
        expect(calls, contains('SystemNavigator.pop'));
        expect(backend.accepted, isEmpty);
        expect(find.text('HOME'), findsNothing);
      }, () => backend.client);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.android),
  );

  testWidgets(
    "declining on iOS, which can't close itself, explains and offers the terms again",
    (tester) async {
      final backend = _Backend();
      await http.runWithClient(() async {
        await _pumpGate(tester, backend);
        await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
        await tester.pumpAndSettle();
        expect(
          find.textContaining("can't be used without accepting"),
          findsOneWidget,
        );
        await tester.tap(find.text('Read the terms again'));
        await tester.pumpAndSettle();
        expect(find.widgetWithText(ElevatedButton, 'Accept'), findsOneWidget);
      }, () => backend.client);
    },
    variant: TargetPlatformVariant.only(TargetPlatform.iOS),
  );

  testWidgets('terms updated while on screen are shown again to accept', (
    tester,
  ) async {
    final backend = _Backend();
    var version = '1';
    backend.current = () => _terms(version: version);
    backend.onAccept = () {
      if (version == '1') {
        version = '2';
        return _json({
          'type': 'about:blank',
          'title': 'Conflict',
          'status': 409,
        }, 409);
      }
      return null;
    };
    await http.runWithClient(() async {
      await _pumpGate(tester, backend);
      await _consentToBoth(tester);
      await tester.tap(_acceptButton);
      await tester.pumpAndSettle();
      expect(find.textContaining('have just been updated'), findsOneWidget);
      expect(find.textContaining('Version 2'), findsOneWidget);
      expect(find.text('HOME'), findsNothing);
      // Consent given against the old wording doesn't carry over to the new version.
      expect(_acceptEnabled(tester), isFalse);
    }, () => backend.client);
  });

  testWidgets('Accept needs both consent boxes ticked, and sends both', (
    tester,
  ) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      await _pumpGate(tester, backend);
      final boxes = find.byType(CheckboxListTile);
      expect(boxes, findsNWidgets(2));
      expect(_acceptEnabled(tester), isFalse);

      // One box alone isn't enough, whichever it is.
      await tester.tap(boxes.at(0));
      await tester.pumpAndSettle();
      expect(_acceptEnabled(tester), isFalse);
      await tester.tap(boxes.at(0));
      await tester.tap(boxes.at(1));
      await tester.pumpAndSettle();
      expect(_acceptEnabled(tester), isFalse);

      // Decline never depends on the boxes.
      expect(
        tester
            .widget<OutlinedButton>(
              find.widgetWithText(OutlinedButton, 'Decline'),
            )
            .onPressed,
        isNotNull,
      );

      await tester.tap(boxes.at(0));
      await tester.pumpAndSettle();
      expect(_acceptEnabled(tester), isTrue);
      await tester.tap(_acceptButton);
      await tester.pumpAndSettle();
      expect(backend.acceptBodies.single, {
        'version': '1',
        'biometricConsent': true,
        'audioConsent': true,
      });
      expect(find.text('HOME'), findsOneWidget);
    }, () => backend.client);
  });

  testWidgets(
    'if the terms cannot be loaded, the app stays locked with a retry',
    (tester) async {
      var fail = true;
      final client = MockClient((request) async {
        if (fail) throw http.ClientException('offline');
        return _json(_terms(acceptedAt: '2026-09-20T08:00:00Z'));
      });
      await http.runWithClient(() async {
        await _pumpGate(tester, _Backend());
        expect(
          find.textContaining('Could not reach the server'),
          findsOneWidget,
        );
        expect(find.text('HOME'), findsNothing);
        fail = false;
        await tester.tap(find.text('Try again'));
        await tester.pumpAndSettle();
        expect(find.text('HOME'), findsOneWidget);
      }, () => client);
    },
  );
}
