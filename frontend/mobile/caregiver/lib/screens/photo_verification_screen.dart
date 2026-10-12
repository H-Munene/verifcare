import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../api/api_client.dart';
import '../api/checkin_api.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';
import '../visit_notifications.dart';

enum _PhotoState { idle, verifying, verified, failed }

/// Check-in step 2, after the geofence passes: one photo of the caregiver, one of the dependant.
///
/// Both photos can be taken and uploaded straight away, but the backend only accepts the
/// dependant's verification once the caregiver's has passed, and within its co-presence window
/// (checkin.ts). So the dependant's already-uploaded photo is held here and submitted the moment
/// the caregiver's passes, rather than changing that server-side ordering (user decision
/// 2026-09-24).
class PhotoVerificationScreen extends StatefulWidget {
  final VisitSchedule visit;
  final CheckinApi checkinApi;
  final GeofenceCheckinResult session;
  final VoidCallback onProceed;

  const PhotoVerificationScreen({
    super.key,
    required this.visit,
    required this.checkinApi,
    required this.session,
    required this.onProceed,
  });

  @override
  State<PhotoVerificationScreen> createState() =>
      _PhotoVerificationScreenState();
}

class _PhotoVerificationScreenState extends State<PhotoVerificationScreen> {
  final _picker = ImagePicker();
  final _states = {
    CheckinSubject.caregiver: _PhotoState.idle,
    CheckinSubject.dependant: _PhotoState.idle,
  };
  String? _pendingDependantKey;
  bool _dependantSubmitting = false;

  bool get _bothVerified =>
      _states.values.every((state) => state == _PhotoState.verified);

  void _set(CheckinSubject subject, _PhotoState state) {
    if (mounted) setState(() => _states[subject] = state);
  }

  Future<void> _capture(CheckinSubject subject) async {
    // Camera only - ImageSource.gallery is never offered, so an old photo can't stand in for a
    // live one. The system camera app supplies its own retake/confirm step.
    final photo = await _picker.pickImage(
      source: ImageSource.camera,
      preferredCameraDevice: subject == CheckinSubject.caregiver
          ? CameraDevice.front
          : CameraDevice.rear,
      maxWidth: 1600,
      imageQuality: 85,
    );
    if (photo == null) return;
    _set(subject, _PhotoState.verifying);

    try {
      final s3Key = await widget.checkinApi.uploadLivenessPhoto(
        visitScheduleId: widget.visit.id,
        subject: subject,
        sessionToken: widget.session.sessionToken,
        jpegBytes: await photo.readAsBytes(),
      );
      if (subject == CheckinSubject.caregiver) {
        await _submit(CheckinSubject.caregiver, s3Key);
      } else {
        _pendingDependantKey = s3Key;
      }
      await _submitPendingDependant();
    } catch (e) {
      _handleError(subject, e);
    }
  }

  Future<void> _submitPendingDependant() async {
    final s3Key = _pendingDependantKey;
    if (s3Key == null ||
        _dependantSubmitting ||
        _states[CheckinSubject.caregiver] != _PhotoState.verified) {
      return;
    }
    _dependantSubmitting = true;
    _pendingDependantKey = null;
    try {
      await _submit(CheckinSubject.dependant, s3Key);
    } catch (e) {
      _handleError(CheckinSubject.dependant, e);
    } finally {
      _dependantSubmitting = false;
    }
  }

  Future<void> _submit(CheckinSubject subject, String s3Key) async {
    final result = await widget.checkinApi.submitLiveness(
      visitScheduleId: widget.visit.id,
      subject: subject,
      sessionToken: widget.session.sessionToken,
      s3Key: s3Key,
    );
    if (result.passed) {
      _set(subject, _PhotoState.verified);
      if (_bothVerified) {
        // The dependant pass is what flips the visit to in_progress server-side.
        await VisitNotifications.showOngoing(widget.visit);
      }
    } else {
      _set(subject, _PhotoState.failed);
      if (mounted) {
        showSnack(
          context,
          '${_who(subject)} photo failed: ${describeLivenessFailure(result.failureReason)}.',
        );
      }
    }
  }

  void _handleError(CheckinSubject subject, Object error) {
    if (!mounted) return;
    final problem = error is ApiException ? error.problem : null;
    if (problem?.status == 401) {
      // The geofence session (10 minutes) ran out - only a fresh location check can issue a new
      // one, so hand back to the map screen.
      showSnack(
        context,
        'Check-in session expired - please check your location again.',
      );
      Navigator.of(context).pop(true);
      return;
    }
    if (problem?.status == 409 && subject == CheckinSubject.dependant) {
      // Co-presence window missed: the server wants a fresh caregiver pass first.
      _set(CheckinSubject.caregiver, _PhotoState.failed);
    }
    _set(subject, _PhotoState.failed);
    showSnack(
      context,
      problem?.detail ?? problem?.title ?? 'Could not reach the server.',
    );
  }

