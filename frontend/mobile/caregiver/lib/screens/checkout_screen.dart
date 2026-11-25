import 'dart:math';
import 'dart:ui' show PathMetric;

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

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

// verification_events.audio_skip_reason (backend/src/db/schema.ts): why there's no recording of
// the dependant, since a dependant is never made to speak.
const _audioSkipReasons = {
  'dependant_declined': 'Dependant preferred not to be recorded',
  'dependant_unwell_or_asleep': 'Dependant unwell or asleep',
  'technical_problem': 'Technical problem',
  'other': 'Other',
};

// verification_events.checkout_override_reason (backend/src/db/schema.ts).
const _overrideReasons = {
  'no_family_member_present': 'No family member is here',
  'family_phone_unavailable': "The family member's phone isn't available",
  'camera_or_code_problem': "The code won't scan or isn't accepted",
  'other': 'Other',
};

// How long a passed check stays on screen before moving on to the family's code.
const _passedPause = Duration(milliseconds: 1800);

enum _Stage { review, voice, confirm }

/// Check-out, in three stages (2026-11-24).
///
/// Review: every unticked task needs a reason (for optional tasks too, per the user's own spec -
/// stricter than the server, which only gates on required ones). Continuing saves the tasks.
///
/// Voice, when the dependant's family consented to recording: the caregiver records the dependant
/// speaking, and the recording is checked against the dependant's voiceprint at once. A pass shows
/// a tick and the score, then moves on by itself. A failed check shows the score with a cross, and
/// the caregiver can record again or continue anyway, since the check is advisory and a supervisor
/// sees the result. A dependant who can't speak is accounted for with a reason instead.
///
/// Confirm: the family member who started the visit shows a check-out code. The caregiver scans
/// it or types its 6 digits. If neither works, they give a reason and check out at once;
/// supervisors see the reason afterwards.
///
/// The check-out request and every completing call send the phone's current location, refused
/// outside the home's radius. A refusal stays on screen above the buttons, since the caregiver has
/// to act on it.
class CheckoutScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;
  final List<VisitTask> tasks;
  final Set<String> checkedTaskIds;

  /// Replaces the recorder in widget tests, where there is no microphone or file system.
  final Widget Function(ValueChanged<bool> onRecordingChanged)? recorderBuilder;

  /// Uploads the recording and returns its check; replaced in widget tests, for the same reason.
  final Future<VoiceCheck?> Function()? uploadRecording;

  /// Replaces the camera view in widget tests, where there is no camera.
  final Widget Function(void Function(String value) onValue)? scannerBuilder;

  const CheckoutScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
    required this.tasks,
    required this.checkedTaskIds,
    this.recorderBuilder,
    this.uploadRecording,
    this.scannerBuilder,
  });

  @override
  State<CheckoutScreen> createState() => _CheckoutScreenState();
}

class _CheckoutScreenState extends State<CheckoutScreen> {
  final _reasons = <String, String>{};
  final _notes = <String, TextEditingController>{};
  final _audioNote = TextEditingController();
  final _code = TextEditingController();
  final _overrideNote = TextEditingController();
  String? _audioSkipReason;
  String? _overrideReason;
  _Stage _stage = _Stage.review;
  bool _scanning = false;
  bool _submitting = false;
  String? _error;

  // Whether the dependant's recording is needed, and whether the server already has one. Assumed
  // needed if the lookup fails, so a slow or failed lookup can't skip the recording; the server
  // has the last word at the check-out request anyway.
  late final Future<({bool required, bool recorded})> _audio;
  bool _alreadyRecorded = false;
  bool _hasRecording = false;
  VoiceCheck? _check;
  // Bumped to give the recorder a fresh state when recording again.
  int _attempt = 0;

  List<VisitTask> get _unchecked => widget.tasks
      .where((t) => !widget.checkedTaskIds.contains(t.careTaskId))
      .toList();

  bool get _tasksAccountedFor =>
      _unchecked.every((t) => _reasons.containsKey(t.careTaskId));

  bool get _skipReasonGiven =>
      _audioSkipReason != null &&
      (_audioSkipReason != 'other' || _audioNote.text.trim().isNotEmpty);

  @override
  void initState() {
    super.initState();
    _audio = widget.visitSchedulesApi
        .dependantAudioRequirement(widget.visit.id)
        .catchError((Object _) => (required: true, recorded: false));
  }

