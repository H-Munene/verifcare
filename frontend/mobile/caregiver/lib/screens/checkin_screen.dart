// Screen 04/05 of the wireframes (temp_images/Mzazi Care Caregiver App Wireframes.dc.html) - the
// geofence check-in map and its bottom sheet. A passing geofence check moves straight on to
// PhotoVerificationScreen (the caregiver/dependant photo step).

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';

import '../api/api_client.dart';
import '../api/checkin_api.dart';
import '../api/visit_schedules_api.dart';
import 'photo_verification_screen.dart';

const _primaryBlue = Color(0xFF0077E6);
const _successGreen = Color(0xFF15B042);
const _successTint = Color(0xFFCAFCE0);
const _dangerRed = Color(0xFFE0392B);
const _dangerTint = Color(0xFFFDE8E6);
const _inkDefault = Color(0xFF292929);
const _inkSecondary = Color(0xFF525252);
const _inkTertiary = Color(0xFF9E9E9E);
const _borderColor = Color(0xFFE5E5E5);

/// Which of wireframe 04/05's states the bottom sheet is currently showing.
enum _SheetState {
  loadingContext,
  loadContextError,
  ready, // live map + client-side in-range/out-of-range pill (04, and 05's first two states inline)
  submitting,
  retriableFailure, // 05's second state: out_of_range / insufficient_accuracy
  blockedFailure, // 05's third state: mock_location_detected - no retry
  genericError, // network/5xx - not one of the styled geofence states
  success,
}

class CheckInScreen extends StatefulWidget {
  final VisitSchedule visit;
  final VisitSchedulesApi visitSchedulesApi;
  final CheckinApi checkinApi;
  final VoidCallback onBack;
  // Both photos verified and the caregiver tapped Proceed - the visit is now in progress.
  final VoidCallback onCheckedIn;

  const CheckInScreen({
    super.key,
    required this.visit,
    required this.visitSchedulesApi,
    required this.checkinApi,
    required this.onBack,
    required this.onCheckedIn,
  });

  @override
  State<CheckInScreen> createState() => _CheckInScreenState();
}

class _CheckInScreenState extends State<CheckInScreen> {
  _SheetState _state = _SheetState.loadingContext;

  CheckinContext? _context;
  String? _contextErrorMessage;

  GoogleMapController? _mapController;
  StreamSubscription<Position>? _positionSubscription;
  Position? _currentPosition;
  String? _locationErrorMessage;

  Problem? _lastFailureProblem;
  GeofenceCheckinResult? _result;
  String? _genericErrorMessage;

  @override
  void initState() {
    super.initState();
    _loadContext();
  }

  @override
  void dispose() {
    _positionSubscription?.cancel();
    _mapController?.dispose();
    super.dispose();
  }

