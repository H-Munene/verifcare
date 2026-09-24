import 'api_client.dart';

/// A dependant as returned by GET /dependants and GET /dependants/{id}.
class Dependant {
  final String id;
  final String fullName;
  final DateTime dob;
  final String? gender;
  final String? homeAddressText;
  final String? primaryConditionSummary;
  final String? county;
  final String? constituency;
  final String? ward;
  final bool active;

  Dependant({
    required this.id,
    required this.fullName,
    required this.dob,
    this.gender,
    this.homeAddressText,
    this.primaryConditionSummary,
    this.county,
    this.constituency,
    this.ward,
    required this.active,
  });

  factory Dependant.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'id': String id,
      'fullName': String fullName,
      'dob': String dob,
      'status': String status,
    } =>
      Dependant(
        id: id,
        fullName: fullName,
        dob: DateTime.parse(dob),
        gender: json['gender'] as String?,
        homeAddressText: json['homeAddressText'] as String?,
        primaryConditionSummary: json['primaryConditionSummary'] as String?,
        county: json['county'] as String?,
        constituency: json['constituency'] as String?,
        ward: json['ward'] as String?,
        active: status == 'active',
      ),
    _ => throw FormatException('Unexpected dependant: $json'),
  };

  int ageOn(DateTime today) {
    final hadBirthday =
        today.month > dob.month ||
        (today.month == dob.month && today.day >= dob.day);
    return today.year - dob.year - (hadBirthday ? 0 : 1);
  }

  /// "Ward, Constituency, County", skipping any that are missing.
  String? get areaText {
    final parts = [ward, constituency, county].whereType<String>();
    return parts.isEmpty ? null : parts.join(', ');
  }
}

/// A care-plan task (GET /dependants/{id}/care-tasks) - what the caregiver is meant to do on
/// every visit. Read-only here: authoring is supervisor-only.
class CareTask {
  final String title;
  final String? description;
  final bool required;

  CareTask({required this.title, this.description, required this.required});

  factory CareTask.fromJson(Map<String, dynamic> json) => switch (json) {
    {'title': String title, 'required': bool required} => CareTask(
      title: title,
      description: json['description'] as String?,
      required: required,
    ),
    _ => throw FormatException('Unexpected care task: $json'),
  };
}

/// One family member linked to a dependant (GET /dependants/{id}/family-members).
class FamilyMemberLink {
  final String userId;
  final String fullName;
  final String? relationship;
  final bool isPrimaryContact;

  FamilyMemberLink({
    required this.userId,
    required this.fullName,
    this.relationship,
    required this.isPrimaryContact,
  });

  factory FamilyMemberLink.fromJson(Map<String, dynamic> json) =>
      switch (json) {
        {
          'familyMemberUserId': String userId,
          'fullName': String fullName,
          'isPrimaryContact': bool isPrimaryContact,
        } =>
          FamilyMemberLink(
            userId: userId,
            fullName: fullName,
            relationship: json['relationship'] as String?,
            isPrimaryContact: isPrimaryContact,
          ),
        _ => throw FormatException('Unexpected family member: $json'),
      };
}

/// Matches backend/src/routes/dependants.ts. A family_member caller only ever sees dependants
/// they're linked to (enforced server-side).
class DependantsApi {
  final ApiClient _client;
  DependantsApi(this._client);

  /// Every linked dependant, active and deactivated, following nextCursor through all pages.
  Future<List<Dependant>> listDependants() async {
    final dependants = <Dependant>[];
    String? cursor;
    do {
      final query = Uri(
        queryParameters: {'cursor': ?cursor, 'limit': '100'},
      ).query;
      final json = await _client.get('/dependants?$query');
      dependants.addAll(
        (json['items'] as List).map(
          (item) => Dependant.fromJson(item as Map<String, dynamic>),
        ),
      );
      cursor = json['nextCursor'] as String?;
    } while (cursor != null);
    return dependants;
  }

  Future<Dependant> getDependant(String dependantId) async =>
      Dependant.fromJson(await _client.get('/dependants/$dependantId'));

  Future<List<FamilyMemberLink>> listFamilyMembers(String dependantId) async {
    final json = await _client.getList(
      '/dependants/$dependantId/family-members',
    );
    return json
        .map((item) => FamilyMemberLink.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  Future<List<CareTask>> listActiveCareTasks(String dependantId) async {
    final json = await _client.getList(
      '/dependants/$dependantId/care-tasks?active=true',
    );
    return json
        .map((item) => CareTask.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  // POST /dependants. A family_member caller may only name themselves as primaryFamilyMember
  // (enforced server-side). Still missing county/constituency/ward, which the backend now
  // requires - the registration wizard rebuild (docs/family-app-plan.md step 4) fixes this.
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
