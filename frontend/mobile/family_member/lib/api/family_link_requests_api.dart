import 'api_client.dart';

/// A request addressed to the caller as a primary contact, with the dependants they could link
/// the requester to.
class IncomingLinkRequest {
  final String id;
  final String requesterName;
  final String? requesterEmail;
  final String? requesterPhone;
  final String? relationship;
  final DateTime createdAt;
  final List<({String id, String fullName, bool alreadyLinked})> dependants;

  IncomingLinkRequest({
    required this.id,
    required this.requesterName,
    this.requesterEmail,
    this.requesterPhone,
    this.relationship,
    required this.createdAt,
    required this.dependants,
  });

  factory IncomingLinkRequest.fromJson(Map<String, dynamic> json) =>
      switch (json) {
        {
          'id': String id,
          'requester':
              {'fullName': String requesterName} &&
              final Map<String, dynamic> requester,
          'createdAt': String createdAt,
          'dependants': List<dynamic> dependants,
        } =>
          IncomingLinkRequest(
            id: id,
            requesterName: requesterName,
            requesterEmail: requester['email'] as String?,
            requesterPhone: requester['phoneNumber'] as String?,
            relationship: json['relationship'] as String?,
            createdAt: DateTime.parse(createdAt).toLocal(),
            dependants: [
              for (final d in dependants)
                switch (d) {
                  {
                    'id': String id,
                    'fullName': String fullName,
                    'alreadyLinked': bool linked,
                  } =>
                    (id: id, fullName: fullName, alreadyLinked: linked),
                  _ => throw FormatException('Unexpected dependant: $d'),
                },
            ],
          ),
        _ => throw FormatException('Unexpected incoming request: $json'),
      };
}

enum LinkRequestStatus { pending, approved, rejected }

/// A request the caller made. [unread]: decided, and not yet seen - the in-app notification.
class OutgoingLinkRequest {
  final String id;
  final String targetContact;
  final LinkRequestStatus status;
  final bool unread;
  final DateTime createdAt;
  final List<String> linkedDependantNames;

  OutgoingLinkRequest({
    required this.id,
    required this.targetContact,
    required this.status,
    required this.unread,
    required this.createdAt,
    required this.linkedDependantNames,
  });

  factory OutgoingLinkRequest.fromJson(Map<String, dynamic> json) =>
      switch (json) {
        {
          'id': String id,
          'targetContact': String targetContact,
          'status': String status,
          'unread': bool unread,
          'createdAt': String createdAt,
          'linkedDependants': List<dynamic> linked,
        } =>
          OutgoingLinkRequest(
            id: id,
            targetContact: targetContact,
            status: switch (status) {
              'approved' => LinkRequestStatus.approved,
              'rejected' => LinkRequestStatus.rejected,
              _ => LinkRequestStatus.pending,
            },
            unread: unread,
            createdAt: DateTime.parse(createdAt).toLocal(),
            linkedDependantNames: [
              for (final d in linked)
                (d as Map<String, dynamic>)['fullName'] as String,
            ],
          ),
        _ => throw FormatException('Unexpected outgoing request: $json'),
      };
}

class LinkRequests {
  final List<IncomingLinkRequest> incoming;
  final List<OutgoingLinkRequest> outgoing;
  LinkRequests(this.incoming, this.outgoing);

  /// What the bell counts: requests waiting for the caller's answer, and outcomes not yet seen.
  int get attentionCount =>
      incoming.length + outgoing.where((r) => r.unread).length;
}

/// Matches backend/src/routes/familyLinkRequests.ts.
class FamilyLinkRequestsApi {
  final ApiClient _client;
  FamilyLinkRequestsApi(this._client);

  Future<LinkRequests> list() async {
    final json = await _client.get('/family-link-requests');
    return switch (json) {
      {
        'incoming': List<dynamic> incoming,
        'outgoing': List<dynamic> outgoing,
      } =>
        LinkRequests(
          [
            for (final r in incoming)
              IncomingLinkRequest.fromJson(r as Map<String, dynamic>),
          ],
          [
            for (final r in outgoing)
              OutgoingLinkRequest.fromJson(r as Map<String, dynamic>),
          ],
        ),
      _ => throw FormatException('Unexpected link requests: $json'),
    };
  }

  /// [contact]: the primary contact's email, or phone in E.164. The server answers the same way
  /// whether or not it matched anyone.
  Future<void> request({required String contact, String? relationship}) async {
    await _client.post('/family-link-requests', {
      'contact': contact,
      'relationship': ?relationship,
    });
  }

  Future<void> approve(String requestId, List<String> dependantIds) async {
    await _client.post('/family-link-requests/$requestId/approve', {
      'dependantIds': dependantIds,
    });
  }

  Future<void> reject(String requestId) async {
    await _client.post('/family-link-requests/$requestId/reject', const {});
  }

  Future<void> markOutcomesSeen() async {
    await _client.post('/family-link-requests/outcomes/seen', const {});
  }
}