  Future<void> _loadContext() async {
    setState(() {
      _state = _SheetState.loadingContext;
      _contextErrorMessage = null;
    });
    try {
      final context = await widget.visitSchedulesApi.getCheckinContext(
        widget.visit.id,
      );
      if (!mounted) return;
      setState(() {
        _context = context;
        _state = _SheetState.ready;
      });
      unawaited(_startLocationUpdates());
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _contextErrorMessage = e.problem.detail ?? e.problem.title;
        _state = _SheetState.loadContextError;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _contextErrorMessage = e.toString();
        _state = _SheetState.loadContextError;
      });
    }
  }

  Future<void> _startLocationUpdates() async {
    var permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      permission = await Geolocator.requestPermission();
    }
    if (permission == LocationPermission.denied ||
        permission == LocationPermission.deniedForever) {
      if (!mounted) return;
      setState(() {
        _locationErrorMessage = permission == LocationPermission.deniedForever
            ? 'Location permission permanently denied. Enable it in device settings to check in.'
            : 'Location permission is required to check in.';
      });
      return;
    }

    if (!await Geolocator.isLocationServiceEnabled()) {
      if (!mounted) return;
      setState(() {
        _locationErrorMessage = 'Turn on device location services to check in.';
      });
      return;
    }

    setState(() => _locationErrorMessage = null);
    _positionSubscription?.cancel();
    _positionSubscription =
        Geolocator.getPositionStream(
          locationSettings: const LocationSettings(
            accuracy: LocationAccuracy.high,
            distanceFilter: 5,
          ),
        ).listen((position) {
          if (!mounted) return;
          setState(() => _currentPosition = position);
          _mapController?.animateCamera(
            CameraUpdate.newLatLng(
              LatLng(position.latitude, position.longitude),
            ),
          );
        });
  }

  double? get _liveDistanceMeters {
    final position = _currentPosition;
    final context = _context;
    if (position == null || context == null) return null;
    return Geolocator.distanceBetween(
      position.latitude,
      position.longitude,
      context.geofenceLat,
      context.geofenceLng,
    );
  }

  Future<void> _submitCheckin() async {
    final position = _currentPosition;
    if (position == null) {
      setState(
        () => _locationErrorMessage =
            'Still waiting for a GPS fix - try again in a moment.',
      );
      return;
    }

    setState(() => _state = _SheetState.submitting);
    try {
      final result = await widget.checkinApi.submitGeofenceCheckin(
        visitScheduleId: widget.visit.id,
        gpsLat: position.latitude,
        gpsLng: position.longitude,
        accuracyMeters: position.accuracy,
        isMockLocation: position.isMocked,
      );
      if (!mounted) return;
      setState(() {
        _result = result;
        _state = _SheetState.success;
      });
      unawaited(_openPhotoVerification());
    } on ApiException catch (e) {
      if (!mounted) return;
      if (e.problem.status == 422) {
        final reason = parseGeofenceFailureReason(e.problem.failureReason);
        setState(() {
          _lastFailureProblem = e.problem;
          _state = isRetriableGeofenceFailure(reason)
              ? _SheetState.retriableFailure
              : _SheetState.blockedFailure;
        });
      } else {
        setState(() {
          _genericErrorMessage = e.problem.detail ?? e.problem.title;
          _state = _SheetState.genericError;
        });
      }
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _genericErrorMessage = e.toString();
        _state = _SheetState.genericError;
      });
    }
  }

  Future<void> _openPhotoVerification() async {
    final sessionExpired = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => PhotoVerificationScreen(
          visit: widget.visit,
          checkinApi: widget.checkinApi,
          session: _result!,
          onProceed: widget.onCheckedIn,
        ),
      ),
    );
    if (sessionExpired == true && mounted) {
      setState(() => _state = _SheetState.ready);
    }
  }

  String _formatVisitWindow() {
    String fmt(DateTime t) {
      final hour12 = t.hour % 12 == 0 ? 12 : t.hour % 12;
      final minute = t.minute.toString().padLeft(2, '0');
      return '$hour12:$minute';
    }

    final period = widget.visit.scheduledEnd.hour < 12 ? 'AM' : 'PM';
    return '${fmt(widget.visit.scheduledStart)}-${fmt(widget.visit.scheduledEnd)} $period';
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            Expanded(child: _buildMapArea()),
            _buildBottomSheet(),
          ],
        ),
      ),
    );
  }

  Widget _buildMapArea() {
    final ctx = _context;
    if (_state == _SheetState.loadingContext) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_state == _SheetState.loadContextError || ctx == null) {
      return _buildContextErrorBody();
    }

    final center = LatLng(ctx.geofenceLat, ctx.geofenceLng);
    final markers = <Marker>{
      Marker(
        markerId: const MarkerId('geofence-center'),
        position: center,
        infoWindow: InfoWindow(title: ctx.dependantDisplayName),
      ),
      if (_currentPosition != null)
        Marker(
          markerId: const MarkerId('caregiver-position'),
          position: LatLng(
            _currentPosition!.latitude,
            _currentPosition!.longitude,
          ),
          icon: BitmapDescriptor.defaultMarkerWithHue(
            BitmapDescriptor.hueAzure,
          ),
          infoWindow: const InfoWindow(title: 'You'),
        ),
    };

    return Stack(
      children: [
        GoogleMap(
          initialCameraPosition: CameraPosition(target: center, zoom: 16),
          onMapCreated: (controller) => _mapController = controller,
          markers: markers,
          circles: {
            Circle(
              circleId: const CircleId('geofence'),
              center: center,
              radius: ctx.geofenceRadiusMeters.toDouble(),
              strokeWidth: 2,
              strokeColor: _primaryBlue,
              fillColor: _primaryBlue.withValues(alpha: 0.12),
            ),
          },
          myLocationButtonEnabled: false,
        ),
        Positioned(
          top: 16,
          left: 16,
          child: _RoundIconButton(icon: Icons.arrow_back, onTap: widget.onBack),
        ),
        Positioned(
          top: 16,
          right: 16,
          child: Column(
            children: [
              _RoundIconButton(icon: Icons.explore_outlined, onTap: () {}),
              const SizedBox(height: 8),
              _RoundIconButton(
                icon: Icons.my_location,
                iconColor: _primaryBlue,
                onTap: () {
                  final pos = _currentPosition;
                  if (pos != null) {
                    _mapController?.animateCamera(
                      CameraUpdate.newLatLng(
                        LatLng(pos.latitude, pos.longitude),
                      ),
                    );
                  }
                },
              ),
            ],
          ),
        ),
        if (_locationErrorMessage != null)
          Positioned(
            bottom: 8,
            left: 8,
            right: 8,
            child: _InlineBanner(text: _locationErrorMessage!),
          ),
      ],
    );
  }

  Widget _buildContextErrorBody() {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(Icons.error_outline, color: _dangerRed, size: 40),
            const SizedBox(height: 12),
            Text(
              _contextErrorMessage ?? 'Could not load this visit.',
              textAlign: TextAlign.center,
              style: const TextStyle(color: _inkSecondary),
            ),
            const SizedBox(height: 16),
            OutlinedButton(onPressed: widget.onBack, child: const Text('Back')),
          ],
        ),
      ),
    );
  }

  Widget _buildBottomSheet() {
    if (_state == _SheetState.loadingContext ||
        _state == _SheetState.loadContextError) {
      return const SizedBox.shrink();
    }

    return Container(
      decoration: const BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.only(
          topLeft: Radius.circular(20),
          topRight: Radius.circular(20),
        ),
        boxShadow: [
          BoxShadow(
            color: Color(0x0F000000),
            blurRadius: 24,
            offset: Offset(0, -8),
          ),
        ],
      ),
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Center(
            child: Container(
              margin: const EdgeInsets.symmetric(vertical: 10),
              width: 36,
              height: 4,
              decoration: BoxDecoration(
                color: _borderColor,
                borderRadius: BorderRadius.circular(999),
              ),
            ),
          ),
          _buildSheetContent(),
        ],
      ),
    );
  }

  Widget _buildSheetContent() {
    switch (_state) {
      case _SheetState.loadingContext:
      case _SheetState.loadContextError:
        return const SizedBox.shrink();
      case _SheetState.ready:
      case _SheetState.submitting:
        return _buildReadySheet();
      case _SheetState.retriableFailure:
        return _buildFailureSheet(
          retriable: true,
          headline: "You're outside the visit location",
          detail: _lastFailureProblem?.detail ?? 'Move closer and retry.',
        );
      case _SheetState.blockedFailure:
        return _buildFailureSheet(
          retriable: false,
          headline: 'Location check blocked',
          detail:
              _lastFailureProblem?.detail ?? 'A mock location was detected.',
        );
      case _SheetState.genericError:
        return _buildGenericErrorSheet();
      case _SheetState.success:
        return _buildSuccessSheet();
    }
  }

  Widget _buildReadySheet() {
    final ctx = _context!;
    final distance = _liveDistanceMeters;
    final inRange = distance != null && distance <= ctx.geofenceRadiusMeters;
    final submitting = _state == _SheetState.submitting;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          ctx.dependantDisplayName,
          style: const TextStyle(
            fontSize: 16,
            fontWeight: FontWeight.w500,
            color: _inkDefault,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          ctx.dependantHomeAddressText ?? 'No address given',
          style: const TextStyle(fontSize: 14, color: _inkSecondary),
        ),
        const SizedBox(height: 2),
        Text(
          'Scheduled ${_formatVisitWindow()}',
          style: const TextStyle(fontSize: 13, color: _inkTertiary),
        ),
        const SizedBox(height: 12),
        if (distance != null)
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: inRange ? _successTint : _dangerTint,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              children: [
                Container(
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    color: inRange ? _successGreen : _dangerRed,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    inRange
                        ? "You're within range - ${distance.toStringAsFixed(1)}m from home location"
                        : "You're outside the visit location - ${distance.toStringAsFixed(0)}m away - move closer and retry",
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: inRange ? _successGreen : _dangerRed,
                    ),
                  ),
                ),
              ],
            ),
          ),
        const SizedBox(height: 12),
        SizedBox(
          height: 40,
          child: ElevatedButton(
            onPressed: submitting ? null : _submitCheckin,
            style: ElevatedButton.styleFrom(
              backgroundColor: _primaryBlue,
              foregroundColor: Colors.white,
              disabledBackgroundColor: _primaryBlue.withValues(alpha: 0.6),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(999),
              ),
              elevation: 0,
            ),
            child: submitting
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Text(
                    'Check In',
                    style: TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
                  ),
          ),
        ),
      ],
    );
  }

  Widget _buildFailureSheet({
    required bool retriable,
    required String headline,
    required String detail,
  }) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: const BoxDecoration(
              color: _dangerTint,
              shape: BoxShape.circle,
            ),
            child: Center(
              child: retriable
                  // Retriable: a plain circle outline, per wireframe 05's second state.
                  ? Container(
                      width: 18,
                      height: 18,
                      decoration: const BoxDecoration(
                        shape: BoxShape.circle,
                        border: Border.fromBorderSide(
                          BorderSide(color: _dangerRed, width: 2),
                        ),
                      ),
                    )
                  // Blocked: a rotated square (reads as an X-ish glyph), per wireframe 05's third
                  // state - visually distinct from the retriable circle so the hard-block reads as
                  // categorically different, not just "another error".
                  : Transform.rotate(
                      angle: 0.785398,
                      child: Container(
                        width: 18,
                        height: 18,
                        decoration: const BoxDecoration(
                          border: Border.fromBorderSide(
                            BorderSide(color: _dangerRed, width: 2),
                          ),
                        ),
                      ),
                    ),
            ),
          ),
          const SizedBox(height: 12),
          Text(
            headline,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: _dangerRed,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            detail,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12, color: _inkTertiary),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 40,
            child: OutlinedButton(
              onPressed: retriable ? _submitCheckin : () {},
              style: OutlinedButton.styleFrom(
                foregroundColor: _inkSecondary,
                side: const BorderSide(color: _borderColor),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
              child: Text(retriable ? 'Retry' : 'Contact Support'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildGenericErrorSheet() {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.wifi_off, color: _inkTertiary, size: 40),
          const SizedBox(height: 12),
          const Text(
            'Something went wrong',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: _inkDefault,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            _genericErrorMessage ?? 'Check your connection and try again.',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 12, color: _inkTertiary),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 40,
            child: OutlinedButton(
              onPressed: () => setState(() => _state = _SheetState.ready),
              style: OutlinedButton.styleFrom(
                foregroundColor: _inkSecondary,
                side: const BorderSide(color: _borderColor),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(10),
                ),
              ),
              child: const Text('Retry'),
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSuccessSheet() {
    final result = _result!;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 48,
            height: 48,
            decoration: const BoxDecoration(
              color: _successTint,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.check, color: _successGreen),
          ),
          const SizedBox(height: 12),
          const Text(
            'Geofence check passed',
            style: TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w500,
              color: _successGreen,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            'Valid until ${TimeOfDay.fromDateTime(result.expiresAt.toLocal()).format(context)}',
            style: const TextStyle(fontSize: 12, color: _inkTertiary),
          ),
          const SizedBox(height: 12),
          SizedBox(
            height: 40,
            child: ElevatedButton(
              // Reached only by backing out of the photo step while the session is still valid.
              onPressed: _openPhotoVerification,
              style: ElevatedButton.styleFrom(
                backgroundColor: _primaryBlue,
                foregroundColor: Colors.white,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(999),
                ),
                elevation: 0,
              ),
              child: const Text('Continue to photos'),
            ),
          ),
        ],
      ),
    );
  }
}

class _RoundIconButton extends StatelessWidget {
  final IconData icon;
  final Color iconColor;
  final VoidCallback onTap;

  const _RoundIconButton({
    required this.icon,
    this.iconColor = _inkDefault,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.white,
      shape: const CircleBorder(side: BorderSide(color: _borderColor)),
      elevation: 2,
      child: InkWell(
        customBorder: const CircleBorder(),
        onTap: onTap,
        child: SizedBox(
          width: 40,
          height: 40,
          child: Icon(icon, size: 18, color: iconColor),
        ),
      ),
    );
  }
}

class _InlineBanner extends StatelessWidget {
  final String text;

  const _InlineBanner({required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(6),
        border: Border.all(color: _borderColor),
      ),
      child: Text(
        text,
        style: const TextStyle(fontSize: 11, color: _inkSecondary),
      ),
    );
  }
}
