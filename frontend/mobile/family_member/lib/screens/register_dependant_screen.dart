import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:geolocator/geolocator.dart';
import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:image_picker/image_picker.dart';

import '../api/biometric_enrollments_api.dart';
import '../api/dependants_api.dart';
import '../api/users_api.dart';
import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import '../geo/kenya_areas.dart';

/// Dependant registration in the same step order as the admin web wizard
/// (RegisterDependantPage.tsx): Details, Location, Exact location, Photo.
///
/// Differences from the web wizard, all decided with the user (docs/family-app-plan.md):
/// - Location is three plain dropdowns with no boundary map.
/// - The exact-location pin starts at the phone's current position and isn't checked against the
///   ward's boundary (that would need the 34.6 MB ward shapes).
/// - The radius isn't shown: every family registration gets the standard 20 m.
/// - The caller is always the primary contact, so the contact steps reduce to a relationship field.
///
/// The dependant is created when leaving Exact location; the Photo step then enrolls against the
/// new id, and there is no way back to earlier steps so it can never be created twice.
class RegisterDependantScreen extends StatefulWidget {
  final DependantsApi dependantsApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final UsersApi usersApi;
  final IdentityClaims identity;
  final VoidCallback onDone;

  const RegisterDependantScreen({
    super.key,
    required this.dependantsApi,
    required this.enrollmentsApi,
    required this.usersApi,
    required this.identity,
    required this.onDone,
  });

  @override
  State<RegisterDependantScreen> createState() =>
      _RegisterDependantScreenState();
}

const _stepLabels = ['Details', 'Location', 'Pin', 'Photo'];
const _kenyaCentre = LatLng(0.0236, 37.9062);

class _RegisterDependantScreenState extends State<RegisterDependantScreen> {
  int _step = 0;

  // Details
  final _firstName = TextEditingController();
  final _lastName = TextEditingController();
  final _relationship = TextEditingController();
  final _homeAddress = TextEditingController();
  final _condition = TextEditingController();
  DateTime? _dob;
  String? _gender;
  bool _cognitiveMonitoring = false;

  // Location
  KenyaAreas? _areas;
  Area? _county;
  Area? _constituency;
  Area? _ward;

  // Exact location
  LatLng? _pin;
  CameraPosition? _initialCamera;
  GoogleMapController? _map;

  // Registration and photo
  bool _submitting = false;
  Dependant? _created;
  Uint8List? _photo;
  String? _photoResult; // 'active' | 'flagged' once enrolled

  @override
  void initState() {
    super.initState();
    for (final controller in [_firstName, _lastName]) {
      controller.addListener(() => setState(() {}));
    }
    KenyaAreas.load().then((areas) {
      if (mounted) setState(() => _areas = areas);
    });
  }

  @override
  void dispose() {
    for (final controller in [
      _firstName,
      _lastName,
      _relationship,
      _homeAddress,
      _condition,
    ]) {
      controller.dispose();
    }
    _map?.dispose();
    super.dispose();
  }

  int? get _age => _dob == null ? null : ageOnDate(_dob!, DateTime.now());

  bool get _cognitiveMonitoringAllowed =>
      (_age ?? 0) > cognitiveMonitoringMinAgeExclusive;

  static String? _text(TextEditingController c) =>
      c.text.trim().isEmpty ? null : c.text.trim();

  /// Why Next is disabled on the current step, or null when it can proceed.
  String? get _blocker => switch (_step) {
    0 when _text(_firstName) == null || _text(_lastName) == null =>
      "Enter the dependant's first and last name.",
    0 when _dob == null => 'Choose a date of birth.',
    1 when _ward == null => 'Choose the county, constituency and ward.',
    2 when _pin == null => 'Tap the map to place the pin on the home.',
    _ => null,
  };

  Future<void> _next() async {
    switch (_step) {
      case 1:
        setState(() => _step = 2);
        unawaited(_locateInitialCamera());
      case 2:
        await _register();
      default:
        setState(() => _step++);
    }
  }

  void _back() => setState(() => _step--);

  // ------------------------------------------------------------------------------------------
  // Exact location

