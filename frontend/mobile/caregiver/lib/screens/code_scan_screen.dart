import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../api/api_client.dart';
import '../api/checkin_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../visit_notifications.dart';

enum _Stage {
  loading,
  scanning,
  enteringCode,
  submitting,
  askingForOverride,
  waiting,
  started,
}

// checkin_override_requests.reason (backend/src/db/schema.ts).
const _overrideReasons = {
  'no_family_member_present': 'No family member is here',
  'family_phone_unavailable': "The family member's phone isn't available",
  'network_problem': 'Network problem',
  'other': 'Other',
};

/// Check-in step 2, after the geofence passes: scan the code on a family member's phone, or type
/// the 6 digits under it (2026-11-25, e.g. read out by a family member who isn't at the home),
/// which is what starts the visit. If no family member can give a code, the caregiver asks a
/// supervisor instead, and waits here for the answer.
///
/// [scannerBuilder] replaces the camera view in widget tests, where there is no camera.
class CodeScanScreen extends StatefulWidget {
  final VisitSchedule visit;
  final CheckinApi checkinApi;
  final GeofenceCheckinResult session;
  final VoidCallback onProceed;
  final Widget Function(void Function(String value) onValue)? scannerBuilder;

  const CodeScanScreen({
    super.key,
    required this.visit,
    required this.checkinApi,
    required this.session,
    required this.onProceed,
    this.scannerBuilder,
  });

  @override
  State<CodeScanScreen> createState() => _CodeScanScreenState();
}

class _CodeScanScreenState extends State<CodeScanScreen> {
  _Stage _stage = _Stage.loading;
  String? _message;
  bool _paused = false;
  String? _reason;
  final _note = TextEditingController();
  final _code = TextEditingController();
  Timer? _poll;

  static const _pollEvery = Duration(seconds: 5);

  @override
  void initState() {
    super.initState();
    _resumePendingRequest();
  }

  @override
  void dispose() {
    _poll?.cancel();
    _note.dispose();
    _code.dispose();
    super.dispose();
  }

  // A request made before the app was closed is still waiting, so go straight back to waiting.
  Future<void> _resumePendingRequest() async {
    CheckinOverride? latest;
    try {
      latest = await widget.checkinApi.latestOverride(widget.visit.id);
    } catch (_) {
      // Only a convenience: scanning still works without knowing.
    }
    if (!mounted) return;
    if (latest?.status == 'pending') {
      _startWaiting();
    } else {
      setState(() => _stage = _Stage.scanning);
    }
  }

  Future<void> _onCode(String value) async {
    // The camera reports the same code many times a second, and a refused code must stay refused
    // until the caregiver chooses to scan again.
    if (_stage != _Stage.scanning || _paused) return;
    setState(() {
      _stage = _Stage.submitting;
      _message = null;
    });
    try {
      await widget.checkinApi.scanCode(
        visitScheduleId: widget.visit.id,
        sessionToken: widget.session.sessionToken,
        token: value,
      );
      await _started();
    } catch (e) {
      _handleError(e);
    }
  }

  Future<void> _submitCode() async {
    setState(() {
      _stage = _Stage.submitting;
      _message = null;
    });
    try {
      await widget.checkinApi.enterCode(
        visitScheduleId: widget.visit.id,
        sessionToken: widget.session.sessionToken,
        code: _code.text.trim(),
      );
      await _started();
    } catch (e) {
      _handleError(e, backTo: _Stage.enteringCode);
    }
  }

  Future<void> _started() async {
    _poll?.cancel();
    try {
      await VisitNotifications.showOngoing(widget.visit);
    } catch (_) {
      // The visit has started either way; the notification is only a shortcut back to it.
    }
    if (mounted) setState(() => _stage = _Stage.started);
  }

  void _handleError(Object error, {_Stage backTo = _Stage.scanning}) {
    if (!mounted) return;
    final problem = error is ApiException ? error.problem : null;
    if (problem?.status == 401) {
      // The geofence session ran out: only a fresh location check can issue a new one.
      showSnack(
        context,
        'Check-in session expired - please check your location again.',
      );
      Navigator.of(context).pop(true);
      return;
    }
    setState(() {
      _stage = backTo;
      // Only a refused scan pauses the camera; a typed code can just be corrected.
      _paused = backTo == _Stage.scanning;
      _message =
          problem?.detail ?? problem?.title ?? 'Could not reach the server.';
    });
  }

