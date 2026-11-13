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
// the dependant. Their recording can be replaced by a reason; the caregiver's own can't.
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

enum _Stage { review, confirm }

/// Check-out, in two stages.
///
/// Review: every unticked task needs a reason (for optional tasks too, per the user's own spec -
/// stricter than the server, which only gates on required ones). The caregiver's own recording is
/// required; the dependant's can be replaced by a reason, since a dependant is never made to speak.
/// Checking out saves the tasks, uploads the recordings (which checks each voice) and asks the
/// server to check out, which it refuses with what's still missing.
///
/// Confirm: the family member who started the visit shows a check-out code. The caregiver scans
/// it or types its 6 digits. If neither works, they give a reason and check out at once;
/// supervisors see the reason afterwards.
///
/// Every server call sends the phone's current location, refused outside the home's radius. A
/// refusal stays on screen above the buttons, since the caregiver has to act on it.
class CheckoutScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;
  final List<VisitTask> tasks;
  final Set<String> checkedTaskIds;

  /// Per recording role ('caregiver', 'dependant').
  final Map<String, bool> hasRecording;
  final Map<String, bool> audioRequired;

  /// The server already holds that role's recording, so there's nothing more to upload.
  final Map<String, bool> alreadyUploaded;

  /// Replaces the camera view in widget tests, where there is no camera.
  final Widget Function(void Function(String value) onValue)? scannerBuilder;

  const CheckoutScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
    required this.tasks,
    required this.checkedTaskIds,
    required this.hasRecording,
    required this.audioRequired,
    this.alreadyUploaded = const {},
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

  List<VisitTask> get _unchecked => widget.tasks
      .where((t) => !widget.checkedTaskIds.contains(t.careTaskId))
      .toList();

  bool _required(String role) => widget.audioRequired[role] ?? false;
  bool _hasAudio(String role) =>
      (widget.hasRecording[role] ?? false) ||
      (widget.alreadyUploaded[role] ?? false);

  bool get _dependantAccountedFor {
    if (!_required('dependant') || _hasAudio('dependant')) return true;
    return _audioSkipReason != null &&
        (_audioSkipReason != 'other' || _audioNote.text.trim().isNotEmpty);
  }

  bool get _canRequest =>
      !_submitting &&
      (!_required('caregiver') || _hasAudio('caregiver')) &&
      _dependantAccountedFor &&
      _unchecked.every((t) => _reasons.containsKey(t.careTaskId));

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

  Future<void> _request() async {
    _start();
    // Location first: without it check-out can't succeed, so there's no point saving tasks before
    // finding that out.
    final position = await _position();
    if (position == null) return;
    final api = widget.visitSchedulesApi;
    try {
      // Re-save every task, not just the unticked ones, so the server's record is exactly what
      // this screen showed (a tick that failed to save earlier gets another chance here).
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
      for (final role in recordingRoles) {
        if (_required(role) && (widget.hasRecording[role] ?? false)) {
          try {
            await uploadVisitAudio(api, widget.visit.id, role);
          } catch (_) {
            return _fail(
              role == 'caregiver'
                  ? "Couldn't upload your recording. Check your connection and try again."
                  : "Couldn't upload the dependant's recording. Try again, or choose a reason "
                        'below to check out without it.',
            );
          }
        }
      }
      final skip = _hasAudio('dependant') ? null : _audioSkipReason;
      final note = _audioNote.text.trim();
      await api.requestCheckout(
        widget.visit.id,
        gpsLat: position.latitude,
        gpsLng: position.longitude,
        audioSkipReason: skip,
        audioSkipNote: skip == null || note.isEmpty ? null : note,
      );
      if (!mounted) return;
      setState(() {
        _submitting = false;
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
      body: constrainedContent(
        _stage == _Stage.review ? _buildReview() : _buildConfirm(),
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
                  _ErrorBox(error),
                  const SizedBox(height: 8),
                ],
                if (_stage == _Stage.review)
                  ElevatedButton(
                    onPressed: _canRequest ? _request : null,
                    style: pillButtonStyle,
                    child: _submitting
                        ? const _Spinner()
                        : const Text('Check out'),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
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
      if (_required('caregiver') || _required('dependant')) ...[
        const SizedBox(height: 16),
        _card([
          if (_required('caregiver'))
            _statusRow(
              done: _hasAudio('caregiver'),
              title: _hasAudio('caregiver')
                  ? 'Your voice recorded'
                  : 'Your voice not recorded',
              subtitle: _hasAudio('caregiver')
                  ? null
                  : 'Go back and record it to check out',
            ),
          if (_required('caregiver') && _required('dependant'))
            const Divider(height: 1, color: borderColor),
          if (_required('dependant')) ...[
            _statusRow(
              done: _hasAudio('dependant'),
              title: _hasAudio('dependant')
                  ? "The dependant's voice recorded"
                  : "The dependant's voice not recorded",
              subtitle: _hasAudio('dependant')
                  ? null
                  : 'Go back to record, or give a reason below',
            ),
            if (!_hasAudio('dependant') || _error != null) _buildAudioReason(),
          ],
        ]),
      ],
    ],
  );

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
      children: [
        DropdownButtonFormField<String>(
          initialValue: _audioSkipReason,
          isExpanded: true,
          decoration: const InputDecoration(
            labelText: "Reason for no recording of the dependant",
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
