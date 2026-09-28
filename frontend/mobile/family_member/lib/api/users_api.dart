import 'api_client.dart';

/// POST /users - completes self-registration for a brand-new Cognito self-signup. Restricted
/// server-side (backend/src/routes/users.ts) to the caller's own cognitoSub and role:
/// family_member for any non-supervisor caller, which is exactly this app's use case.
class UsersApi {
  final ApiClient _client;
  UsersApi(this._client);

  /// The caller's own user row (GET /users/me). Other responses (e.g. family-member links) refer
  /// to users by this internal id, not by Cognito sub.
  Future<({String id, String fullName, String? phoneNumber})> getMe() async {
    final json = await _client.get('/users/me');
    return switch (json) {
      {'id': String id, 'fullName': String fullName} => (
        id: id,
        fullName: fullName,
        phoneNumber: json['phoneNumber'] as String?,
      ),
      _ => throw FormatException('Unexpected user: $json'),
    };
  }

  Future<void> registerSelf({
    required String cognitoSub,
    required String email,
    required String phoneNumber,
    required String fullName,
  }) async {
    await _client.post('/users', {
      'cognitoSub': cognitoSub,
      'email': email,
      'phoneNumber': phoneNumber,
      'fullName': fullName,
      'role': 'family_member',
    });
  }
}
