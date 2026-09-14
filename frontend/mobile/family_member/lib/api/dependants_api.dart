import 'api_client.dart';

/// POST /dependants - matches backend/src/routes/dependants.ts's createDependantRequestSchema.
/// A family_member caller may only name themselves as primaryFamilyMember (enforced server-side);
/// this app never builds a request naming anyone else.
class DependantsApi {
  final ApiClient _client;
  DependantsApi(this._client);

  Future<void> registerDependant({
    required String fullName,
    required String dob,
    required double geofenceLat,
    required double geofenceLng,
    required int geofenceRadiusMeters,
    required bool cognitiveMonitoringEnabled,
    required String selfCognitoSub,
    required String selfPhoneNumber,
    required String selfFullName,
    String? gender,
    String? homeAddressText,
    String? relationship,
  }) async {
    await _client.post('/dependants', {
      'fullName': fullName,
      'dob': dob,
      'gender': ?gender,
      'homeAddressText': ?homeAddressText,
      'geofenceLat': geofenceLat,
      'geofenceLng': geofenceLng,
      'geofenceRadiusMeters': geofenceRadiusMeters,
      'cognitiveMonitoringEnabled': cognitiveMonitoringEnabled,
      'primaryFamilyMember': {
        'cognitoSub': selfCognitoSub,
        'phoneNumber': selfPhoneNumber,
        'fullName': selfFullName,
        'relationship': ?relationship,
        'isPrimaryContact': true,
      },
    });
  }
}
