import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config.dart';

// RFC 7807 problem body.
class Problem {
  final String type;
  final String title;
  final int status;
  final String? detail;
  final String? instance;

  Problem({
    required this.type,
    required this.title,
    required this.status,
    this.detail,
    this.instance,
  });

  factory Problem.fromJson(Map<String, dynamic> json) {
    return Problem(
      type: json['type'] as String? ?? 'about:blank',
      title: json['title'] as String? ?? 'Error',
      status: json['status'] as int? ?? 0,
      detail: json['detail'] as String?,
      instance: json['instance'] as String?,
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

/// HTTP wrapper: adds the base URL and bearer token, and turns problem+json errors into
/// ApiException.
class ApiClient {
  final GetIdToken _getIdToken;

  ApiClient(this._getIdToken);

  Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async {
    final token = await _getIdToken();
    final response = await http.post(
      Uri.parse('${AppConfig.apiBaseUrl}$path'),
      headers: {
        'Content-Type': 'application/json',
        if (token != null) 'Authorization': 'Bearer $token',
      },
      body: jsonEncode(body),
    );

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
    throw ApiException(Problem(
      type: 'about:blank',
      title: response.reasonPhrase ?? 'Error',
      status: response.statusCode,
    ));
  }
}
