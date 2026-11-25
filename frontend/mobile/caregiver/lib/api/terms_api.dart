import 'api_client.dart';

/// The current terms of use and privacy notice for this app's users (GET /terms/current).
class TermsDocument {
  final String version;
  final String title;
  final DateTime effectiveDate;
  final List<({String heading, List<String> paragraphs})> sections;
  final bool accepted;

  TermsDocument({
    required this.version,
    required this.title,
    required this.effectiveDate,
    required this.sections,
    required this.accepted,
  });

  factory TermsDocument.fromJson(Map<String, dynamic> json) => switch (json) {
    {
      'version': String version,
      'title': String title,
      'effectiveDate': String effectiveDate,
      'sections': List<dynamic> sections,
    } =>
      TermsDocument(
        version: version,
        title: title,
        effectiveDate: DateTime.parse(effectiveDate),
        sections: [
          for (final section in sections)
            switch (section) {
              {
                'heading': String heading,
                'paragraphs': List<dynamic> paragraphs,
              } =>
                (heading: heading, paragraphs: paragraphs.cast<String>()),
              _ => throw FormatException('Unexpected terms section: $section'),
            },
        ],
        accepted: json['acceptedAt'] != null,
      ),
    _ => throw FormatException('Unexpected terms: $json'),
  };
}

/// Matches backend/src/routes/terms.ts. The server decides which document and version is current,
/// so new terms reach users without an app release.
class TermsApi {
  final ApiClient _client;
  TermsApi(this._client);

  // Users who accepted in this run of the app, so moving between screens that each sit behind the
  // consent gate doesn't refetch and flash a loading state. Keyed by Cognito sub, so another
  // person signing in on the same phone is still asked.
  final _acceptedBy = <String>{};

  bool acceptedThisSession(String sub) => _acceptedBy.contains(sub);

  Future<TermsDocument> current() async =>
      TermsDocument.fromJson(await _client.get('/terms/current'));

  /// Records acceptance of the [version] the user was shown, with the consent screen's two
  /// required consents (the server refuses an acceptance without all of them, and records them as
  /// consent records). A 409 means the terms changed since they were loaded, and the user must
  /// see the new version.
  Future<void> accept({
    required String sub,
    required String version,
    required bool locationConsent,
    required bool audioConsent,
  }) async {
    await _client.post('/terms/current/accept', {
      'version': version,
      'locationConsent': locationConsent,
      'audioConsent': audioConsent,
    });
    _acceptedBy.add(sub);
  }

  void rememberAccepted(String sub) => _acceptedBy.add(sub);
}
