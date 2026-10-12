import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';

// A copy of frontend/mobile/caregiver/lib/api/api_client.dart (the two apps deliberately share no
// package - user decision 2026-09-24), plus patch() for editing a dependant. Matches
// frontend/web/src/api/client.ts's Problem/ApiException shape and backend/src/errors.ts's
// sendProblem() exactly.
class Problem {
  final String type;
  final String title;
  final int status;
  final String? detail;
  final String? instance;
  // backend/src/errors.ts's Problem.failureReason - present on the geofence check's 422 so a
  // caller can branch deterministically instead of parsing detail's prose (e.g. distinguishing a
  // retriable out_of_range/insufficient_accuracy from a hard-blocked mock_location_detected).
  final String? failureReason;

  Problem({
    required this.type,
    required this.title,
    required this.status,
    this.detail,
    this.instance,
    this.failureReason,
  });

  factory Problem.fromJson(Map<String, dynamic> json) {
    return Problem(
      type: json['type'] as String? ?? 'about:blank',
      title: json['title'] as String? ?? 'Error',
      status: json['status'] as int? ?? 0,
      detail: json['detail'] as String?,
      instance: json['instance'] as String?,
      failureReason: json['failureReason'] as String?,
    );
  }
}

class ApiException implements Exception {
  final Problem problem;
  ApiException(this.problem);

  @override
  String toString() => problem.detail ?? problem.title;
}

typedef GetIdToken = Future<String?> Function();

/// Typed HTTP wrapper: base URL from AppConfig.apiBaseUrl, attaches the bearer ID token, parses
/// RFC 7807 error bodies into ApiException instead of letting callers deal with raw responses -
/// same contract as frontend/web/src/api/client.ts, ported to Dart.
class ApiClient {
  final GetIdToken _getIdToken;

  ApiClient(this._getIdToken);

  Future<Map<String, dynamic>> get(String path) async =>
      (await _getRaw(path) as Map<String, dynamic>?) ?? const {};

  // For the few endpoints whose body is a bare JSON array (e.g. GET .../tasks).
  Future<List<dynamic>> getList(String path) async =>
      await _getRaw(path) as List<dynamic>;

  Future<Object?> _getRaw(String path) async {
    final token = await _getIdToken();
    final response = await http.get(
      Uri.parse('${AppConfig.apiBaseUrl}$path'),
      headers: {if (token != null) 'Authorization': 'Bearer $token'},
    );
    return _parseResponse(response);
  }

  // headers: for the check-in flow's X-Checkin-Session-Token, which the backend requires
  // alongside (not instead of) the bearer token.
  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body, {
    Map<String, String> headers = const {},
  }) => _send('POST', path, body, headers);

  Future<Map<String, dynamic>> patch(String path, Map<String, dynamic> body) =>
      _send('PATCH', path, body, const {});

  Future<Map<String, dynamic>> put(String path, Map<String, dynamic> body) =>
      _send('PUT', path, body, const {});

  Future<Map<String, dynamic>> _send(
    String method,
    String path,
    Map<String, dynamic> body,
    Map<String, String> headers,
  ) async {
    final token = await _getIdToken();
    final request =
        http.Request(method, Uri.parse('${AppConfig.apiBaseUrl}$path'))
          ..headers.addAll({
            'Content-Type': 'application/json',
            if (token != null) 'Authorization': 'Bearer $token',
            ...headers,
          })
          ..body = jsonEncode(body);
    final response = await http.Response.fromStream(await request.send());
    return (_parseResponse(response) as Map<String, dynamic>?) ?? const {};
  }

  /// PUTs raw bytes straight to an S3 presigned URL - deliberately not through [_send]: S3
  /// rejects a request carrying the app's own bearer token (same reason as the web app's
  /// uploadFileToPresignedUrl).
  static Future<void> uploadToPresignedUrl(
    String uploadUrl,
    List<int> bytes,
    String contentType,
  ) async {
    final response = await http.put(
      Uri.parse(uploadUrl),
      headers: {'Content-Type': contentType},
      body: bytes,
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw ApiException(
        Problem(
          type: 'about:blank',
          title: 'Photo upload failed',
          status: response.statusCode,
        ),
      );
    }
  }

  Object? _parseResponse(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.isEmpty) {
        return null;
      }
      return jsonDecode(response.body);
    }

    if (response.body.isNotEmpty) {
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic> && decoded.containsKey('title')) {
        throw ApiException(Problem.fromJson(decoded));
      }
    }
    throw ApiException(
      Problem(
        type: 'about:blank',
        title: response.reasonPhrase ?? 'Error',
        status: response.statusCode,
      ),
    );
  }
}
