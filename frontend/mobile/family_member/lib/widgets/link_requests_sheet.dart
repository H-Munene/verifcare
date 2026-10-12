import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/family_link_requests_api.dart';
import '../app_ui.dart';

/// The bell's bottom sheet (2026-09-26, user request): requests waiting for the caller's answer as
/// a primary contact, and the caller's own requests with their outcome. Opening it marks the
/// caller's decided requests as seen, which is what clears the bell's count for them.
Future<void> showLinkRequestsSheet(
  BuildContext context, {
  required FamilyLinkRequestsApi linkRequestsApi,
  required VoidCallback onJoinFamily,
  required VoidCallback onChanged,
}) => showModalBottomSheet<void>(
  context: context,
  isScrollControlled: true,
  showDragHandle: true,
  backgroundColor: Colors.white,
  builder: (_) => DraggableScrollableSheet(
    expand: false,
    initialChildSize: 0.7,
    maxChildSize: 0.95,
    builder: (context, scrollController) => _LinkRequestsSheet(
      linkRequestsApi: linkRequestsApi,
      scrollController: scrollController,
      onJoinFamily: onJoinFamily,
      onChanged: onChanged,
    ),
  ),
);

class _LinkRequestsSheet extends StatefulWidget {
  final FamilyLinkRequestsApi linkRequestsApi;
  final ScrollController scrollController;
  final VoidCallback onJoinFamily;
  final VoidCallback onChanged;

  const _LinkRequestsSheet({
    required this.linkRequestsApi,
    required this.scrollController,
    required this.onJoinFamily,
    required this.onChanged,
  });

  @override
  State<_LinkRequestsSheet> createState() => _LinkRequestsSheetState();
}

class _LinkRequestsSheetState extends State<_LinkRequestsSheet> {
  LinkRequests? _requests;
  String? _error;
  // Incoming request id -> the dependants ticked for it.
  final _selected = <String, Set<String>>{};
  final _busy = <String>{};

  @override
  void initState() {
    super.initState();
    _load(markSeen: true);
  }

  Future<void> _load({bool markSeen = false}) async {
    setState(() => _error = null);
    try {
      final requests = await widget.linkRequestsApi.list();
      if (!mounted) return;
      setState(() {
        _requests = requests;
        for (final request in requests.incoming) {
          final choosable = request.dependants.where((d) => !d.alreadyLinked);
          // With only one dependant to choose, it's already ticked.
          _selected.putIfAbsent(
            request.id,
            () => choosable.length == 1 ? {choosable.single.id} : <String>{},
          );
        }
      });
      if (markSeen && requests.outgoing.any((r) => r.unread)) {
        // Shown now, so no longer unread - the highlight stays for this viewing.
        await widget.linkRequestsApi.markOutcomesSeen();
        widget.onChanged();
      }
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    }
  }

  Future<void> _answer(
    IncomingLinkRequest request, {
    required bool approve,
  }) async {
    setState(() => _busy.add(request.id));
    try {
      if (approve) {
        await widget.linkRequestsApi.approve(
          request.id,
          _selected[request.id]!.toList(),
        );
      } else {
        await widget.linkRequestsApi.reject(request.id);
      }
      if (!mounted) return;
      showSnack(
        context,
        approve
            ? '${request.requesterName} is now linked.'
            : "${request.requesterName}'s request was declined.",
        error: false,
      );
      widget.onChanged();
      await _load();
    } on ApiException catch (e) {
      if (mounted) showSnack(context, e.problem.detail ?? e.problem.title);
      await _load();
    } catch (e) {
      if (mounted) showSnack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _busy.remove(request.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final requests = _requests;
    return ListView(
      controller: widget.scrollController,
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
      children: [
        const Text(
          'Family requests',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: inkDefault,
          ),
        ),
        const SizedBox(height: 12),
        if (_error case final error?) ...[
          Text(error, style: const TextStyle(color: inkSecondary)),
          TextButton(onPressed: _load, child: const Text('Retry')),
        ] else if (requests == null)
          const Padding(
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          )
        else ...[
          if (requests.incoming.isEmpty && requests.outgoing.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 8),
              child: Text(
                'No requests yet.',
                style: TextStyle(color: inkTertiary),
              ),
            ),
          if (requests.incoming.isNotEmpty) ...[
            const _SectionLabel('Asking you to link them'),
            for (final request in requests.incoming) _incomingCard(request),
          ],
          if (requests.outgoing.isNotEmpty) ...[
            const _SectionLabel('Your requests'),
            for (final request in requests.outgoing) _OutgoingTile(request),
          ],
        ],
        const SizedBox(height: 8),
        OutlinedButton.icon(
          onPressed: widget.onJoinFamily,
          icon: const Icon(Icons.group_add_outlined),
          label: const Text('Ask to join a family'),
        ),
      ],
    );
  }

