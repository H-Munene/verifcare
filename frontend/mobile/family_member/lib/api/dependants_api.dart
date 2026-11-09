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
  final double geofenceLat;
  final double geofenceLng;
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
    required this.geofenceLat,
    required this.geofenceLng,
    required this.active,
  });

  factory Dependant.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'id': String id,
      'fullName': String fullName,
      'dob': String dob,
      'geofenceLat': num geofenceLat,
      'geofenceLng': num geofenceLng,
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
        geofenceLat: geofenceLat.toDouble(),
        geofenceLng: geofenceLng.toDouble(),
        active: status == 'active',
      ),
    _ => throw FormatException('Unexpected dependant: $json'),
  };

  int ageOn(DateTime today) => ageOnDate(dob, today);


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
  // Registration details (2026-09-26). The backend never sends another member's ID document to a
  // family member, so there is none here.
  final String? email;
  final String? phoneNumber;
  final String? addedByName;
  final DateTime? linkedAt;

  FamilyMemberLink({
    required this.userId,
    required this.fullName,
    this.relationship,
    required this.isPrimaryContact,
    this.email,
    this.phoneNumber,
    this.addedByName,
    this.linkedAt,
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
            email: json['email'] as String?,
            phoneNumber: json['phoneNumber'] as String?,
            addedByName: json['addedByName'] as String?,
            linkedAt: switch (json['createdAt']) {
              final String at => DateTime.parse(at).toLocal(),
              _ => null,
            },
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

  /// The primary contact links someone who already has an account, by their exact email
  /// (POST .../family-members/link). A 404 means no account uses that email - they need to sign
  /// up and send a link request instead.
  Future<FamilyMemberLink> linkExistingMember(
    String dependantId, {
    required String email,
    String? relationship,
  }) async => FamilyMemberLink.fromJson(
    await _client.post('/dependants/$dependantId/family-members/link', {
      'email': email,
      'relationship': ?relationship,
    }),
  );

  Future<List<CareTask>> listActiveCareTasks(String dependantId) async {
    final json = await _client.getList(
      '/dependants/$dependantId/care-tasks?active=true',
    );
    return json
        .map((item) => CareTask.fromJson(item as Map<String, dynamic>))
        .toList();
  }

  /// POST /dependants, naming the caller as primary contact - a family_member may only name
  /// themselves (enforced server-side). The radius is always the standard 20 m: widening it is a
  /// supervisor decision (docs/family-app-plan.md, B3). Returns the new dependant.
  Future<Dependant> registerDependant({
    required String fullName,
    required DateTime dob,
    required String county,
    required String constituency,
    required String ward,
    required double geofenceLat,
    required double geofenceLng,
    required String selfCognitoSub,
    required String selfPhoneNumber,
    required String selfFullName,
    String? gender,
    String? homeAddressText,
    String? primaryConditionSummary,
    String? relationship,
  }) async {
    final json = await _client.post('/dependants', {
      'fullName': fullName,
      'dob': _isoDate(dob),
      'gender': ?gender,
      'homeAddressText': ?homeAddressText,
      'primaryConditionSummary': ?primaryConditionSummary,
      'county': county,
      'constituency': constituency,
      'ward': ward,
      'geofenceLat': geofenceLat,
      'geofenceLng': geofenceLng,
      'geofenceRadiusMeters': standardGeofenceRadiusMeters,
      'primaryFamilyMember': {
        'cognitoSub': selfCognitoSub,
        'phoneNumber': selfPhoneNumber,
        'fullName': selfFullName,
        'relationship': ?relationship,
        'isPrimaryContact': true,
      },
    });
    return Dependant.fromJson(json);
  }

  /// PATCH /dependants/{id} as the primary contact. Only fields a family member may change:
  /// never status or geofenceRadiusMeters (supervisor-only - the backend answers 403), and never
  /// dob (nobody can edit it). The backend has no way to clear an optional text field, so a
  /// null here means "leave unchanged", not "clear".
  Future<Dependant> updateDependant(
    String dependantId, {
    required String fullName,
    required String county,
    required String constituency,
    required String ward,
    required double geofenceLat,
    required double geofenceLng,
    String? gender,
    String? homeAddressText,
    String? primaryConditionSummary,
  }) async => Dependant.fromJson(
    await _client.patch('/dependants/$dependantId', {
      'fullName': fullName,
      'gender': ?gender,
      'homeAddressText': ?homeAddressText,
      'primaryConditionSummary': ?primaryConditionSummary,
      'county': county,
      'constituency': constituency,
      'ward': ward,
      'geofenceLat': geofenceLat,
      'geofenceLng': geofenceLng,
    }),
  );

  static String _isoDate(DateTime d) =>
      '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
}

/// Whole years, counting a birthday only once it has passed this year.
int ageOnDate(DateTime dob, DateTime today) {
  final hadBirthday =
      today.month > dob.month ||
      (today.month == dob.month && today.day >= dob.day);
  return today.year - dob.year - (hadBirthday ? 0 : 1);
}

/// The check-in radius every family-registered dependant gets: the web app's settled default,
/// wide enough for typical phone GPS accuracy (~5 m outdoors, worse indoors).
const standardGeofenceRadiusMeters = 20;
