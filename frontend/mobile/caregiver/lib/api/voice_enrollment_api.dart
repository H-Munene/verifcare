import 'api_client.dart';

/// The caregiver's own voice enrolment (backend/src/routes/voiceEnrollments.ts): about 30 seconds
/// of speech becomes the voiceprint their visit recordings are checked against.
class VoiceEnrollmentApi {
  final ApiClient _client;

  VoiceEnrollmentApi(this._client);

  /// When the caregiver enrolled, or null if they haven't yet.
  Future<DateTime?> enrolledAt() async {
    final json = await _client.get('/voice-enrollments/me');
    final at = json['enrolledAt'] as String?;
    return at == null ? null : DateTime.parse(at).toLocal();
  }

  /// Presign, upload straight to S3, then confirm, which makes the voiceprint and deletes the
  /// audio. The server answers 422 when it heard too little speech.
  Future<void> enrol(List<int> bytes) async {
    final presign = await _client.post(
      '/voice-enrollments/me/upload-url',
      const {},
    );
    await ApiClient.uploadToPresignedUrl(
      presign['uploadUrl'] as String,
      bytes,
      'audio/mp4',
    );
    await _client.post('/voice-enrollments/me', {'s3Key': presign['s3Key']});
  }
}