  Widget _incomingCard(IncomingLinkRequest request) {
    final selected = _selected[request.id] ?? {};
    final busy = _busy.contains(request.id);
    final contact = [
      ?request.requesterEmail,
      ?request.requesterPhone,
    ].join(' · ');
    final choosable = request.dependants
        .where((d) => !d.alreadyLinked)
        .isNotEmpty;
    return Container(
      margin: const EdgeInsets.only(bottom: 12),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.zero,
        border: Border.all(color: borderColor),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            request.requesterName,
            style: const TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w500,
              color: inkDefault,
            ),
          ),
          if (request.relationship case final relationship?)
            Text(
              relationship,
              style: const TextStyle(fontSize: 13, color: inkSecondary),
            ),
          if (contact.isNotEmpty)
            SelectableText(
              contact,
              style: const TextStyle(fontSize: 12, color: inkTertiary),
            ),
          const SizedBox(height: 8),
          Text(
            choosable
                ? 'Link them to:'
                : 'Already linked to all your dependants.',
            style: const TextStyle(fontSize: 13, color: inkSecondary),
          ),
          for (final dependant in request.dependants)
            CheckboxListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              controlAffinity: ListTileControlAffinity.leading,
              title: Text(dependant.fullName),
              subtitle: dependant.alreadyLinked
                  ? const Text('Already linked')
                  : null,
              value: dependant.alreadyLinked || selected.contains(dependant.id),
              onChanged: dependant.alreadyLinked || busy
                  ? null
                  : (ticked) => setState(() {
                      final set = _selected.putIfAbsent(request.id, () => {});
                      ticked == true
                          ? set.add(dependant.id)
                          : set.remove(dependant.id);
                    }),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              Expanded(
                child: OutlinedButton(
                  onPressed: busy
                      ? null
                      : () => _answer(request, approve: false),
                  child: const Text('Decline'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ElevatedButton(
                  onPressed: busy || selected.isEmpty
                      ? null
                      : () => _answer(request, approve: true),
                  style: pillButtonStyle,
                  child: const Text('Approve'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 4, bottom: 8),
    child: Text(
      text,
      style: const TextStyle(
        fontSize: 13,
        fontWeight: FontWeight.w500,
        color: inkTertiary,
      ),
    ),
  );
}

class _OutgoingTile extends StatelessWidget {
  final OutgoingLinkRequest request;
  const _OutgoingTile(this.request);

  @override
  Widget build(BuildContext context) {
    final (String status, Color color) = switch (request.status) {
      LinkRequestStatus.pending => ('Waiting for an answer', inkTertiary),
      LinkRequestStatus.approved => (
        request.linkedDependantNames.isEmpty
            ? 'Approved'
            : "Approved - you're now linked to ${request.linkedDependantNames.join(', ')}",
        successGreen,
      ),
      LinkRequestStatus.rejected => ('Your request was declined', dangerRed),
    };
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(
        request.unread
            ? Icons.notifications_active_outlined
            : Icons.outgoing_mail,
        color: request.unread ? primaryGreen : inkTertiary,
      ),
      title: Text(
        'To ${request.targetContact}',
        style: TextStyle(
          fontSize: 14,
          fontWeight: request.unread ? FontWeight.w600 : FontWeight.normal,
        ),
      ),
      subtitle: Text(status, style: TextStyle(fontSize: 13, color: color)),
    );
  }
}
