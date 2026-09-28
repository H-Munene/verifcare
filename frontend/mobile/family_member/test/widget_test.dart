import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/main.dart';

void main() {
  testWidgets('shows the welcome screen when no session is cached', (WidgetTester tester) async {
    // No cached "last signed-in user" key, so CognitoAuthService.getCurrentSession() resolves to
    // null and _RootScreen should land on WelcomeScreen rather than HomeScreen.
    SharedPreferences.setMockInitialValues({});

    final authService = CognitoAuthService();
    final apiClient = ApiClient(authService.getIdToken);

    await tester.pumpWidget(MzaziCareFamilyMemberApp(
      authService: authService,
      usersApi: UsersApi(apiClient),
      dependantsApi: DependantsApi(apiClient),
    ));
    await tester.pumpAndSettle();

    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text('Create account'), findsOneWidget);
  });
}