  void _goTo(_Stage stage) => setState(() {
    _stage = stage;
    _message = null;
  });

  void _scanAgain() => setState(() {
    _paused = false;
    _message = null;
  });

  bool get _canRequest =>
      _reason != null && (_reason != 'other' || _note.text.trim().isNotEmpty);

  Future<void> _requestOverride() async {
    setState(() {
      _stage = _Stage.submitting;
      _message = null;
    });
    final note = _note.text.trim();
    try {
      await widget.checkinApi.requestOverride(
        visitScheduleId: widget.visit.id,
        sessionToken: widget.session.sessionToken,
        reason: _reason!,
        note: note.isEmpty ? null : note,
      );
      _startWaiting();
    } catch (e) {
      if (e is ApiException && e.problem.status == 409) {
        // Already waiting on a supervisor, e.g. after a retry whose first response was lost.
        _startWaiting();
        return;
      }
      if (e is ApiException && e.problem.status == 401) {
        _handleError(e);
        return;
      }
      if (!mounted) return;
      setState(() {
        _stage = _Stage.askingForOverride;
        _message = e is ApiException
            ? (e.problem.detail ?? e.problem.title)
            : 'Could not reach the server.';
      });
    }
  }

  void _startWaiting() {
    if (!mounted) return;
    setState(() => _stage = _Stage.waiting);
    _poll?.cancel();
    _poll = Timer.periodic(_pollEvery, (_) => _checkDecision());
  }

