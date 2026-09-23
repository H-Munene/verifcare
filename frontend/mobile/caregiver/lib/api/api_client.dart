import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';

// Ported from frontend/mobile/family_member/lib/api/api_client.dart, which itself matches
// frontend/web/src/api/client.ts's Problem/ApiException shape and backend/src/errors.ts's
// sendProblem() exactly. Extended with get() (family_member's own version only ever needed post())
// - this app's first two endpoints (GET .../visit-schedules, GET .../checkin/context) are both
// reads.
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

  Future<Map<String, dynamic>> get(String path) async {
    final token = await _getIdToken();
    final response = await http.get(
      Uri.parse('${AppConfig.apiBaseUrl}$path'),
      headers: {if (token != null) 'Authorization': 'Bearer $token'},
    );
    return _parseResponse(response);
  }

  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body,
  ) async {
    final token = await _getIdToken();
    final response = await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}$path'),
      headers: {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      },
      body: jsonEncode(body),
    );
    return _parseResponse(response);
  }

  Map<String, dynamic> _parseResponse(http.Response response) {
    if (response.statusCode >= 200 && response.statusCode < 300) {
      if (response.body.isEmpty) {
        return const {};
      }
      return jsonDecode(response.body) as Map<String, dynamic>;
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
