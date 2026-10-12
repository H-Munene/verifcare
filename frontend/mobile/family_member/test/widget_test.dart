import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:family_member/api/api_client.dart';
import 'package:family_member/api/biometric_enrollments_api.dart';
import 'package:family_member/api/dependants_api.dart';
import 'package:family_member/api/family_link_requests_api.dart';
import 'package:family_member/api/terms_api.dart';
import 'package:family_member/api/users_api.dart';
import 'package:family_member/api/visit_schedules_api.dart';
import 'package:family_member/auth/cognito_auth_service.dart';
import 'package:family_member/main.dart';

void main() {
  testWidgets('opens on sign-in when no session is cached', (
    WidgetTester tester,
  ) async {
    // No cached "last signed-in user" key, so CognitoAuthService.getCurrentSession() resolves to
    // null and _RootScreen should land on sign-in rather than HomeScreen.
    SharedPreferences.setMockInitialValues({});

    final authService = CognitoAuthService();
    final apiClient = ApiClient(authService.getIdToken);

    await tester.pumpWidget(
      MzaziCareFamilyMemberApp(
        authService: authService,
        usersApi: UsersApi(apiClient),
        dependantsApi: DependantsApi(apiClient),
        visitSchedulesApi: VisitSchedulesApi(apiClient),
        enrollmentsApi: BiometricEnrollmentsApi(apiClient),
        termsApi: TermsApi(apiClient),
        linkRequestsApi: FamilyLinkRequestsApi(apiClient),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('Welcome back'), findsOneWidget);
    expect(find.text('Sign in'), findsOneWidget);
    expect(find.text("Don't have an account? Create one"), findsOneWidget);
    // The root page has nothing to go back to.
    expect(find.byType(BackButton), findsNothing);
  });
}
