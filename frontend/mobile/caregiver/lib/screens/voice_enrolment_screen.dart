import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/voice_enrollment_api.dart';
import '../app_ui.dart';
import '../widgets/visit_audio_recorder.dart';

const _storageKey = 'voice-enrolment';

/// Records about 30 seconds of the caregiver speaking naturally, which becomes the voiceprint
/// their visit recordings are checked against. Recording again replaces it. Pops true once saved.
class VoiceEnrolmentScreen extends StatefulWidget {
  final VoiceEnrollmentApi api;

  const VoiceEnrolmentScreen({super.key, required this.api});

  @override
  State<VoiceEnrolmentScreen> createState() => _VoiceEnrolmentScreenState();
}

class _VoiceEnrolmentScreenState extends State<VoiceEnrolmentScreen> {
  DateTime? _enrolledAt;
  bool _hasRecording = false;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    widget.api.enrolledAt().then((at) {
      if (mounted) setState(() => _enrolledAt = at);
    }, onError: (_) {});
  }

  Future<void> _save() async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      final recording = await readRecording(_storageKey);
      if (recording == null) {
        return;
      }
      await widget.api.enrol(recording.bytes);
      await deleteRecording(_storageKey);
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.problem.detail ?? e.problem.title);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Could not reach the server - try again.');
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final enrolledAt = _enrolledAt;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Your voice', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              enrolledAt == null
                  ? 'Each visit, you record your voice. It is checked against a voiceprint made '
                        'once from this recording.'
                  : 'Your voice was recorded on ${MaterialLocalizations.of(context).formatMediumDate(enrolledAt)}. '
                        'Recording again replaces it.',
              style: const TextStyle(
                fontSize: 14,
                height: 1.45,
                color: inkSecondary,
              ),
            ),
            const SizedBox(height: 8),
            const Text(
              'In a quiet place, speak naturally for about 30 seconds, for example about your '
              'day or your work. Only the voiceprint is kept; the recording is deleted.',
              style: TextStyle(fontSize: 14, height: 1.45, color: inkSecondary),
            ),
            const SizedBox(height: 16),
            VisitAudioRecorder(
              storageKey: _storageKey,
              label: 'Your voice',
              hint:
                  'Tap the button, speak for about 30 seconds, then tap it again.',
              minDuration: const Duration(seconds: 25),
              maxDuration: const Duration(seconds: 40),
              tapToRecord: true,
              onRecordingChanged: (has) => setState(() => _hasRecording = has),
            ),
          ],
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: constrainedContent(
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error case final error?) ...[
                  Text(
                    error,
                    style: const TextStyle(fontSize: 13, color: dangerRed),
                  ),
                  const SizedBox(height: 8),
                ],
                ElevatedButton(
                  onPressed: _hasRecording && !_saving ? _save : null,
                  style: pillButtonStyle,
                  child: _saving
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text('Save my voice'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Shown across the app until the caregiver has enrolled, since their visit recordings can't be
/// checked without it. Opens the enrolment screen.
class VoiceEnrolmentBanner extends StatefulWidget {
  final VoiceEnrollmentApi api;

  const VoiceEnrolmentBanner({super.key, required this.api});

  @override
  State<VoiceEnrolmentBanner> createState() => _VoiceEnrolmentBannerState();
}

class _VoiceEnrolmentBannerState extends State<VoiceEnrolmentBanner> {
  // Hidden until the server says there's no enrolment, so a failed lookup never nags.
  bool _show = false;

  @override
  void initState() {
    super.initState();
    widget.api.enrolledAt().then((at) {
      if (mounted) setState(() => _show = at == null);
    }, onError: (_) {});
  }

  Future<void> _open() async {
    final saved = await Navigator.of(context).push<bool>(
      MaterialPageRoute(builder: (_) => VoiceEnrolmentScreen(api: widget.api)),
    );
    if (saved == true && mounted) setState(() => _show = false);
  }

  @override
  Widget build(BuildContext context) {
    if (!_show) return const SizedBox.shrink();
    return SafeArea(
      bottom: false,
      child: Material(
        color: primaryTint,
        child: ListTile(
          leading: const Icon(
            Icons.record_voice_over_outlined,
            color: primaryGreen,
          ),
          title: const Text(
            'Record your voice',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: inkDefault,
            ),
          ),
          subtitle: const Text(
            'Needed once, so your visit recordings can be checked.',
            style: TextStyle(fontSize: 12, color: inkSecondary),
          ),
          trailing: const Icon(Icons.chevron_right, color: inkTertiary),
          onTap: _open,
        ),
      ),
    );
  }
}
