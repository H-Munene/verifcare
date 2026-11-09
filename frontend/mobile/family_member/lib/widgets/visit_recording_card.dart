import 'dart:async';

import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';

/// Matches the server's AUDIO_RETENTION_DAYS, which matches the bucket's lifecycle rule.
const recordingRetention = Duration(days: 90);

String describeAudioSkipReason(String reason) => switch (reason) {
  'dependant_declined' => 'They preferred not to be recorded.',
  'dependant_unwell_or_asleep' => 'They were unwell or asleep.',
  'technical_problem' => 'There was a technical problem.',
  _ => 'Other reason.',
};

/// The visit's recording, or why there isn't one. Nothing is fetched until Play, since each
/// playback link is logged as someone listening.
class VisitRecordingCard extends StatefulWidget {
  final String visitScheduleId;
  final VerificationAudit audit;
  final VisitSchedulesApi visitSchedulesApi;

  const VisitRecordingCard({
    super.key,
    required this.visitScheduleId,
    required this.audit,
    required this.visitSchedulesApi,
  });

  @override
  State<VisitRecordingCard> createState() => _VisitRecordingCardState();
}

class _VisitRecordingCardState extends State<VisitRecordingCard> {
  AudioPlayer? _player;
  final _subscriptions = <StreamSubscription<Object?>>[];
  bool _loading = false;
  bool _playing = false;
  bool _gone = false;
  String? _error;

  @override
  void dispose() {
    for (final subscription in _subscriptions) {
      subscription.cancel();
    }
    _player?.dispose();
    super.dispose();
  }

  Future<void> _toggle() async {
    if (_player case final player?) {
      await (_playing ? player.pause() : player.resume());
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final url = await widget.visitSchedulesApi.getRecordingUrl(widget.visitScheduleId);
      final player = AudioPlayer();
      _player = player;
      _subscriptions.add(
        player.onPlayerStateChanged.listen((state) {
          if (mounted) setState(() => _playing = state == PlayerState.playing);
        }),
      );
      await player.setReleaseMode(ReleaseMode.stop);
      await player.play(UrlSource(url));
    } on ApiException catch (e) {
      if (mounted) {
        setState(() {
          _gone = e.problem.status == 410;
          _error = e.problem.detail ?? e.problem.title;
        });
      }
    } catch (_) {
      _player?.dispose();
      _player = null;
      if (mounted) setState(() => _error = "Couldn't play the recording. Try again.");
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final audit = widget.audit;
    final recordedAt = audit.audioRecordedAt;
    final expired =
        _gone || (recordedAt != null && DateTime.now().isAfter(recordedAt.add(recordingRetention)));

    final Widget body;
    if (recordedAt != null && !expired) {
      final seconds = audit.audioDurationSeconds;
      body = Row(
        children: [
          Material(
            color: primaryGreen,
            child: InkWell(
              onTap: _loading ? null : _toggle,
              child: SizedBox(
                width: 48,
                height: 48,
                child: _loading
                    ? const Padding(
                        padding: EdgeInsets.all(14),
                        child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                      )
                    : Icon(
                        _playing ? Icons.pause : Icons.play_arrow,
                        color: Colors.white,
                        semanticLabel: _playing ? 'Pause recording' : 'Play recording',
                      ),
              ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'Listen to the visit',
                  style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500, color: inkDefault),
                ),
                Text(
                  seconds == null ? 'Recorded during the visit' : '$seconds seconds',
                  style: const TextStyle(fontSize: 12, color: inkTertiary),
                ),
                if (_error case final message?)
                  Text(message, style: const TextStyle(fontSize: 12, color: dangerRed)),
              ],
            ),
          ),
        ],
      );
    } else if (expired) {
      body = const Text(
        'Recording expired. Recordings are kept for 90 days.',
        style: TextStyle(fontSize: 14, color: inkSecondary),
      );
    } else if (audit.audioSkipReason case final reason?) {
      final note = audit.audioSkipNote;
      body = Text(
        'No recording. ${describeAudioSkipReason(reason)}${note == null ? '' : ' $note'}',
        style: const TextStyle(fontSize: 14, height: 1.4, color: inkSecondary),
      );
    } else {
      return const SizedBox.shrink();
    }
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Colors.white,
        border: Border.all(color: borderColor),
      ),
      child: body,
    );
  }
}
