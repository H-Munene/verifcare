import 'api_client.dart';

/// An enrolled reference photo of a dependant (GET /biometric-enrollments).
class BiometricEnrollment {
  final String id;
  final int imageOrder;
  // A presigned S3 URL that expires 15 minutes after the list call - re-fetch the list rather
  // than holding on to it.
  final String imageUrl;
  // active | flagged (matched another person's face, awaiting a supervisor) | superseded
  final String status;

  BiometricEnrollment({
    required this.id,
    required this.imageOrder,
    required this.imageUrl,
    required this.status,
  });

  factory BiometricEnrollment.fromJson(Map<String, dynamic> json) =>
      switch (json) {
        {
          'id': String id,
          'imageOrder': int imageOrder,
          'imageUrl': String imageUrl,
          'status': String status,
        } =>
          BiometricEnrollment(
            id: id,
            imageOrder: imageOrder,
            imageUrl: imageUrl,
            status: status,
          ),
        _ => throw FormatException('Unexpected enrollment: $json'),
      };
}

class BiometricEnrollmentsApi {
  final ApiClient _client;
  BiometricEnrollmentsApi(this._client);

  /// The dependant's current photos: active and flagged ones. Superseded photos (replaced by a
  /// newer one) are left out, since they're no longer what check-in compares against.
  Future<List<BiometricEnrollment>> listCurrentForDependant(
    String dependantId,
  ) async {
    final query = Uri(
      queryParameters: {'subjectType': 'dependant', 'subjectId': dependantId},
    ).query;
    final json = await _client.getList('/biometric-enrollments?$query');
    return json
        .map(
          (item) => BiometricEnrollment.fromJson(item as Map<String, dynamic>),
        )
        .where((e) => e.status != 'superseded')
        .toList();
  }
}
