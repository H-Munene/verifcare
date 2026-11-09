import 'dart:async';

import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../visit_notifications.dart';

/// A request to cover a nearby late visit, shown above every tab while one is open. Asks the server
/// while the app is in use.
///
/// The ceiling: with the app closed nobody hears about an offer, so it expires and passes to the
/// next caregiver. Reaching a closed app needs server push or SMS, which is future work.
class RecoveryOfferBanner extends StatefulWidget {
  final VisitSchedulesApi api;

  /// A visit was accepted, so the visit lists need reloading.
  final VoidCallback onAccepted;

  const RecoveryOfferBanner({
    super.key,
    required this.api,
    required this.onAccepted,
  });

  @override
  State<RecoveryOfferBanner> createState() => _RecoveryOfferBannerState();
}

class _RecoveryOfferBannerState extends State<RecoveryOfferBanner> {
  static const _pollEvery = Duration(seconds: 30);

  RecoveryOffer? _offer;
  String? _notifiedId;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _check();
    _timer = Timer.periodic(_pollEvery, (_) => _check());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _check() async {
    final RecoveryOffer? offer;
    try {
      offer = (await widget.api.myRecoveryOffers()).firstOrNull;
    } catch (_) {
      return; // The next check will try again; a banner isn't worth an error.
    }
    if (!mounted) return;
    setState(() => _offer = offer);
    if (offer != null && offer.id != _notifiedId) {
      _notifiedId = offer.id;
      try {
        await VisitNotifications.showCoverOffer(offer.ward);
      } catch (_) {
        // The banner is already on screen.
      }
    }
  }

  Future<void> _open(RecoveryOffer offer) async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      backgroundColor: Colors.white,
      builder: (_) => RecoveryOfferSheet(
        offer: offer,
        api: widget.api,
        onDone: (accepted) {
          setState(() => _offer = null);
          if (accepted) widget.onAccepted();
          _check();
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final offer = _offer;
    if (offer == null) return const SizedBox.shrink();
    return Material(
      color: const Color(0xFF8A5A00),
      child: InkWell(
        onTap: () => _open(offer),
        child: SafeArea(
          bottom: false,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
            child: Row(
              children: [
                const Icon(
                  Icons.handshake_outlined,
                  color: Colors.white,
                  size: 20,
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Can you cover a visit nearby?',
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: 14,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      Text(
                        offer.ward == null
                            ? 'Tap to see details'
                            : '${offer.ward} - tap to see details',
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 12,
                        ),
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ),
                ),
                const Icon(Icons.chevron_right, color: Colors.white),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class RecoveryOfferSheet extends StatefulWidget {
  final RecoveryOffer offer;
  final VisitSchedulesApi api;
  final void Function(bool accepted) onDone;

  const RecoveryOfferSheet({
    super.key,
    required this.offer,
    required this.api,
    required this.onDone,
  });

  @override
  State<RecoveryOfferSheet> createState() => _RecoveryOfferSheetState();
}

class _RecoveryOfferSheetState extends State<RecoveryOfferSheet> {
  bool _busy = false;
  String? _error;

  Future<void> _respond(bool accept) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await (accept
          ? widget.api.acceptRecoveryOffer(widget.offer.id)
          : widget.api.declineRecoveryOffer(widget.offer.id));
      if (!mounted) return;
      Navigator.of(context).pop();
      widget.onDone(accept);
      if (accept) {
        showSnack(context, "It's on your schedule now.", error: false);
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = e.problem.detail ?? e.problem.title;
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = 'Could not reach the server. Try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final offer = widget.offer;
    String time(DateTime t) => TimeOfDay.fromDateTime(t).format(context);
    return SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Cover a visit',
              style: TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w600,
                color: inkDefault,
              ),
            ),
            const SizedBox(height: 4),
            const Text(
              "Another caregiver hasn't arrived. You'll see the name and address if you accept.",
              style: TextStyle(fontSize: 14, height: 1.4, color: inkSecondary),
            ),
            const SizedBox(height: 16),
            _fact('Area', offer.ward ?? 'Not recorded'),
            _fact(
              'Time',
              '${time(offer.proposedStart)} - ${time(offer.proposedEnd)}',
            ),
            _fact(
              'Distance',
              '${(offer.distanceMeters / 1000).toStringAsFixed(1)} km away',
            ),
            _fact('Answer by', time(offer.expiresAt)),
            if (_error case final message?) ...[
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.all(12),
                color: dangerTint,
                child: Text(
                  message,
                  style: const TextStyle(fontSize: 13, color: inkDefault),
                ),
              ),
            ],
            const SizedBox(height: 16),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: _busy ? null : () => _respond(false),
                    style: OutlinedButton.styleFrom(
                      minimumSize: const Size.fromHeight(44),
                    ),
                    child: const Text('Decline'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: ElevatedButton(
                    onPressed: _busy ? null : () => _respond(true),
                    style: pillButtonStyle,
                    child: const Text('Accept'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _fact(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Row(
      children: [
        SizedBox(
          width: 88,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13, color: inkTertiary),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: inkDefault,
            ),
          ),
        ),
      ],
    ),
  );
}
