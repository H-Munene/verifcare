import 'dart:convert';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/family_link_requests_api.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/api/visit_schedules_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/screens/home_screen.dart';
import 'package:family_member/screens/join_family_screen.dart';
import 'package:family_member/widgets/family_link_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

// Family linking from both sides: the bell and its sheet (a primary contact answering requests,
// a requester seeing the outcome), asking to join a family, and the primary contact linking an
// existing account by email. Real screens and ApiClient against a canned backend that records
// every write, so each test checks the exact request the UI sends.

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json'},
);

http.Response _problem(int status, String title, String detail) =>
    http.Response(
      jsonEncode({'title': title, 'status': status, 'detail': detail}),
      status,
      headers: {'content-type': 'application/problem+json'},
    );

Map<String, dynamic> _dependant(String id, String name) => {
  'id': id,
  'fullName': name,
  'dob': '1950-06-15',
  'gender': 'female',
  'homeAddressText': null,
  'primaryConditionSummary': null,
  'county': 'NAIROBI',
  'constituency': 'DAGORETTI NORTH',
  'ward': 'KILELESHWA',
  'geofenceLat': -1.2833,
  'geofenceLng': 36.7833,
  'geofenceRadiusMeters': 20,
  'status': 'active',
};

final _incoming = {
  'id': 'r1',
  'requester': {
    'fullName': 'Brian Kamau',
    'email': 'brian@example.com',
    'phoneNumber': '+254700000002',
  },
  'relationship': 'Grandson',
  'createdAt': '2026-09-20T08:00:00Z',
  'dependants': [
    {'id': 'd1', 'fullName': 'Wanjiku Kamau', 'alreadyLinked': false},
    {'id': 'd2', 'fullName': 'Otieno Kamau', 'alreadyLinked': false},
  ],
};

Map<String, dynamic> _outgoing(String status, {required bool unread}) => {
  'id': 'o1',
  'targetContact': 'mama@example.com',
  'relationship': 'Niece',
  'status': status,
  'createdAt': '2026-09-19T08:00:00Z',
  'decidedAt': status == 'pending' ? null : '2026-09-21T08:00:00Z',
  'unread': unread,
  'linkedDependants': status == 'approved'
      ? [
          {'id': 'd9', 'fullName': 'Mama Njeri'},
        ]
      : [],
};

/// A backend for the home screen. [incoming]/[outgoing] are what GET /family-link-requests
/// returns; [answer] decides approve/reject responses (default 200). Writes land in [writes].
class _Backend {
  List<Map<String, dynamic>> incoming;
  List<Map<String, dynamic>> outgoing;
  final http.Response Function(http.Request)? answer;
  final writes = <(String, Object?)>[];

  _Backend({this.incoming = const [], this.outgoing = const [], this.answer});

  MockClient get client => MockClient((request) async {
    final path = request.url.path.replaceFirst('/prod', '');
    if (request.method == 'POST') {
      writes.add((
        path,
        request.body.isEmpty ? null : jsonDecode(request.body),
      ));
      if (path.endsWith('/outcomes/seen')) {
        outgoing = [
          for (final r in outgoing) {...r, 'unread': false},
        ];
        return http.Response('', 204);
      }
      final response = answer?.call(request) ?? _json({});
      if (response.statusCode == 200) incoming = [];
      return response;
    }
    return switch (path) {
      '/dependants' => _json({
        'items': [_dependant('d1', 'Wanjiku Kamau')],
        'nextCursor': null,
      }),
      '/users/me' => _json({'id': 'u1', 'fullName': 'Achieng Otieno'}),
      '/family-link-requests' => _json({
        'incoming': incoming,
        'outgoing': outgoing,
      }),
      '/visit-schedules' => _json({'items': [], 'nextCursor': null}),
      '/dependants/d1/family-members' => _json([
        {
          'familyMemberUserId': 'u1',
          'fullName': 'Achieng Otieno',
          'relationship': 'Daughter',
          'isPrimaryContact': true,
        },
      ]),
      _ => throw StateError('Unexpected request: ${request.url}'),
    };
  });
}