  @override
  void dispose() {
    for (final controller in [
      ..._notes.values,
      _audioNote,
      _code,
      _overrideNote,
    ]) {
      controller.dispose();
    }
    super.dispose();
  }

  // The phone's position now, or null after showing why it isn't available.
  Future<Position?> _position() async {
    final unavailable = await locationUnavailableReason('check out');
    if (unavailable != null) {
      _fail(unavailable);
      return null;
    }
    try {
      return await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 20),
        ),
      );
    } catch (_) {
      _fail(
        "Couldn't get your location - check that location is on and try again.",
      );
      return null;
    }
  }

  void _start() => setState(() {
    _submitting = true;
    _error = null;
  });

  void _fail(String message) {
    if (!mounted) return;
    setState(() {
      _submitting = false;
      _error = message;
    });
  }

  String _messageFor(Object e) => e is ApiException
      ? (e.problem.detail ?? e.problem.title)
      : 'Could not reach the server - try again.';

  // Review -> voice: saves every task, not just the unticked ones, so the server's record is
  // exactly what this screen showed (a tick that failed to save earlier gets another chance here).
  Future<void> _saveTasks() async {
    _start();
    final api = widget.visitSchedulesApi;
    try {
      await Future.wait(
        widget.tasks.map((task) {
          final checked = widget.checkedTaskIds.contains(task.careTaskId);
          final notes = _notes[task.careTaskId]?.text.trim();
          return api.putTask(
            widget.visit.id,
            task.careTaskId,
            status: checked ? 'completed' : 'not_completed',
            reason: checked ? null : _reasons[task.careTaskId],
            notes: checked || notes == null || notes.isEmpty ? null : notes,
          );
        }),
      );
      final audio = await _audio;
      if (!audio.required) return _requestCheckout();
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _alreadyRecorded = audio.recorded;
        _stage = _Stage.voice;
      });
    } catch (e) {
      _fail(_messageFor(e));
    }
  }

  // Uploads the recording, which checks it, and shows the result. A pass moves on by itself.
  Future<void> _checkVoice() async {
    _start();
    try {
      final upload =
          widget.uploadRecording ??
          () => uploadVisitAudio(widget.visitSchedulesApi, widget.visit.id);
      final check = await upload();
      if (!mounted) return;
      if (check == null) {
        return _fail("The recording wasn't found on this phone. Record again.");
      }
      setState(() {
        _submitting = false;
        _check = check;
      });
      if (!check.passed) return;
      await Future<void>.delayed(_passedPause);
      // Unless the caregiver already moved on, or chose to record again.
      if (mounted && _stage == _Stage.voice && identical(_check, check)) {
        await _requestCheckout();
      }
    } catch (_) {
      _fail(
        "Couldn't send the recording. Check your connection and try again, or give a reason "
        'below to check out without it.',
      );
    }
  }

  Future<void> _recordAgain() async {
    await deleteRecording(visitRecordingKey(widget.visit.id));
    if (!mounted) return;
    setState(() {
      _check = null;
      _alreadyRecorded = false;
      _hasRecording = false;
      _error = null;
      _attempt++;
    });
  }

  // Asks the server to check out, which refuses with whatever is still missing, then shows the
  // family's code. [skipReason] accounts for a dependant who wasn't recorded.
  Future<void> _requestCheckout({String? skipReason}) async {
    _start();
    final position = await _position();
    if (position == null) return;
    try {
      final note = _audioNote.text.trim();
      await widget.visitSchedulesApi.requestCheckout(
        widget.visit.id,
        gpsLat: position.latitude,
        gpsLng: position.longitude,
        audioSkipReason: skipReason,
        audioSkipNote: skipReason == null || note.isEmpty ? null : note,
      );
      if (!mounted) return;
      setState(() {
        _submitting = false;
        _error = null;
        _stage = _Stage.confirm;
      });
    } catch (e) {
      _fail(_messageFor(e));
    }
  }

  // Runs one of the three ways to complete check-out, then leaves the visit.
  Future<void> _complete(
    Future<void> Function(double lat, double lng) send,
  ) async {
    _start();
    final position = await _position();
    if (position == null) return;
    try {
      await send(position.latitude, position.longitude);
      await deleteVisitAudio(widget.visit.id);
      await VisitNotifications.showCheckedOut(widget.visit);
      if (!mounted) return;
      Navigator.of(context).popUntil((route) => route.isFirst);
    } catch (e) {
      _fail(_messageFor(e));
    }
  }

  void _onScanned(String token) {
    if (!_scanning) return;
    setState(() => _scanning = false);
    _complete(
      (lat, lng) => widget.visitSchedulesApi.checkoutWithQr(
        widget.visit.id,
        token: token,
        gpsLat: lat,
        gpsLng: lng,
      ),
    );
  }

  void _submitCode() => _complete(
    (lat, lng) => widget.visitSchedulesApi.checkoutWithCode(
      widget.visit.id,
      code: _code.text.trim(),
      gpsLat: lat,
      gpsLng: lng,
    ),
  );

  void _submitOverride() {
    final note = _overrideNote.text.trim();
    _complete(
      (lat, lng) => widget.visitSchedulesApi.checkoutWithOverride(
        widget.visit.id,
        reason: _overrideReason!,
        note: note.isEmpty ? null : note,
        gpsLat: lat,
        gpsLng: lng,
      ),
    );
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
      body: constrainedContent(switch (_stage) {
        _Stage.review => _buildReview(),
        _Stage.voice => _buildVoice(),
        _Stage.confirm => _buildConfirm(),
      }),
      bottomNavigationBar: SafeArea(
        child: constrainedContent(
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (_error case final error?) ...[
                  _ErrorBox(error),
                  const SizedBox(height: 8),
                ],
                ..._bottomButtons(),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _bottomButtons() {
    final busy = _submitting;
    Widget primary(String label, VoidCallback? onPressed) => ElevatedButton(
      onPressed: busy ? null : onPressed,
      style: pillButtonStyle,
      child: busy ? const _Spinner() : Text(label),
    );
    switch (_stage) {
      case _Stage.review:
        return [primary('Continue', _tasksAccountedFor ? _saveTasks : null)];
      case _Stage.voice:
        final check = _check;
        if (check == null && !_alreadyRecorded) {
          return [primary('Check voice', _hasRecording ? _checkVoice : null)];
        }
        return [
          primary('Continue', _requestCheckout),
          if (check == null || !check.passed) ...[
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: busy ? null : _recordAgain,
              style: OutlinedButton.styleFrom(
                foregroundColor: inkDefault,
                minimumSize: const Size.fromHeight(44),
                side: const BorderSide(color: borderColor),
                shape: const RoundedRectangleBorder(),
              ),
              child: const Text('Record again'),
            ),
          ],
        ];
      case _Stage.confirm:
        return const [];
    }
  }

  Widget _buildReview() => ListView(
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
    ],
  );

  Widget _buildVoice() {
    final check = _check;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Padding(
          padding: EdgeInsets.only(left: 4, bottom: 8),
          child: Text(
            "The dependant's voice",
            style: TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w500,
              color: inkSecondary,
            ),
          ),
        ),
        if (check != null)
          _card([_VoiceResult(check)])
        else if (_alreadyRecorded)
          _card([
            _statusRow(
              done: true,
              title: "The dependant's voice was already sent for this visit",
              subtitle: 'Continue, or record again to check it again',
            ),
          ])
        else ...[
          widget.recorderBuilder?.call(_onRecordingChanged) ??
              VisitAudioRecorder(
                key: ValueKey(_attempt),
                storageKey: visitRecordingKey(widget.visit.id),
                label: "The dependant's voice",
                hint:
                    'Ask the dependant an open question and record them answering for at least '
                    '10 seconds. Their family can listen to this.',
                tapToRecord: true,
                onRecordingChanged: _onRecordingChanged,
              ),
          const SizedBox(height: 16),
          _card([
            const ListTile(
              title: Text(
                "The dependant can't speak?",
                style: TextStyle(fontSize: 14),
              ),
              subtitle: Text(
                'Give a reason and continue without a recording. A supervisor sees it.',
                style: TextStyle(fontSize: 12, color: inkTertiary),
              ),
            ),
            _buildAudioReason(),
          ]),
        ],
      ],
    );
  }

  void _onRecordingChanged(bool has) {
    if (mounted) setState(() => _hasRecording = has);
  }

  Widget _buildConfirm() {
    if (_scanning) {
      return Column(
        children: [
          Expanded(
            child:
                widget.scannerBuilder?.call(_onScanned) ??
                MobileScanner(
                  onDetect: (capture) {
                    final value = capture.barcodes.firstOrNull?.rawValue;
                    if (value != null) _onScanned(value);
                  },
                ),
          ),
          TextButton(
            onPressed: () => setState(() => _scanning = false),
            child: const Text('Cancel'),
          ),
        ],
      );
    }
    final busy = _submitting;
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        _card([
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Ask the family member who showed the check-in code to open VerifCare. Their '
              'phone shows a check-out code to scan, with 6 digits underneath.',
              style: TextStyle(fontSize: 14, height: 1.45, color: inkSecondary),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: ElevatedButton.icon(
              onPressed: busy ? null : () => setState(() => _scanning = true),
              style: pillButtonStyle,
              icon: const Icon(Icons.qr_code_scanner),
              label: busy ? const _Spinner() : const Text('Scan the code'),
            ),
          ),
          const Divider(height: 1, color: borderColor),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _code,
                    enabled: !busy,
                    keyboardType: TextInputType.number,
                    maxLength: 6,
                    onChanged: (_) => setState(() {}),
                    decoration: const InputDecoration(
                      labelText: 'Or type the 6 digits',
                      isDense: true,
                      counterText: '',
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                OutlinedButton(
                  onPressed:
                      !busy && RegExp(r'^\d{6}$').hasMatch(_code.text.trim())
                      ? _submitCode
                      : null,
                  child: const Text('Confirm'),
                ),
              ],
            ),
          ),
        ]),
        const SizedBox(height: 16),
        _card([
          const ListTile(
            title: Text(
              "Can't confirm with the family?",
              style: TextStyle(fontSize: 14),
            ),
            subtitle: Text(
              'Give a reason and check out now. A supervisor sees it.',
              style: TextStyle(fontSize: 12, color: inkTertiary),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DropdownButtonFormField<String>(
                  initialValue: _overrideReason,
                  isExpanded: true,
                  decoration: const InputDecoration(
                    labelText: 'Reason',
                    isDense: true,
                  ),
                  items: [
                    for (final entry in _overrideReasons.entries)
                      DropdownMenuItem(
                        value: entry.key,
                        child: Text(entry.value),
                      ),
                  ],
                  onChanged: busy
                      ? null
                      : (value) => setState(() => _overrideReason = value),
                ),
                if (_overrideReason == 'other') ...[
                  const SizedBox(height: 8),
                  TextField(
                    controller: _overrideNote,
                    enabled: !busy,
                    maxLength: 1000,
                    onChanged: (_) => setState(() {}),
                    decoration: const InputDecoration(
                      labelText: 'Details',
                      isDense: true,
                    ),
                  ),
                ],
                const SizedBox(height: 8),
                OutlinedButton(
                  onPressed:
                      !busy &&
                          _overrideReason != null &&
                          (_overrideReason != 'other' ||
                              _overrideNote.text.trim().isNotEmpty)
                      ? _submitOverride
                      : null,
                  child: const Text('Check out without the code'),
                ),
              ],
            ),
          ),
        ]),
      ],
    );
  }

  Widget _buildAudioReason() => Padding(
    padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
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
        const SizedBox(height: 8),
        OutlinedButton(
          onPressed: !_submitting && _skipReasonGiven
              ? () => _requestCheckout(skipReason: _audioSkipReason)
              : null,
          child: const Text('Continue without a recording'),
        ),
      ],
    ),
  );

  Widget _card(List<Widget> children) => Container(
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.zero,
      border: Border.all(color: borderColor),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: children,
    ),
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

