import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../location.dart';
import '../visit_notifications.dart';
import '../widgets/visit_audio_recorder.dart';

// visit_task_completions.reason's enum (backend/src/db/schema.ts taskSkipReasonEnum).
const _skipReasons = {
  'client_declined': 'Client declined',
  'client_unavailable': 'Client unavailable',
  'equipment_unavailable': 'Equipment unavailable',
  'other': 'Other',
};

// verification_events.audio_skip_reason (backend/src/db/schema.ts).
const _audioSkipReasons = {
  'dependant_declined': 'Dependant preferred not to be recorded',
  'dependant_unwell_or_asleep': 'Dependant unwell or asleep',
  'technical_problem': 'Technical problem',
  'other': 'Other',
};

/// Review before checkout: every unticked task needs a reason before the button enables (for
/// optional tasks too, per the user's own spec - stricter than the server, which only gates on
/// required ones). A visit whose family consented to audio needs a recording, or a reason for not
/// having one: a dependant must never be made to speak.
///
/// Checkout sends the phone's current location, and the server refuses it outside the dependant's
/// home radius; that refusal (or any other failure) stays on screen above the button rather than
/// in a passing snackbar, since the caregiver has to act on it (walk back to the home) before
/// trying again.
class CheckoutScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;
  final List<VisitTask> tasks;
  final Set<String> checkedTaskIds;
  final bool hasRecording;
  final bool audioRequired;

  /// The server already holds this visit's recording, so there's nothing more to upload.
  final bool alreadyUploaded;

  const CheckoutScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
    required this.tasks,
    required this.checkedTaskIds,
    required this.hasRecording,
    required this.audioRequired,
    this.alreadyUploaded = false,
  });

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _reasons = <String, String>{};
  final _notes = <String, TextEditingController>{};
  final _audioNote = TextEditingController();
  String? _audioSkipReason;
  bool _uploadFailed = false;
  bool _submitting = false;
  String? _error;

  List<VisitTask> get _unchecked => widget.tasks
      .where((t) => !widget.checkedTaskIds.contains(t.careTaskId))
      .toList();

  bool get _hasAudio => widget.hasRecording || widget.alreadyUploaded;

  // Also shown after a failed upload, so a dead connection can't trap someone at the door.
  bool get _showAudioReason =>
      widget.audioRequired && (!_hasAudio || _uploadFailed);

  bool get _audioAccountedFor {
    if (!widget.audioRequired || (_hasAudio && _audioSkipReason == null)) {
      return true;
    }
    return _audioSkipReason != null &&
        (_audioSkipReason != 'other' || _audioNote.text.trim().isNotEmpty);
  }

  bool get _canSubmit =>
      !_submitting &&
      _audioAccountedFor &&
      _unchecked.every((t) => _reasons.containsKey(t.careTaskId));

  @override
  void dispose() {
    for (final controller in _notes.values) {
      controller.dispose();
    }
    _audioNote.dispose();
    super.dispose();
  }

  Future<void> _checkout() async {
    setState(() {
      _submitting = true;
      _error = null;
    });
    // Location first: without it checkout can't succeed, so there's no point saving tasks before
    // finding that out.
    final unavailable = await locationUnavailableReason('check out');
    if (unavailable != null) return _fail(unavailable);
    final Position position;
    try {
      position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );
    } catch (_) {
      return _fail(
        "Couldn't get your location - check that location is on and try again.",
      );
    }
    try {
      // Re-save every task, not just the unticked ones, so the server's record is exactly what
      // this screen showed (a tick that failed to save earlier gets another chance here).
      await Future.wait(
        widget.tasks.map((task) {
          final checked = widget.checkedTaskIds.contains(task.careTaskId);
          final notes = _notes[task.careTaskId]?.text.trim();
          return widget.visitSchedulesApi.putTask(
            widget.visit.id,
            task.careTaskId,
            status: checked ? 'completed' : 'not_completed',
            reason: checked ? null : _reasons[task.careTaskId],
            notes: checked || notes == null || notes.isEmpty ? null : notes,
          );
        }),
      );
      // A reason chosen after a failed upload means going without the recording.
      final skip = widget.audioRequired ? _audioSkipReason : null;
      if (skip == null && widget.audioRequired && widget.hasRecording) {
        try {
          await uploadVisitAudio(widget.visitSchedulesApi, widget.visit.id);
        } catch (_) {
          if (mounted) setState(() => _uploadFailed = true);
          return _fail(
            "Couldn't upload the recording. Try again, or choose a reason below to check out "
            'without it.',
          );
        }
      }
      final note = _audioNote.text.trim();
      await widget.visitSchedulesApi.checkout(
        widget.visit.id,
        gpsLat: position.latitude,
        gpsLng: position.longitude,
        audioSkipReason: skip,
        audioSkipNote: skip == null || note.isEmpty ? null : note,
      );
      await deleteVisitAudio(widget.visit.id);
      await VisitNotifications.showCheckedOut(widget.visit);
      if (!mounted) return;
      Navigator.of(context).popUntil((route) => route.isFirst);
    } catch (e) {
      _fail(
        e is ApiException
            ? (e.problem.detail ?? e.problem.title)
            : 'Could not reach the server - try again.',
      );
    }
  }

  void _fail(String message) {
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _error = message;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Check out', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(16),
          children: [
            _card([
              for (final (i, task) in widget.tasks.indexed) ...[
                if (i > 0) const Divider(height: 1, color: borderColor),
                _buildTaskRow(task),
              ],
              if (widget.tasks.isEmpty)
                const Padding(
                  padding: EdgeInsets.all(16),
                  child: Text(
                    'No care-plan tasks for this visit.',
                    style: TextStyle(color: inkTertiary),
                  ),
                ),
            ]),
            if (widget.audioRequired) ...[
              const SizedBox(height: 16),
              _card([
                _statusRow(
                  done: _hasAudio,
                  title: _hasAudio ? 'Recording ready' : 'No recording',
                  subtitle: _hasAudio
                      ? "Saved at check-out for the dependant's family to listen to"
                      : 'Go back to record, or give a reason below',
                ),
                if (_showAudioReason) _buildAudioReason(),
              ]),
            ],
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
                  Container(
                    padding: const EdgeInsets.all(12),
                    decoration: BoxDecoration(
                      color: dangerTint,
                      borderRadius: BorderRadius.zero,
                    ),
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Icon(
                          Icons.error_outline,
                          size: 20,
                          color: dangerRed,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            error,
                            style: const TextStyle(
                              fontSize: 13,
                              height: 1.35,
                              color: inkDefault,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
                ElevatedButton(
                  onPressed: _canSubmit ? _checkout : null,
                  style: pillButtonStyle,
                  child: _submitting
                      ? const SizedBox(
                          width: 20,
                          height: 20,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : const Text('Check out'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildAudioReason() => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
    child: Column(
      children: [
        DropdownButtonFormField<String>(
          initialValue: _audioSkipReason,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: 'Reason for no recording',
            isDense: true,
          ),
          items: [
            for (final entry in _audioSkipReasons.entries)
              DropdownMenuItem(value: entry.key, child: Text(entry.value)),
          ],
          onChanged: _submitting
              ? null
              : (value) => setState(() => _audioSkipReason = value),
        ),
        if (_audioSkipReason == 'other') ...[
          const SizedBox(height: 8),
          TextField(
            controller: _audioNote,
            enabled: !_submitting,
            maxLength: 500,
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Details',
              isDense: true,
            ),
          ),
        ],
      ],
    ),
  );

  Widget _card(List<Widget> children) => Container(
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.zero,
      border: Border.all(color: borderColor),
    ),
    child: Column(children: children),
  );

  Widget _statusRow({
    required bool done,
    required String title,
    String? subtitle,
  }) => ListTile(
    leading: Icon(
      done ? Icons.check_circle : Icons.cancel,
      color: done ? successGreen : dangerRed,
    ),
    title: Text(title, style: const TextStyle(fontSize: 14)),
    subtitle: subtitle == null
        ? null
        : Text(
            subtitle,
            style: const TextStyle(fontSize: 12, color: inkTertiary),
          ),
  );

  Widget _buildTaskRow(VisitTask task) {
    final checked = widget.checkedTaskIds.contains(task.careTaskId);
    if (checked) return _statusRow(done: true, title: task.title);

    final reason = _reasons[task.careTaskId];
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Column(
        children: [
          _statusRow(done: false, title: task.title),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: DropdownButtonFormField<String>(
              initialValue: reason,
              decoration: const InputDecoration(
                labelText: 'Reason not done',
                isDense: true,
              ),
              items: [
                for (final entry in _skipReasons.entries)
                  DropdownMenuItem(value: entry.key, child: Text(entry.value)),
              ],
              onChanged: _submitting
                  ? null
                  : (value) =>
                        setState(() => _reasons[task.careTaskId] = value!),
            ),
          ),
          if (reason == 'other')
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: TextField(
                controller: _notes.putIfAbsent(
                  task.careTaskId,
                  TextEditingController.new,
                ),
                enabled: !_submitting,
                decoration: const InputDecoration(
                  labelText: 'Details (optional)',
                  isDense: true,
                ),
              ),
            ),
        ],
      ),
    );
  }
}
