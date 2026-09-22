import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:caregiver/auth/cognito_auth_service.dart';
import 'package:caregiver/main.dart';

void main() {
  testWidgets('shows the login screen when no session is cached', (WidgetTester tester) async {
    // No cached "last signed-in user" key, so CognitoAuthService.getCurrentSession() resolves to
    // null and _RootScreen should land on LoginScreen - this app has no welcome/sign-up screen to
    // land on instead, since a caregiver never self-registers.
    SharedPreferences.setMockInitialValues({});

    await tester.pumpWidget(MzaziCareCaregiverApp(authService: CognitoAuthService()));
    await tester.pumpAndSettle();

    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('Email'), findsOneWidget);
    expect(find.text('Password'), findsOneWidget);
  });
}