  String _who(CheckinSubject subject) =>
      subject == CheckinSubject.caregiver ? 'Your' : "The dependant's";

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Verify identity', style: TextStyle(fontSize: 16)),
      ),
      // Scrollable rather than a Spacer-filled Column, which overflowed in phone landscape.
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(20),
          children: [
            Text(
              'Take one photo of yourself and one of ${widget.visit.dependantDisplayName}.',
              style: const TextStyle(fontSize: 14, color: inkSecondary),
            ),
            const SizedBox(height: 20),
            LayoutBuilder(
              builder: (context, constraints) {
                final caregiver = _PhotoButton(
                  label: 'Take caregiver (you) photo',
                  verifiedLabel: 'Caregiver verified',
                  retakeLabel: 'Retake caregiver photo',
                  icon: Icons.person_outline,
                  state: _states[CheckinSubject.caregiver]!,
                  onTap: () => _capture(CheckinSubject.caregiver),
                );
                final dependant = _PhotoButton(
                  label: 'Take dependant photo',
                  verifiedLabel: 'Dependant verified',
                  retakeLabel: 'Retake dependant photo',
                  icon: Icons.elderly_outlined,
                  state: _states[CheckinSubject.dependant]!,
                  waitingHint:
                      _states[CheckinSubject.caregiver] != _PhotoState.verified
                      ? 'Checked once your photo passes'
                      : null,
                  onTap: () => _capture(CheckinSubject.dependant),
                );
                // Side by side once there's room for both labels on one line.
                return constraints.maxWidth >= _sideBySideMinWidth
                    ? IntrinsicHeight(
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Expanded(child: caregiver),
                            const SizedBox(width: 12),
                            Expanded(child: dependant),
                          ],
                        ),
                      )
                    : Column(
                        children: [
                          caregiver,
                          const SizedBox(height: 12),
                          dependant,
                        ],
                      );
              },
            ),
          ],
        ),
      ),
      bottomNavigationBar: _bothVerified
          ? SafeArea(
              child: constrainedContent(
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 8, 20, 16),
                  child: ElevatedButton(
                    onPressed: widget.onProceed,
                    style: pillButtonStyle,
                    child: const Text('Proceed'),
                  ),
                ),
              ),
            )
          : null,
    );
  }
}

const _sideBySideMinWidth = 520.0;

class _PhotoButton extends StatelessWidget {
  final String label;
  final String verifiedLabel;
  final String retakeLabel;
  final IconData icon;
  final _PhotoState state;
  final String? waitingHint;
  final VoidCallback onTap;

  const _PhotoButton({
    required this.label,
    required this.verifiedLabel,
    required this.retakeLabel,
    required this.icon,
    required this.state,
    required this.onTap,
    this.waitingHint,
  });

  @override
  Widget build(BuildContext context) {
    final (Color background, Color border, Color ink) = switch (state) {
      _PhotoState.verified => (successTint, successGreen, successGreen),
      _PhotoState.failed => (dangerTint, dangerRed, dangerRed),
      _ => (Colors.white, borderColor, inkDefault),
    };
    final Widget leading = switch (state) {
      _PhotoState.verifying => const SizedBox(
        width: 22,
        height: 22,
        child: CircularProgressIndicator(strokeWidth: 2, color: primaryGreen),
      ),
      _PhotoState.verified => const Icon(
        Icons.check_circle,
        color: successGreen,
      ),
      _PhotoState.failed => const Icon(Icons.refresh, color: dangerRed),
      _PhotoState.idle => Icon(icon, color: inkSecondary),
    };
    final text = switch (state) {
      _PhotoState.verifying => 'Verifying...',
      _PhotoState.verified => verifiedLabel,
      _PhotoState.failed => retakeLabel,
      _PhotoState.idle => label,
    };
    final enabled = state == _PhotoState.idle || state == _PhotoState.failed;

    return Material(
      color: background,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.zero,
        side: BorderSide(color: border),
      ),
      child: InkWell(
        borderRadius: BorderRadius.zero,
        onTap: enabled ? onTap : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 18),
          child: Row(
            children: [
              leading,
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      text,
                      style: TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w500,
                        color: ink,
                      ),
                    ),
                    if (state == _PhotoState.verifying && waitingHint != null)
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text(
                          waitingHint!,
                          style: const TextStyle(
                            fontSize: 12,
                            color: inkTertiary,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
              if (enabled)
                const Icon(Icons.photo_camera_outlined, color: inkTertiary),
            ],
          ),
        ),
      ),
    );
  }
}