  Future<void> _checkDecision() async {
    final CheckinOverride? latest;
    try {
      latest = await widget.checkinApi.latestOverride(widget.visit.id);
    } catch (_) {
      return; // Try again on the next tick: a dropped connection isn't a decision.
    }
    if (!mounted || latest == null || latest.status == 'pending') return;
    _poll?.cancel();
    if (latest.status == 'approved') {
      await _started();
    } else {
      setState(() {
        _stage = _Stage.scanning;
        _paused = true;
        _message =
            'A supervisor declined: ${latest!.decisionNote ?? 'no reason given'}';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: Text(
          widget.visit.dependantDisplayName,
          style: const TextStyle(fontSize: 16),
        ),
      ),
      body: constrainedContent(switch (_stage) {
        _Stage.loading ||
        _Stage.submitting => const Center(child: CircularProgressIndicator()),
        _Stage.scanning => _buildScanner(),
        _Stage.enteringCode => _buildCodeEntry(),
        _Stage.askingForOverride => _buildOverrideForm(),
        _Stage.waiting => _centred(
          leading: const CircularProgressIndicator(),
          title: 'Waiting for a supervisor',
          body:
              "Stay at the home. The visit starts as soon as they approve, and you don't "
              'need to do anything else.',
        ),
        _Stage.started => _centred(
          leading: const Icon(
            Icons.check_circle,
            color: successGreen,
            size: 56,
          ),
          title: 'Visit started',
          body: 'You can now work through the care checklist.',
          action: ElevatedButton(
            onPressed: widget.onProceed,
            style: pillButtonStyle,
            child: const Text('Continue'),
          ),
        ),
      }),
    );
  }

  Widget _buildScanner() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text(
          'Scan the family code',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w500,
            color: inkDefault,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          'Ask a family member to open "Show check-in code" in their VerifCare app, then '
          'point your camera at it.',
          style: TextStyle(fontSize: 14, height: 1.4, color: inkSecondary),
        ),
        // Above the camera, so it's on screen on a small phone without scrolling.
        if (_message case final message?) ...[
          const SizedBox(height: 12),
          _ErrorBanner(message),
        ],
        const SizedBox(height: 16),
        AspectRatio(
          aspectRatio: 1,
          child: ClipRect(
            child: _paused
                ? ColoredBox(
                    color: const Color(0xFFEFEFEF),
                    child: Center(
                      child: OutlinedButton(
                        onPressed: _scanAgain,
                        child: const Text('Scan again'),
                      ),
                    ),
                  )
                : (widget.scannerBuilder?.call(_onCode) ??
                      _CameraView(onValue: _onCode)),
          ),
        ),
        const SizedBox(height: 16),
        TextButton(
          onPressed: () => _goTo(_Stage.enteringCode),
          child: const Text('Use code instead'),
        ),
        _askSupervisorButton(),
      ],
    );
  }

  Widget _askSupervisorButton() => TextButton(
    onPressed: () => _goTo(_Stage.askingForOverride),
    child: const Text('No family member can give a code?'),
  );

  Widget _buildCodeEntry() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text(
          'Type the family code',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w500,
            color: inkDefault,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          'Ask a family member for the 6 digits under their check-in code. They can read them '
          "out to you if they aren't at the home.",
          style: TextStyle(fontSize: 14, height: 1.4, color: inkSecondary),
        ),
        if (_message case final message?) ...[
          const SizedBox(height: 12),
          _ErrorBanner(message),
        ],
        const SizedBox(height: 16),
        TextField(
          controller: _code,
          autofocus: true,
          keyboardType: TextInputType.number,
          maxLength: 6,
          onChanged: (_) => setState(() {}),
          decoration: const InputDecoration(
            labelText: '6-digit code',
            counterText: '',
          ),
        ),
        const SizedBox(height: 12),
        ElevatedButton(
          onPressed: RegExp(r'^\d{6}$').hasMatch(_code.text.trim())
              ? _submitCode
              : null,
          style: pillButtonStyle,
          child: const Text('Start visit'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => _goTo(_Stage.scanning),
          child: const Text('Scan instead'),
        ),
        _askSupervisorButton(),
      ],
    );
  }

  Widget _buildOverrideForm() {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text(
          'Ask a supervisor to start the visit',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w500,
            color: inkDefault,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          'A supervisor will review this. Visits started this way are recorded as exceptions.',
          style: TextStyle(fontSize: 14, height: 1.4, color: inkSecondary),
        ),
        const SizedBox(height: 16),
        DropdownButtonFormField<String>(
          initialValue: _reason,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'Reason'),
          items: [
            for (final entry in _overrideReasons.entries)
              DropdownMenuItem(value: entry.key, child: Text(entry.value)),
          ],
          onChanged: (value) => setState(() => _reason = value),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _note,
          maxLength: 500,
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            labelText: _reason == 'other' ? 'Details' : 'Details (optional)',
          ),
        ),
        if (_message case final message?) ...[
          const SizedBox(height: 4),
          _ErrorBanner(message),
        ],
        const SizedBox(height: 12),
        ElevatedButton(
          onPressed: _canRequest ? _requestOverride : null,
          style: pillButtonStyle,
          child: const Text('Send request'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => _goTo(_Stage.scanning),
          child: const Text('Back to scanning'),
        ),
      ],
    );
  }

  Widget _centred({
    required Widget leading,
    required String title,
    required String body,
    Widget? action,
  }) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            leading,
            const SizedBox(height: 16),
            Text(
              title,
              style: const TextStyle(
                fontSize: 18,
                fontWeight: FontWeight.w500,
                color: inkDefault,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              body,
              textAlign: TextAlign.center,
              style: const TextStyle(
                fontSize: 14,
                height: 1.4,
                color: inkSecondary,
              ),
            ),
            if (action != null) ...[
              const SizedBox(height: 20),
              SizedBox(width: double.infinity, child: action),
            ],
          ],
        ),
      ),
    );
  }
}

class _CameraView extends StatelessWidget {
  final void Function(String value) onValue;
  const _CameraView({required this.onValue});

  @override
  Widget build(BuildContext context) {
    return MobileScanner(
      onDetect: (capture) {
        final value = capture.barcodes.firstOrNull?.rawValue;
        if (value != null) onValue(value);
      },
      errorBuilder: (context, error) => const ColoredBox(
        color: Color(0xFFEFEFEF),
        child: Center(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'The camera is needed to scan the code. Allow camera access in your phone '
              'settings, or use the code instead.',
              textAlign: TextAlign.center,
              style: TextStyle(fontSize: 13, color: inkSecondary),
            ),
          ),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  final String text;
  const _ErrorBanner(this.text);

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    color: dangerTint,
    child: Text(
      text,
      style: const TextStyle(fontSize: 13, height: 1.35, color: inkDefault),
    ),
  );
}
