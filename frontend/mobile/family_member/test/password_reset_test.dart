import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/screens/forgot_password_screen.dart';
import 'package:family_member/screens/login_screen.dart';
import 'package:family_member/widgets/password_field.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// Cognito itself can't be reached from a test, so a fake auth service stands in for it and
// records what the screens ask it to do.
class _FakeAuth extends CognitoAuthService {
  final List<String> resetRequests = [];
  ({String email, String code, String newPassword})? confirmed;
  Object? confirmError;
  SignInResult? signInResult;

  @override
  Future<void> requestPasswordReset(String email) async =>
      resetRequests.add(email);

  @override
  Future<void> confirmPasswordReset({
    required String email,
    required String code,
    required String newPassword,
  }) async {
    if (confirmError case final error?) throw error;
    confirmed = (email: email, code: code, newPassword: newPassword);
  }

  @override
  Future<SignInResult> signIn(String email, String password) async =>
      signInResult!;
}

bool _obscured(WidgetTester tester, String label) => tester
    .widget<TextField>(
      find.descendant(
        of: find.widgetWithText(PasswordField, label),
        matching: find.byType(TextField),
      ),
    )
    .obscureText;

void main() {
  test('reset errors read as instructions, not Cognito exceptions', () {
    CognitoClientException error(String code, [String? message]) =>
        CognitoClientException(message, code: code);
    expect(
      passwordResetErrorText(error('CodeMismatchException')),
      contains("isn't right"),
    );
    expect(
      passwordResetErrorText(
        error(
          'InvalidPasswordException',
          'Password does not conform to policy: Password must have symbol characters',
        ),
      ),
      'Password must have symbol characters',
    );
    expect(
      passwordResetErrorText(error('NotAuthorizedException')),
      contains('temporary password'),
    );
    expect(
      passwordResetErrorText(Exception('boom')),
      'Something went wrong. Please try again.',
    );
  });

  testWidgets('email, then code and matching passwords, pops with the email', (
    tester,
  ) async {
    final auth = _FakeAuth();
    String? result;
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async =>
                result = await Navigator.of(context).push<String>(
                  MaterialPageRoute(
                    builder: (_) => ForgotPasswordScreen(authService: auth),
                  ),
                ),
            child: const Text('open'),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Send code'));
    await tester.pump();
    expect(find.text('Email is required.'), findsOneWidget);
    expect(auth.resetRequests, isEmpty);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Email'),
      ' wanjiku@example.com ',
    );
    await tester.tap(find.text('Send code'));
    await tester.pumpAndSettle();
    expect(auth.resetRequests, ['wanjiku@example.com']);
    // Worded so it's true whether or not the email has an account.
    expect(
      find.textContaining("If there's an account for wanjiku@example.com"),
      findsOneWidget,
    );

    // Both password fields start hidden and each has its own toggle.
    expect(_obscured(tester, 'New password'), isTrue);
    await tester.tap(find.byTooltip('Show password').first);
    await tester.pump();
    expect(_obscured(tester, 'New password'), isFalse);
    expect(_obscured(tester, 'Confirm new password'), isTrue);

    await tester.enterText(
      find.widgetWithText(TextFormField, 'Code'),
      '123456',
    );
    await tester.enterText(
      find.widgetWithText(PasswordField, 'New password'),
      'Nairobi#2026',
    );
    await tester.enterText(
      find.widgetWithText(PasswordField, 'Confirm new password'),
      'Nairobi#2025',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Reset password'));
    await tester.pump();
    expect(find.text('Passwords do not match.'), findsOneWidget);
    expect(auth.confirmed, isNull);

    // A wrong code keeps the user on the step with a readable message.
    auth.confirmError = CognitoClientException(
      'bad',
      code: 'CodeMismatchException',
    );
    await tester.enterText(
      find.widgetWithText(PasswordField, 'Confirm new password'),
      'Nairobi#2026',
    );
    await tester.tap(find.widgetWithText(FilledButton, 'Reset password'));
    await tester.pumpAndSettle();
    expect(find.textContaining("That code isn't right"), findsOneWidget);

    auth.confirmError = null;
    await tester.tap(find.widgetWithText(FilledButton, 'Reset password'));
    await tester.pumpAndSettle();
    expect(auth.confirmed, (
      email: 'wanjiku@example.com',
      code: '123456',
      newPassword: 'Nairobi#2026',
    ));
    expect(result, 'wanjiku@example.com');
  });

  testWidgets(
    'an administrator-reset account goes from sign-in straight to the code step',
    (tester) async {
      final auth = _FakeAuth()..signInResult = SignInPasswordResetRequired();
      await tester.pumpWidget(
        MaterialApp(
          home: LoginScreen(
            authService: auth,
            usersApi: UsersApi(ApiClient(() async => null)),
            onAuthenticated: (_, {required justRegistered}) {},
            onCreateAccountInstead: () {},
          ),
        ),
      );
      expect(find.text('Forgot password?'), findsOneWidget);
      expect(_obscured(tester, 'Password'), isTrue);

      await tester.enterText(
        find.widgetWithText(TextFormField, 'Email'),
        'achieng@example.com',
      );
      await tester.enterText(
        find.widgetWithText(PasswordField, 'Password'),
        'old-password',
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Sign in'));
      await tester.pumpAndSettle();

      // Cognito already emailed this code, so no second one is requested.
      expect(find.textContaining('Your password was reset'), findsOneWidget);
      expect(find.textContaining('achieng@example.com'), findsOneWidget);
      expect(auth.resetRequests, isEmpty);
    },
  );
}
