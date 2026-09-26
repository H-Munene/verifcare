import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/terms_api.dart';
import 'package:family_member/screens/consent_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

Map<String, dynamic> _terms({String version = '1', String? acceptedAt}) => {
  'document': 'family_member',
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

/// A fake backend: GET returns [current()], POST records the version sent and answers [onAccept].
class _Backend {
  Map<String, dynamic> Function() current = _terms;
  http.Response? Function()? onAccept;
  final accepted = <String>[];
  int gets = 0;

  MockClient get client => MockClient((request) async {
    final path = request.url.path.replaceFirst('/prod', '');
    if (request.method == 'GET' && path == '/terms/current') {
      gets++;
      return _json(current());
    }
    if (request.method == 'POST' && path == '/terms/current/accept') {
      final version = (jsonDecode(request.body) as Map)['version'] as String;
      final response = onAccept?.call();
      if (response != null) return response;
      accepted.add(version);
      return _json({
        'document': 'family_member',
        'version': version,
        'acceptedAt': '2026-09-27T08:00:00Z',
      });
    }
    throw StateError('Unexpected request: ${request.method} ${request.url}');
  });
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

      await tester.tap(find.widgetWithText(ElevatedButton, 'Accept'));
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
      await tester.tap(find.widgetWithText(ElevatedButton, 'Accept'));
      await tester.pumpAndSettle();
      expect(find.textContaining('have just been updated'), findsOneWidget);
      expect(find.textContaining('Version 2'), findsOneWidget);
      expect(find.text('HOME'), findsNothing);
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
