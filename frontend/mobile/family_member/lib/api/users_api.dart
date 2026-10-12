import 'api_client.dart';

/// POST /users: completes self-registration as a family_member.
class UsersApi {
  final ApiClient _client;
  UsersApi(this._client);

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