class _ErrorBox extends StatelessWidget {
  final String message;
  const _ErrorBox(this.message);

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    color: dangerTint,
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Icon(Icons.error_outline, size: 20, color: dangerRed),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            message,
            style: const TextStyle(
              fontSize: 13,
              height: 1.35,
              color: inkDefault,
            ),
          ),
        ),
      ],
    ),
  );
}

class _Spinner extends StatelessWidget {
  const _Spinner();

  @override
  Widget build(BuildContext context) => const SizedBox(
    width: 20,
    height: 20,
    child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
  );
}

/// The voice check's result, drawn in: a tick for a match, a cross for a failed check, a dash when
/// nothing was compared (no voiceprint, or no consent to voice checks). Then the score.
class _VoiceResult extends StatefulWidget {
  final VoiceCheck check;
  const _VoiceResult(this.check);

  @override
  State<_VoiceResult> createState() => _VoiceResultState();
}

class _VoiceResultState extends State<_VoiceResult>
    with SingleTickerProviderStateMixin {
  late final _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..forward();
  late final _scale = CurvedAnimation(
    parent: _controller,
    curve: const Interval(0, 0.45, curve: Curves.easeOutBack),
  );
  late final _draw = CurvedAnimation(
    parent: _controller,
    curve: const Interval(0.35, 0.85, curve: Curves.easeOut),
  );
  late final _text = CurvedAnimation(
    parent: _controller,
    curve: const Interval(0.6, 1),
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final check = widget.check;
    final mark = check.passed
        ? _Mark.tick
        : (check.notChecked ? _Mark.dash : _Mark.cross);
    final color = switch (mark) {
      _Mark.tick => successGreen,
      _Mark.cross => dangerRed,
      _Mark.dash => inkTertiary,
    };
    final (title, detail) = switch (check.result) {
      'match' => ('Voice matches', "Moving on to the family's code."),
      'mismatch' => (
        "Voice doesn't match",
        'Record again, closer to the dependant and away from noise, or continue. A '
            'supervisor sees this result.',
      ),
      'too_short' => (
        'Not enough speech to check',
        'Record again with the dependant speaking for longer, or continue.',
      ),
      'not_enrolled' => (
        'Recorded, not checked',
        "The dependant's family hasn't recorded their voiceprint yet.",
      ),
      'no_consent' => (
        'Recorded, not checked',
        "The dependant's family hasn't agreed to voice checks.",
      ),
      _ => (
        "The voice check isn't available",
        'The recording is saved. Record again to retry the check, or continue.',
      ),
    };
    final score = check.score;
    final threshold = check.threshold;
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 28, 16, 24),
      child: Column(
        children: [
          ScaleTransition(
            scale: _scale,
            child: Container(
              width: 88,
              height: 88,
              color: color,
              child: AnimatedBuilder(
                animation: _draw,
                builder: (context, _) =>
                    CustomPaint(painter: _MarkPainter(mark, _draw.value)),
              ),
            ),
          ),
          const SizedBox(height: 20),
          FadeTransition(
            opacity: _text,
            child: Semantics(
              liveRegion: true,
              child: Column(
                children: [
                  Text(
                    title,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                      color: inkDefault,
                    ),
                  ),
                  if (score != null) ...[
                    const SizedBox(height: 6),
                    Text(
                      check.passed || threshold == null
                          ? 'Match score ${score.toStringAsFixed(2)}'
                          : 'Match score ${score.toStringAsFixed(2)}, needs '
                                '${threshold.toStringAsFixed(2)}',
                      style: TextStyle(
                        fontSize: 15,
                        color: color,
                        fontWeight: FontWeight.w500,
                        fontFeatures: const [FontFeature.tabularFigures()],
                      ),
                    ),
                  ],
                  const SizedBox(height: 10),
                  Text(
                    detail,
                    textAlign: TextAlign.center,
                    style: const TextStyle(
                      fontSize: 13,
                      height: 1.4,
                      color: inkSecondary,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

enum _Mark { tick, cross, dash }

/// Draws [mark] in white, the first [progress] (0 to 1) of its strokes.
class _MarkPainter extends CustomPainter {
  final _Mark mark;
  final double progress;
  const _MarkPainter(this.mark, this.progress);

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final strokes = switch (mark) {
      _Mark.tick => [
        Path()
          ..moveTo(w * 0.26, h * 0.52)
          ..lineTo(w * 0.43, h * 0.68)
          ..lineTo(w * 0.75, h * 0.34),
      ],
      _Mark.cross => [
        Path()
          ..moveTo(w * 0.32, h * 0.32)
          ..lineTo(w * 0.68, h * 0.68),
        Path()
          ..moveTo(w * 0.68, h * 0.32)
          ..lineTo(w * 0.32, h * 0.68),
      ],
      _Mark.dash => [
        Path()
          ..moveTo(w * 0.3, h * 0.5)
          ..lineTo(w * 0.7, h * 0.5),
      ],
    };
    final paint = Paint()
      ..color = Colors.white
      ..style = PaintingStyle.stroke
      ..strokeWidth = max(4, w * 0.08)
      ..strokeCap = StrokeCap.square
      ..strokeJoin = StrokeJoin.miter;
    // Each stroke gets an equal share of the progress, drawn one after the other.
    for (final (i, stroke) in strokes.indexed) {
      final share = ((progress * strokes.length) - i).clamp(0.0, 1.0);
      if (share == 0) continue;
      for (final PathMetric metric in stroke.computeMetrics()) {
        canvas.drawPath(metric.extractPath(0, metric.length * share), paint);
      }
    }
  }

  @override
  bool shouldRepaint(_MarkPainter old) =>
      old.progress != progress || old.mark != mark;
}