  /// Starts the map on the phone's position (the family member is often at the home), falling
  /// back to the chosen county's centre, then Kenya, when location access is refused or slow.
  Future<void> _locateInitialCamera() async {
    if (_initialCamera != null) return;
    final position = await _currentPosition();
    final centre = _county == null ? null : _areas?.centreOf(_county!);
    if (!mounted) return;
    setState(() {
      _initialCamera = switch ((position, centre)) {
        (final LatLng here, _) => CameraPosition(target: here, zoom: 18),
        (null, (:final lat, :final lng)) => CameraPosition(
          target: LatLng(lat, lng),
          zoom: 10,
        ),
        (null, null) => const CameraPosition(target: _kenyaCentre, zoom: 6),
      };
    });
  }

  Future<LatLng?> _currentPosition() async {
    try {
      if (!await Geolocator.isLocationServiceEnabled()) return null;
      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return null;
      }
      final position = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          accuracy: LocationAccuracy.high,
          timeLimit: Duration(seconds: 10),
        ),
      );
      return LatLng(position.latitude, position.longitude);
    } catch (_) {
      // Timeout or platform error - the county/Kenya fallback still lets the pin be placed.
      return null;
    }
  }

  Future<void> _goToMyLocation() async {
    final here = await _currentPosition();
    if (!mounted) return;
    if (here == null) {
      showSnack(
        context,
        'Could not get your location - place the pin by hand.',
      );
      return;
    }
    await _map?.animateCamera(CameraUpdate.newLatLngZoom(here, 18));
  }

  // ------------------------------------------------------------------------------------------
  // Registration

  Future<void> _register() async {
    setState(() => _submitting = true);
    try {
      // POST /dependants needs the caller's phone number and name; the users row (created at
      // sign-up) is the reliable source, not the token's optional claims.
      final me = await widget.usersApi.getMe();
      final dependant = await widget.dependantsApi.registerDependant(
        fullName: '${_text(_firstName)} ${_text(_lastName)}',
        dob: _dob!,
        gender: _gender,
        homeAddressText: _text(_homeAddress),
        primaryConditionSummary: _text(_condition),
        county: _county!.name,
        constituency: _constituency!.name,
        ward: _ward!.name,
        geofenceLat: _pin!.latitude,
        geofenceLng: _pin!.longitude,
        cognitiveMonitoringEnabled:
            _cognitiveMonitoringAllowed && _cognitiveMonitoring,
        selfCognitoSub: widget.identity.sub,
        selfPhoneNumber: me.phoneNumber ?? widget.identity.phoneNumber ?? '',
        selfFullName: me.fullName,
        relationship: _text(_relationship),
      );
      if (!mounted) return;
      setState(() {
        _created = dependant;
        _step = 3;
      });
    } catch (e) {
      if (mounted) showSnack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Photo

  Future<void> _pickPhoto(ImageSource source) async {
    final picked = await ImagePicker().pickImage(
      source: source,
      preferredCameraDevice: CameraDevice.rear,
      maxWidth: 1600,
      imageQuality: 85,
    );
    if (picked == null) return;
    final bytes = await picked.readAsBytes();
    if (mounted) setState(() => _photo = bytes);
  }

  Future<void> _uploadPhoto() async {
    setState(() => _submitting = true);
    try {
      final status = await widget.enrollmentsApi.enrollDependantPhoto(
        dependantId: _created!.id,
        jpegBytes: _photo!,
      );
      if (mounted) setState(() => _photoResult = status);
    } catch (e) {
      // e.g. a 422 for a photo with no face or several faces - the server's detail says which.
      if (mounted) showSnack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Layout

  @override
  Widget build(BuildContext context) {
    return PopScope(
      // Once the dependant exists, leaving means finishing - never stepping back into a form
      // that would register them a second time.
      canPop: _step == 0 || _created != null,
      onPopInvokedWithResult: (didPop, _) {
        if (didPop) return;
        if (!_submitting) _back();
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF7F7F7),
        appBar: AppBar(
          backgroundColor: Colors.white,
          surfaceTintColor: Colors.white,
          title: const Text(
            'Register a dependant',
            style: TextStyle(fontSize: 16),
          ),
          leading: _created != null
              ? IconButton(
                  icon: const Icon(Icons.close),
                  tooltip: 'Done',
                  onPressed: widget.onDone,
                )
              : null,
        ),
        body: Column(
          children: [
            _StepHeader(current: _step),
            Expanded(
              child: switch (_step) {
                0 => _buildDetails(),
                1 => _buildLocation(),
                2 => _buildExactLocation(),
                _ => _buildPhoto(),
              },
            ),
          ],
        ),
        bottomNavigationBar: _buildActions(),
      ),
    );
  }

  Widget _buildActions() {
    final blocker = _blocker;
    final Widget primary;
    final Widget? secondary;
    if (_step == 3) {
      primary = ElevatedButton(
        onPressed: _submitting ? null : widget.onDone,
        style: pillButtonStyle,
        child: Text(_photoResult == null ? 'Skip for now' : 'Finish'),
      );
      secondary = null;
    } else {
      primary = ElevatedButton(
        onPressed: blocker == null && !_submitting ? _next : null,
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
            : Text(_step == 2 ? 'Register' : 'Next'),
      );
      secondary = _step == 0
          ? null
          : OutlinedButton(
              onPressed: _submitting ? null : _back,
              style: OutlinedButton.styleFrom(
                foregroundColor: inkDefault,
                minimumSize: const Size.fromHeight(44),
                side: const BorderSide(color: borderColor),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(999),
                ),
              ),
              child: const Text('Back'),
            );
    }
    return Material(
      color: Colors.white,
      child: SafeArea(
        child: constrainedContent(
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (blocker != null && _step < 3)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: Text(
                      blocker,
                      style: const TextStyle(fontSize: 12, color: inkTertiary),
                    ),
                  ),
                Row(
                  children: [
                    if (secondary != null) ...[
                      Expanded(child: secondary),
                      const SizedBox(width: 12),
                    ],
                    Expanded(child: primary),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _formList(List<Widget> children) => constrainedContent(
    ListView(
      padding: const EdgeInsets.all(16),
      children: [
        for (final child in children)
          Padding(padding: const EdgeInsets.only(bottom: 16), child: child),
      ],
    ),
  );

  Widget _buildDetails() {
    final age = _age;
    return _formList([
      LayoutBuilder(
        builder: (context, constraints) {
          final first = TextField(
            controller: _firstName,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'First name'),
          );
          final last = TextField(
            controller: _lastName,
            textCapitalization: TextCapitalization.words,
            decoration: const InputDecoration(labelText: 'Last name'),
          );
          // Side by side once there's room, as on the web wizard.
          return constraints.maxWidth >= 480
              ? Row(
                  children: [
                    Expanded(child: first),
                    const SizedBox(width: 12),
                    Expanded(child: last),
                  ],
                )
              : Column(children: [first, const SizedBox(height: 16), last]);
        },
      ),
      InkWell(
        onTap: () async {
          final now = DateTime.now();
          final picked = await showDatePicker(
            context: context,
            initialDate: _dob ?? DateTime(now.year - 70),
            firstDate: DateTime(1900),
            lastDate: now,
            initialEntryMode: DatePickerEntryMode.input,
          );
          if (picked != null) setState(() => _dob = picked);
        },
        child: InputDecorator(
          isEmpty: _dob == null,
          decoration: InputDecoration(
            labelText: 'Date of birth',
            suffixIcon: const Icon(Icons.calendar_today_outlined),
            helperText: age == null ? null : '$age years old',
          ),
          child: Text(
            _dob == null
                ? ''
                : MaterialLocalizations.of(context).formatMediumDate(_dob!),
          ),
        ),
      ),
      DropdownButtonFormField<String?>(
        initialValue: _gender,
        decoration: const InputDecoration(labelText: 'Gender'),
        items: const [
          DropdownMenuItem(value: 'female', child: Text('Female')),
          DropdownMenuItem(value: 'male', child: Text('Male')),
          DropdownMenuItem(value: null, child: Text('Not specified')),
        ],
        onChanged: (value) => setState(() => _gender = value),
      ),
      TextField(
        controller: _relationship,
        textCapitalization: TextCapitalization.sentences,
        decoration: const InputDecoration(
          labelText: 'Your relationship to them (optional)',
          hintText: 'e.g. Daughter',
        ),
      ),
      TextField(
        controller: _homeAddress,
        minLines: 2,
        maxLines: 4,
        textCapitalization: TextCapitalization.sentences,
        decoration: const InputDecoration(
          labelText: 'Home address details (optional)',
          hintText: 'House number, estate, nearby landmark',
          alignLabelWithHint: true,
        ),
      ),
      TextField(
        controller: _condition,
        minLines: 2,
        maxLines: 4,
        textCapitalization: TextCapitalization.sentences,
        decoration: const InputDecoration(
          labelText: 'Primary condition (optional)',
          hintText: 'e.g. Type 2 diabetes, needs help walking',
          alignLabelWithHint: true,
        ),
      ),
      SwitchListTile(
        contentPadding: EdgeInsets.zero,
        value: _cognitiveMonitoringAllowed && _cognitiveMonitoring,
        onChanged: _cognitiveMonitoringAllowed
            ? (value) => setState(() => _cognitiveMonitoring = value)
            : null,
        title: const Text('Cognitive monitoring'),
        subtitle: Text(
          _cognitiveMonitoringAllowed
              ? 'Uses short audio recordings from visits to watch for changes.'
              : 'Available only for dependants over the age of '
                    '$cognitiveMonitoringMinAgeExclusive.',
          style: const TextStyle(fontSize: 12, color: inkTertiary),
        ),
      ),
    ]);
  }

  Widget _buildLocation() {
    final areas = _areas;
    if (areas == null) {
      return const Center(child: CircularProgressIndicator());
    }
    return _formList([
      const Text(
        'Where does the dependant live?',
        style: TextStyle(fontSize: 14, color: inkSecondary),
      ),
      _AreaMenu(
        label: 'County',
        options: areas.counties,
        value: _county,
        onSelected: (area) => setState(() {
          _county = area;
          _constituency = null;
          _ward = null;
          // A different county means the old pin (and map start) no longer apply.
          _pin = null;
          _initialCamera = null;
        }),
      ),
      _AreaMenu(
        // Keyed on the parent, so choosing a different county starts this one empty again.
        key: ValueKey('constituency-${_county?.code}'),
        label: 'Constituency',
        options: _county == null ? const [] : areas.constituenciesOf(_county!),
        value: _constituency,
        enabled: _county != null,
        onSelected: (area) => setState(() {
          _constituency = area;
          _ward = null;
        }),
      ),
      _AreaMenu(
        key: ValueKey('ward-${_constituency?.code}'),
        label: 'Ward',
        options: _constituency == null
            ? const []
            : areas.wardsOf(_constituency!),
        value: _ward,
        enabled: _constituency != null,
        onSelected: (area) => setState(() => _ward = area),
      ),
    ]);
  }

  Widget _buildExactLocation() {
    final camera = _initialCamera;
    if (camera == null) {
      return const Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: 12),
            Text(
              'Finding your location...',
              style: TextStyle(color: inkSecondary),
            ),
          ],
        ),
      );
    }
    final pin = _pin;
    return Stack(
      children: [
        GoogleMap(
          initialCameraPosition: camera,
          onMapCreated: (controller) => _map = controller,
          onTap: (point) => setState(() => _pin = point),
          myLocationEnabled: true,
          myLocationButtonEnabled: false,
          markers: {
            if (pin != null)
              Marker(
                markerId: const MarkerId('home'),
                position: pin,
                draggable: true,
                onDragEnd: (point) => setState(() => _pin = point),
              ),
          },
          circles: {
            if (pin != null)
              Circle(
                circleId: const CircleId('check-in-area'),
                center: pin,
                radius: standardGeofenceRadiusMeters.toDouble(),
                strokeWidth: 2,
                strokeColor: primaryBlue,
                fillColor: primaryBlue.withValues(alpha: 0.12),
              ),
          },
        ),
        Positioned(
          top: 12,
          right: 12,
          child: Material(
            color: Colors.white,
            shape: const CircleBorder(side: BorderSide(color: borderColor)),
            elevation: 2,
            child: IconButton(
              icon: const Icon(Icons.my_location, color: primaryBlue),
              tooltip: 'My location',
              onPressed: _goToMyLocation,
            ),
          ),
        ),
        Positioned(
          left: 12,
          right: 12,
          bottom: 12,
          child: constrainedContent(
            Container(
              padding: const EdgeInsets.all(12),
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(12),
                border: Border.all(color: borderColor),
              ),
              child: Text(
                pin == null
                    ? "Tap the dependant's home on the map."
                    : 'Pin placed. Drag it to adjust - caregivers check in within '
                          '$standardGeofenceRadiusMeters m of it.',
                style: const TextStyle(fontSize: 13, color: inkSecondary),
              ),
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildPhoto() {
    final photo = _photo;
    final name = _created?.fullName ?? 'the dependant';
    return _formList([
      Text(
        '$name is registered. Add a clear photo of their face - caregivers '
        'confirm who they are visiting against it at every check-in.',
        style: const TextStyle(fontSize: 14, color: inkSecondary),
      ),
      if (photo != null)
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: AspectRatio(
            aspectRatio: 1,
            child: Image.memory(photo, fit: BoxFit.cover),
          ),
        ),
      switch (_photoResult) {
        'active' => const _ResultBanner(ok: true, text: 'Photo accepted.'),
        'flagged' => const _ResultBanner(
          ok: false,
          text:
              'This face looks like someone already enrolled, so a supervisor '
              'will review the photo.',
        ),
        _ => Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (photo != null) ...[
              ElevatedButton(
                onPressed: _submitting ? null : _uploadPhoto,
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
                    : const Text('Use this photo'),
              ),
              const SizedBox(height: 8),
            ],
            Row(
              children: [
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _submitting
                        ? null
                        : () => _pickPhoto(ImageSource.camera),
                    icon: const Icon(Icons.photo_camera_outlined),
                    label: const Text('Take photo'),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: OutlinedButton.icon(
                    onPressed: _submitting
                        ? null
                        : () => _pickPhoto(ImageSource.gallery),
                    icon: const Icon(Icons.photo_library_outlined),
                    label: const Text('Gallery'),
                  ),
                ),
              ],
            ),
          ],
        ),
      },
    ]);
  }
}

class _StepHeader extends StatelessWidget {
  final int current;
  const _StepHeader({required this.current});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      child: constrainedContent(
        Row(
          children: [
            for (final (i, label) in _stepLabels.indexed)
              Expanded(
                child: Column(
                  children: [
                    CircleAvatar(
                      radius: 12,
                      backgroundColor: i <= current ? primaryBlue : borderColor,
                      foregroundColor: i <= current
                          ? Colors.white
                          : inkSecondary,
                      child: i < current
                          ? const Icon(Icons.check, size: 14)
                          : Text(
                              '${i + 1}',
                              style: const TextStyle(fontSize: 12),
                            ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: i == current ? inkDefault : inkTertiary,
                        fontWeight: i == current
                            ? FontWeight.w500
                            : FontWeight.normal,
                      ),
                    ),
                  ],
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A searchable dropdown: typing filters the list, which matters for the 47 counties.
class _AreaMenu extends StatelessWidget {
  final String label;
  final List<Area> options;
  final Area? value;
  final bool enabled;
  final ValueChanged<Area> onSelected;

  const _AreaMenu({
    super.key,
    required this.label,
    required this.options,
    required this.value,
    required this.onSelected,
    this.enabled = true,
  });

  @override
  Widget build(BuildContext context) {
    return DropdownMenu<Area>(
      label: Text(label),
      initialSelection: value,
      enabled: enabled,
      enableFilter: true,
      requestFocusOnTap: true,
      expandedInsets: EdgeInsets.zero,
      menuHeight: 320,
      dropdownMenuEntries: [
        for (final area in options)
          DropdownMenuEntry(value: area, label: area.name),
      ],
      onSelected: (area) {
        if (area != null) onSelected(area);
      },
    );
  }
}

class _ResultBanner extends StatelessWidget {
  final bool ok;
  final String text;
  const _ResultBanner({required this.ok, required this.text});

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: ok ? successTint : dangerTint,
      borderRadius: BorderRadius.circular(12),
    ),
    child: Row(
      children: [
        Icon(
          ok ? Icons.check_circle : Icons.info_outline,
          color: ok ? successGreen : dangerRed,
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: TextStyle(color: ok ? successGreen : dangerRed),
          ),
        ),
      ],
    ),
  );
}
