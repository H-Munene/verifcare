import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:qr_flutter/qr_flutter.dart';

import '../api/api_client.dart';
import '../api/visit_schedules_api.dart';
import '../app_ui.dart';

/// The phone's position for one code request.
typedef DevicePosition = ({double lat, double lng, double accuracyMeters, bool isMocked});

/// Thrown when the phone's location can't be read, with wording for the family member.
class LocationUnavailable implements Exception {
  final String message;
  const LocationUnavailable(this.message);
}

Future<DevicePosition> currentDevicePosition() async {
  if (!await Geolocator.isLocationServiceEnabled()) {
    throw const LocationUnavailable('Turn on location to show the check-in code.');
  }
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) {
    permission = await Geolocator.requestPermission();
  }
  if (permission == LocationPermission.denied || permission == LocationPermission.deniedForever) {
    throw const LocationUnavailable(
      'Location permission is needed to confirm you are at the home.',
    );
  }
  final position = await Geolocator.getCurrentPosition(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.high,
      timeLimit: Duration(seconds: 20),
    ),
  );
  return (
    lat: position.latitude,
    lng: position.longitude,
    accuracyMeters: position.accuracy,
    isMocked: position.isMocked,
  );
}

/// The code a caregiver scans to start a visit. The phone has to be at the home, which is checked
/// each time a code is issued. A code lasts about a minute, so a new one is fetched well before it
/// runs out: the caregiver never ends up holding an expired one, and a screenshot goes stale
/// almost at once.
class CheckInCodeScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;
  final Future<DevicePosition> Function() locate;

  const CheckInCodeScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
    this.locate = currentDevicePosition,
  });

  @override
  State<CheckInCodeScreen> createState() => _CheckInCodeScreenState();
}

class _CheckInCodeScreenState extends State<CheckInCodeScreen> {
  CheckinCode? _code;
  String? _error;
  bool _started = false;
  Timer? _refresh;
  Timer? _watch;

  static const _refreshEvery = Duration(seconds: 30);
  static const _watchEvery = Duration(seconds: 4);

  @override
  void initState() {
    super.initState();
    _issue();
    _refresh = Timer.periodic(_refreshEvery, (_) => _issue());
    _watch = Timer.periodic(_watchEvery, (_) => _checkStarted());
  }

  @override
  void dispose() {
    _stopTimers();
    super.dispose();
  }

  void _stopTimers() {
    _refresh?.cancel();
    _watch?.cancel();
  }

  Future<void> _issue() async {
    try {
      final position = await widget.locate();
      final code = await widget.visitSchedulesApi.issueCheckinCode(
        widget.visit.id,
        gpsLat: position.lat,
        gpsLng: position.lng,
        accuracyMeters: position.accuracyMeters,
        isMockLocation: position.isMocked,
      );
      if (mounted) {
        setState(() {
          _code = code;
          _error = null;
        });
      }
    } on LocationUnavailable catch (e) {
      _fail(e.message);
    } on ApiException catch (e) {
      if (e.problem.status == 409) {
        // The visit has moved on, which at this point almost always means the code was scanned.
        _markStarted();
        return;
      }
      _fail(e.problem.detail ?? e.problem.title);
    } catch (_) {
      _fail("Couldn't get a code. Check your connection and location, then try again.");
    }
  }

  void _fail(String message) {
    if (mounted) {
      setState(() {
        _code = null;
        _error = message;
      });
    }
  }

  Future<void> _checkStarted() async {
    try {
      final visit = await widget.visitSchedulesApi.getVisit(widget.visit.id);
      if (visit.status != 'scheduled') _markStarted();
    } catch (_) {
      // Only an early heads-up; the next code request will notice too.
    }
  }

  void _markStarted() {
    _stopTimers();
    if (mounted) setState(() => _started = true);
  }

  @override
  Widget build(BuildContext context) {
    final caregiver = _code?.caregiverDisplayName ?? widget.visit.caregiverDisplayName;
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Check-in code', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(24),
          children: [
            if (_started) ...[
              const SizedBox(height: 48),
              const Icon(Icons.check_circle, color: successGreen, size: 64),
              const SizedBox(height: 16),
              Text(
                'Visit started with $caregiver',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 18,
                  fontWeight: FontWeight.w600,
                  color: inkDefault,
                ),
              ),
              const SizedBox(height: 24),
              ElevatedButton(
                onPressed: () => Navigator.of(context).pop(),
                style: pillButtonStyle,
                child: const Text('Done'),
              ),
            ] else ...[
              Text(
                'Is $caregiver with you?',
                textAlign: TextAlign.center,
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.w600,
                  color: inkDefault,
                ),
              ),
              const SizedBox(height: 6),
              const Text(
                'Only show this code to your caregiver, once they are at the home. '
                'Scanning it starts the visit.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 14, height: 1.4, color: inkSecondary),
              ),
              const SizedBox(height: 24),
              if (_error case final message?) ...[
                Container(
                  padding: const EdgeInsets.all(12),
                  color: dangerTint,
                  child: Text(
                    message,
                    style: const TextStyle(fontSize: 14, height: 1.35, color: inkDefault),
                  ),
                ),
                const SizedBox(height: 12),
                OutlinedButton(onPressed: _issue, child: const Text('Try again')),
              ] else if (_code case final code?)
                Center(
                  child: Semantics(
                    label: 'Check-in code for the caregiver to scan',
                    child: QrImageView(data: code.token, size: 260),
                  ),
                )
              else
                const SizedBox(height: 260, child: Center(child: CircularProgressIndicator())),
              const SizedBox(height: 16),
              const Text(
                'This code refreshes by itself.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12, color: inkTertiary),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