Future<void> _pumpHome(WidgetTester tester) async {
  tester.view.physicalSize = const Size(360, 780);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  SharedPreferences.setMockInitialValues({});
  final authService = CognitoAuthService();
  final client = ApiClient(authService.getIdToken);
  await tester.pumpWidget(
    MaterialApp(
      home: HomeScreen(
        authService: authService,
        dependantsApi: DependantsApi(client),
        visitSchedulesApi: VisitSchedulesApi(client),
        usersApi: UsersApi(client),
        linkRequestsApi: FamilyLinkRequestsApi(client),
        identity: IdentityClaims(sub: 'sub-1', role: 'family_member'),
        onSignedOut: () {},
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Finder get _bell => find.byTooltip('Family requests');

String? _badge(WidgetTester tester) {
  final badge = tester.widget<Badge>(
    find.descendant(of: _bell, matching: find.byType(Badge)),
  );
  return badge.isLabelVisible ? (badge.label! as Text).data : null;
}

ElevatedButton _approve(WidgetTester tester) => tester.widget<ElevatedButton>(
  find.widgetWithText(ElevatedButton, 'Approve'),
);

void main() {
  group('the bell', () {
    testWidgets('counts incoming requests and unseen outcomes; opening clears '
        'the outcomes', (tester) async {
      final backend = _Backend(
        incoming: [_incoming],
        outgoing: [_outgoing('approved', unread: true)],
      );
      await http.runWithClient(() async {
        await _pumpHome(tester);
        expect(_badge(tester), '2');

        await tester.tap(_bell);
        await tester.pumpAndSettle();
        expect(find.text('Family requests'), findsOneWidget);
        expect(find.text('Asking you to link them'), findsOneWidget);
        expect(find.text('Brian Kamau'), findsOneWidget);
        expect(find.text('Grandson'), findsOneWidget);
        expect(find.text('brian@example.com · +254700000002'), findsOneWidget);
        // The requester's own request, with who it linked them to.
        expect(find.text('To mama@example.com'), findsOneWidget);
        expect(
          find.text("Approved - you're now linked to Mama Njeri"),
          findsOneWidget,
        );
        expect(
          backend.writes.map((w) => w.$1),
          contains('/family-link-requests/outcomes/seen'),
        );

        // Closed: only the request still waiting for an answer is counted.
        await tester.tapAt(const Offset(180, 20));
        await tester.pumpAndSettle();
        expect(_badge(tester), '1');
      }, () => backend.client);
    });

    testWidgets('shows no count, and does not mark anything seen, with '
        'nothing new', (tester) async {
      final backend = _Backend(outgoing: [_outgoing('pending', unread: false)]);
      await http.runWithClient(() async {
        await _pumpHome(tester);
        expect(_badge(tester), isNull);

        await tester.tap(_bell);
        await tester.pumpAndSettle();
        expect(find.text('Waiting for an answer'), findsOneWidget);
        expect(backend.writes, isEmpty);
      }, () => backend.client);
    });

    testWidgets('a declined request reads as declined', (tester) async {
      final backend = _Backend(outgoing: [_outgoing('rejected', unread: true)]);
      await http.runWithClient(() async {
        await _pumpHome(tester);
        await tester.tap(_bell);
        await tester.pumpAndSettle();
        expect(find.text('Your request was declined'), findsOneWidget);
      }, () => backend.client);
    });

    testWidgets('an empty sheet still offers asking to join a family', (
      tester,
    ) async {
      final backend = _Backend();
      await http.runWithClient(() async {
        await _pumpHome(tester);
        await tester.tap(_bell);
        await tester.pumpAndSettle();
        expect(find.text('No requests yet.'), findsOneWidget);

        await tester.tap(find.text('Ask to join a family').last);
        await tester.pumpAndSettle();
        expect(find.text('Join a family'), findsOneWidget);
      }, () => backend.client);
    });
  });

  group('answering a request', () {
    testWidgets('Approve waits for a dependant, then links the ticked ones', (
      tester,
    ) async {
      final backend = _Backend(incoming: [_incoming]);
      await http.runWithClient(() async {
        await _pumpHome(tester);
        await tester.tap(_bell);
        await tester.pumpAndSettle();

        // Two dependants to choose from, so neither is ticked for them.
        expect(_approve(tester).onPressed, isNull);
        await tester.tap(find.text('Wanjiku Kamau').last);
        await tester.pump();
        expect(_approve(tester).onPressed, isNotNull);

        await tester.tap(find.widgetWithText(ElevatedButton, 'Approve'));
        await tester.pumpAndSettle();
        expect(backend.writes.last.$1, '/family-link-requests/r1/approve');
        expect(backend.writes.last.$2, {
          'dependantIds': ['d1'],
        });
        expect(find.text('Brian Kamau is now linked.'), findsOneWidget);
        expect(find.text('Asking you to link them'), findsNothing);
      }, () => backend.client);
    });

    testWidgets('a single dependant still to choose is ticked already', (
      tester,
    ) async {
      final backend = _Backend(
        incoming: [
          {
            ..._incoming,
            'dependants': [
              {'id': 'd1', 'fullName': 'Wanjiku Kamau', 'alreadyLinked': false},
              {'id': 'd2', 'fullName': 'Otieno Kamau', 'alreadyLinked': true},
            ],
          },
        ],
      );
      await http.runWithClient(() async {
        await _pumpHome(tester);
        await tester.tap(_bell);
        await tester.pumpAndSettle();

        expect(find.text('Already linked'), findsOneWidget);
        // The already-linked dependant can't be unticked or sent.
        final linked = tester.widget<CheckboxListTile>(
          find.widgetWithText(CheckboxListTile, 'Otieno Kamau'),
        );
        expect(linked.value, isTrue);
        expect(linked.onChanged, isNull);

        await tester.tap(find.widgetWithText(ElevatedButton, 'Approve'));
        await tester.pumpAndSettle();
        expect(backend.writes.last.$2, {
          'dependantIds': ['d1'],
        });
      }, () => backend.client);
    });

    testWidgets('Decline rejects the request', (tester) async {
      final backend = _Backend(incoming: [_incoming]);
      await http.runWithClient(() async {
        await _pumpHome(tester);
        await tester.tap(_bell);
        await tester.pumpAndSettle();

        await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
        await tester.pumpAndSettle();
        expect(backend.writes.last.$1, '/family-link-requests/r1/reject');
        expect(
          find.text("Brian Kamau's request was declined."),
          findsOneWidget,
        );
      }, () => backend.client);
    });

    testWidgets("the server's reason is shown when an answer is refused", (
      tester,
    ) async {
      final backend = _Backend(
        incoming: [_incoming],
        answer: (_) => _problem(
          409,
          'Conflict',
          'This request has already been answered.',
        ),
      );
      await http.runWithClient(() async {
        await _pumpHome(tester);
        await tester.tap(_bell);
        await tester.pumpAndSettle();

        await tester.tap(find.widgetWithText(OutlinedButton, 'Decline'));
        await tester.pumpAndSettle();
        expect(
          find.text('This request has already been answered.'),
          findsOneWidget,
        );
      }, () => backend.client);
    });
  });

  group('asking to join a family', () {
    Future<void> pumpJoin(WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          home: JoinFamilyScreen(
            linkRequestsApi: FamilyLinkRequestsApi(ApiClient(() async => null)),
          ),
        ),
      );
    }

    ElevatedButton send(WidgetTester tester) => tester.widget<ElevatedButton>(
      find.widgetWithText(ElevatedButton, 'Send request'),
    );

    testWidgets('sends a phone number in E.164, and confirms without saying '
        'whether it matched', (tester) async {
      final sent = <Object?>[];
      final backend = MockClient((request) async {
        sent.add(jsonDecode(request.body));
        return _json({'detail': 'Request sent.'}, 202);
      });
      await http.runWithClient(() async {
        await pumpJoin(tester);
        final contact = find.widgetWithText(
          TextField,
          "Primary contact's email or phone",
        );

        expect(send(tester).onPressed, isNull);
        await tester.enterText(contact, 'not a contact');
        await tester.pump();
        expect(
          find.text('Enter an email address or a Kenyan phone number.'),
          findsOneWidget,
        );
        expect(send(tester).onPressed, isNull);

        await tester.enterText(contact, '0712 345 678');
        await tester.pump();
        expect(
          find.text('Enter an email address or a Kenyan phone number.'),
          findsNothing,
        );
        await tester.tap(find.widgetWithText(ElevatedButton, 'Send request'));
        await tester.pumpAndSettle();

        // A blank relationship is left out, not sent empty.
        expect(sent, [
          {'contact': '+254712345678'},
        ]);
        expect(find.text('Request sent'), findsOneWidget);
        expect(
          find.textContaining(
            "If that person is a dependant's primary contact",
          ),
          findsOneWidget,
        );
      }, () => backend);
    });

    testWidgets('sends an email with the relationship', (tester) async {
      final sent = <Object?>[];
      final backend = MockClient((request) async {
        sent.add(jsonDecode(request.body));
        return _json({}, 202);
      });
      await http.runWithClient(() async {
        await pumpJoin(tester);
        await tester.enterText(
          find.widgetWithText(TextField, "Primary contact's email or phone"),
          ' mama@example.com ',
        );
        await tester.enterText(
          find.widgetWithText(
            TextField,
            'Your relationship to the dependant (optional)',
          ),
          'Niece',
        );
        await tester.pump();
        await tester.tap(find.widgetWithText(ElevatedButton, 'Send request'));
        await tester.pumpAndSettle();
        expect(sent, [
          {'contact': 'mama@example.com', 'relationship': 'Niece'},
        ]);
      }, () => backend);
    });

    testWidgets('a failed send stays on the form with the reason', (
      tester,
    ) async {
      final backend = MockClient(
        (_) async => _problem(403, 'Forbidden', 'Only family members can ask.'),
      );
      await http.runWithClient(() async {
        await pumpJoin(tester);
        await tester.enterText(
          find.widgetWithText(TextField, "Primary contact's email or phone"),
          'mama@example.com',
        );
        await tester.pump();
        await tester.tap(find.widgetWithText(ElevatedButton, 'Send request'));
        await tester.pumpAndSettle();
        expect(find.text('Only family members can ask.'), findsOneWidget);
        expect(find.text('Request sent'), findsNothing);
      }, () => backend);
    });
  });

  group('linking an existing account by email', () {
    Future<List<FamilyMemberLink>> pumpPanel(WidgetTester tester) async {
      tester.view.physicalSize = const Size(360, 780);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      final linked = <FamilyMemberLink>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: FamilyLinkPanel(
              dependantsApi: DependantsApi(ApiClient(() async => null)),
              dependantId: 'd1',
              onLinked: linked.add,
            ),
          ),
        ),
      );
      return linked;
    }

    Finder email() => find.widgetWithText(TextField, 'Their email');
    Finder linkButton() =>
        find.widgetWithText(OutlinedButton, 'Link family member');

    testWidgets('links them and clears the form', (tester) async {
      late Map<String, dynamic> sent;
      late String path;
      final backend = MockClient((request) async {
        path = request.url.path.replaceFirst('/prod', '');
        sent = jsonDecode(request.body) as Map<String, dynamic>;
        return _json({
          'familyMemberUserId': 'u2',
          'fullName': 'Brian Kamau',
          'relationship': 'Grandson',
          'isPrimaryContact': false,
        }, 201);
      });
      await http.runWithClient(() async {
        final linked = await pumpPanel(tester);
        expect(tester.widget<OutlinedButton>(linkButton()).onPressed, isNull);
        await tester.enterText(email(), 'brian@example');
        await tester.pump();
        expect(tester.widget<OutlinedButton>(linkButton()).onPressed, isNull);

        await tester.enterText(email(), 'brian@example.com');
        await tester.enterText(
          find.widgetWithText(
            TextField,
            'Their relationship to the dependant (optional)',
          ),
          'Grandson',
        );
        await tester.pump();
        await tester.tap(linkButton());
        await tester.pumpAndSettle();

        expect(path, '/dependants/d1/family-members/link');
        expect(sent, {
          'email': 'brian@example.com',
          'relationship': 'Grandson',
        });
        expect(linked.single.fullName, 'Brian Kamau');
        expect(find.text('Brian Kamau is now linked.'), findsOneWidget);
        expect(tester.widget<TextField>(email()).controller!.text, isEmpty);
      }, () => backend);
    });

    for (final (status, detail) in [
      (
        404,
        "No Mzazi Care account uses that email. They can sign up in the app and "
            'send you a request to link them.',
      ),
      (409, 'They are already linked to this dependant.'),
    ]) {
      testWidgets("a $status shows the server's explanation", (tester) async {
        final backend = MockClient(
          (_) async => _problem(status, 'Problem', detail),
        );
        await http.runWithClient(() async {
          final linked = await pumpPanel(tester);
          await tester.enterText(email(), 'someone@example.com');
          await tester.pump();
          await tester.tap(linkButton());
          await tester.pumpAndSettle();
          expect(find.text(detail), findsOneWidget);
          expect(linked, isEmpty);
          // Kept, so a typo can be corrected rather than retyped.
          expect(
            tester.widget<TextField>(email()).controller!.text,
            'someone@example.com',
          );
        }, () => backend);
      });
    }
  });

  testWidgets('the primary contact can link a family member from the Family '
      'tab', (tester) async {
    final backend = _Backend();
    await http.runWithClient(() async {
      await _pumpHome(tester);
      // Family is a bottom-navigation tab for the selected (only) dependant.
      await tester.tap(find.widgetWithText(NavigationDestination, 'Family'));
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(OutlinedButton, 'Link a family member'),
      );
      await tester.pumpAndSettle();
      expect(find.byType(FamilyLinkPanel), findsOneWidget);
    }, () => backend.client);
  });
}
