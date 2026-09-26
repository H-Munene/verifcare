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

/// Registering or editing a dependant, in the same step order as the admin web wizard
/// (RegisterDependantPage.tsx): Details, Location, Pin, Photo.
///
/// Differences from the web wizard, all decided with the user (docs/family-app-plan.md):
/// - Location is three plain dropdowns with no boundary map.
/// - The pin starts at the phone's current position and isn't checked against the ward's
///   boundary (that would need the 34.6 MB ward shapes).
/// - The radius is never shown: registration always uses the standard 20 m, and only a supervisor
///   may change it afterwards.
/// - The caller is always the primary contact, so the contact steps reduce to a relationship field.
///
/// Registering creates the dependant when leaving the Pin step; the Photo step then enrolls
/// against the new id, and there is no way back to earlier steps so it can never be created twice.
///
/// Editing (primary contact only) is the same steps pre-filled, with Save available from any
/// step, as on the web. Date of birth can't be changed (the backend doesn't allow it), and the
/// relationship field is left out because changing a family link is supervisor-only. The screen
/// pops with the updated Dependant on save.
class DependantWizardScreen extends StatefulWidget {
  final DependantsApi dependantsApi;
  final BiometricEnrollmentsApi enrollmentsApi;
  final Dependant? existing;

  /// Editing only: the step to open on - e.g. the Photo step (3) from the "photo needed" banner.
  final int initialStep;
  // Registration only.
  final UsersApi? usersApi;
  final IdentityClaims? identity;
  final VoidCallback? onDone;

  const DependantWizardScreen.register({
    super.key,
    required this.dependantsApi,
    required this.enrollmentsApi,
    required UsersApi this.usersApi,
    required IdentityClaims this.identity,
    required VoidCallback this.onDone,
  }) : existing = null,
       initialStep = 0;

  const DependantWizardScreen.edit({
    super.key,
    required this.dependantsApi,
    required this.enrollmentsApi,
    required Dependant this.existing,
    this.initialStep = 0,
  }) : usersApi = null,
       identity = null,
       onDone = null;

  @override
  State<DependantWizardScreen> createState() => _DependantWizardScreenState();
}

const _stepLabels = ['Details', 'Location', 'Pin', 'Photo'];
const _kenyaCentre = LatLng(0.0236, 37.9062);

class _DependantWizardScreenState extends State<DependantWizardScreen> {
  late int _step = widget.initialStep;

  bool get _editing => widget.existing != null;

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
  List<BiometricEnrollment>? _currentPhotos; // editing: what's enrolled already

  @override
  void initState() {
    super.initState();
    if (widget.existing case final existing?) _prefill(existing);
    for (final controller in [
      _firstName,
      _lastName,
      _homeAddress,
      _condition,
    ]) {
      controller.addListener(() => setState(() {}));
    }
    KenyaAreas.load().then((areas) {
      if (!mounted) return;
      setState(() {
        _areas = areas;
        // The API stores plain names, so a saved location is matched back to the lists by name.
        // Anything that no longer matches (e.g. renamed data) is simply left for re-selection.
        if (widget.existing case final existing?) {
          _county = KenyaAreas.byName(areas.counties, existing.county);
          _constituency = _county == null
              ? null
              : KenyaAreas.byName(
                  areas.constituenciesOf(_county!),
                  existing.constituency,
                );
          _ward = _constituency == null
              ? null
              : KenyaAreas.byName(areas.wardsOf(_constituency!), existing.ward);
        }
      });
    });
  }

  void _prefill(Dependant existing) {
    // Split at the first space, the same rule as the web wizard's splitFullName.
    final name = existing.fullName.trim();
    final space = name.indexOf(' ');
    _firstName.text = space == -1 ? name : name.substring(0, space);
    _lastName.text = space == -1 ? '' : name.substring(space + 1);
    _homeAddress.text = existing.homeAddressText ?? '';
    _condition.text = existing.primaryConditionSummary ?? '';
    _dob = existing.dob;
    _gender = existing.gender;
    _cognitiveMonitoring = existing.cognitiveMonitoringEnabled;
    _pin = LatLng(existing.geofenceLat, existing.geofenceLng);
    _initialCamera = CameraPosition(target: _pin!, zoom: 18);
    _loadCurrentPhotos();
  }

  Future<void> _loadCurrentPhotos() async {
    try {
      final photos = await widget.enrollmentsApi.listCurrentForDependant(
        widget.existing!.id,
      );
      photos.sort((a, b) => a.imageOrder.compareTo(b.imageOrder));
      if (mounted) setState(() => _currentPhotos = photos);
    } catch (_) {
      // Only a preview of the current photo - replacing one still works without it.
      if (mounted) setState(() => _currentPhotos = const []);
    }
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
    0 => _detailsBlocker,
    1 when _ward == null => 'Choose the county, constituency and ward.',
    2 when _pin == null => 'Tap the map to place the pin on the home.',
    _ => null,
  };

  String? get _detailsBlocker {
    if (_text(_firstName) == null || _text(_lastName) == null) {
      return "Enter the dependant's first and last name.";
    }
    if (_dob == null) return 'Choose a date of birth.';
    // The API can't clear an optional text field once set, so saving an emptied one would
    // silently keep the old value - say so up front instead.
    final existing = widget.existing;
    if (existing?.homeAddressText != null && _text(_homeAddress) == null) {
      return 'Home address details can be changed, but not removed.';
    }
    if (existing?.primaryConditionSummary != null &&
        _text(_condition) == null) {
      return 'Primary condition can be changed, but not removed.';
    }
    return null;
  }

  /// Why Save is disabled when editing - every step's requirement at once, since Save works from
  /// any step.
  String? get _saveBlocker =>
      _detailsBlocker ??
      (_ward == null ? 'Choose the county, constituency and ward.' : null) ??
      // Changing the county clears the pin, and _save needs one - without this, Save from the
      // title bar after a county change would throw on the missing pin.
      (_pin == null ? 'Tap the map to place the pin on the home.' : null);

  /// Editing only: every step is already filled in and Save checks them all, so the step header
  /// lets the user jump straight to any step instead of paging through with Next/Back.
  void _goToStep(int step) {
    if (step == _step || _submitting) return;
    setState(() => _step = step);
    // Same map start as arriving by Next (a no-op when the saved pin already set it).
    if (step == 2) unawaited(_locateInitialCamera());
  }

  Future<void> _next() async {
    switch (_step) {
      case 1:
        setState(() => _step = 2);
        unawaited(_locateInitialCamera());
      case 2 when !_editing:
        await _register();
      default:
        setState(() => _step++);
    }
  }

  Future<void> _save() async {
    setState(() => _submitting = true);
    try {
      // Save is the one button for the whole edit, so it also enrols a replacement photo.
      // Photo first: a rejected one (no face, several faces) stops here with nothing saved, and a
      // retry after a failed PATCH skips the photo that already went through.
      if (_photo case final photo? when _photoResult == null) {
        final status = await widget.enrollmentsApi.enrollDependantPhoto(
          dependantId: widget.existing!.id,
          jpegBytes: photo,
        );
        if (mounted) setState(() => _photoResult = status);
      }
      final updated = await widget.dependantsApi.updateDependant(
        widget.existing!.id,
        fullName: '${_text(_firstName)} ${_text(_lastName)}',
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
      );
      if (!mounted) return;
      // The screen closes, so the review notice goes in a snack that outlives it.
      if (_photoResult == 'flagged') {
        showSnack(
          context,
          'Saved. The new photo looks like someone already enrolled, so a '
          'supervisor will review it.',
          error: false,
        );
      }
      Navigator.of(context).pop(updated);
    } catch (e) {
      if (mounted) showSnack(context, errorText(e));
    } finally {
      if (mounted) setState(() => _submitting = false);
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
      final me = await widget.usersApi!.getMe();
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
        selfCognitoSub: widget.identity!.sub,
        selfPhoneNumber: me.phoneNumber ?? widget.identity!.phoneNumber ?? '',
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
        dependantId: (_created ?? widget.existing)!.id,
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
      // that would register them a second time. Otherwise back steps back through the wizard.
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
          title: Text(
            _editing ? 'Edit details' : 'Register a dependant',
            style: const TextStyle(fontSize: 16),
          ),
          actions: [
            if (_editing)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: TextButton(
                  onPressed: _saveBlocker == null && !_submitting
                      ? _save
                      : null,
                  child: const Text('Save'),
                ),
              ),
          ],
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
            _StepHeader(current: _step, onStepTap: _editing ? _goToStep : null),
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
    final blocker = _editing && _step == 3 ? _saveBlocker : _blocker;
    final Widget primary;
    final Widget? secondary;
    final back = OutlinedButton(
      onPressed: _submitting ? null : _back,
      style: OutlinedButton.styleFrom(
        foregroundColor: inkDefault,
        minimumSize: const Size.fromHeight(44),
        side: const BorderSide(color: borderColor),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
      ),
      child: const Text('Back'),
    );
    if (_editing && _step == 3) {
      primary = ElevatedButton(
        onPressed: blocker == null && !_submitting ? _save : null,
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
            : const Text('Save'),
      );
      secondary = back;
    } else if (_step == 3) {
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
            : Text(_step == 2 && !_editing ? 'Register' : 'Next'),
      );
      secondary = _step == 0 ? null : back;
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
                if (blocker != null && (_step < 3 || _editing))
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
        // Date of birth can't be changed after registration - the backend doesn't accept it.
        onTap: _editing
            ? null
            : () async {
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
            enabled: !_editing,
            suffixIcon: const Icon(Icons.calendar_today_outlined),
            helperText: switch ((age, _editing)) {
              (null, _) => null,
              (final age, true) => "$age years old · can't be changed",
              (final age, false) => '$age years old',
            },
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
        items: [
          const DropdownMenuItem(value: 'female', child: Text('Female')),
          const DropdownMenuItem(value: 'male', child: Text('Male')),
          // A gender, once saved, can be changed but not cleared (the API has no way to).
          if (widget.existing?.gender == null)
            const DropdownMenuItem(value: null, child: Text('Not specified')),
        ],
        onChanged: (value) => setState(() => _gender = value),
      ),
      // Changing an existing family link is supervisor-only, so only asked when registering.
      if (!_editing)
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
    final current = _currentPhotos?.firstOrNull;
    return _formList([
      Text(
        _editing
            ? 'Caregivers confirm who they are visiting against this photo at '
                  'every check-in. Replace it if it no longer looks like them - '
                  'the new photo is used once you save.'
            : '$name is registered. Add a clear photo of their face - caregivers '
                  'confirm who they are visiting against it at every check-in.',
        style: const TextStyle(fontSize: 14, color: inkSecondary),
      ),
      // Editing, before a replacement is picked: the photo enrolled today.
      if (_editing && photo == null)
        switch ((_currentPhotos, current)) {
          (null, _) => const Center(child: CircularProgressIndicator()),
          (_, null) => const Text(
            'No photo enrolled yet.',
            style: TextStyle(color: inkTertiary),
          ),
          (_, final current?) => ClipRRect(
            borderRadius: BorderRadius.circular(12),
            child: AspectRatio(
              aspectRatio: 1,
              child: Image.network(
                current.imageUrl,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const Center(
                  child: Text(
                    'Could not load the current photo.',
                    style: TextStyle(color: inkTertiary),
                  ),
                ),
              ),
            ),
          ),
        },
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
            // Registering has no Save - Finish only closes - so the upload needs its own button.
            if (photo != null && !_editing) ...[
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

  /// Set when editing: each step becomes a button that jumps to it.
  final ValueChanged<int>? onStepTap;

  const _StepHeader({required this.current, this.onStepTap});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: Colors.white,
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 12),
      child: constrainedContent(
        Row(
          children: [
            for (final (i, label) in _stepLabels.indexed)
              Expanded(child: _step(i, label)),
          ],
        ),
      ),
    );
  }

  Widget _step(int i, String label) {
    final onTap = onStepTap;
    // Editing: every step is filled in, so the others show as reachable (tinted) rather than as
    // done or not-yet-reached.
    final (Color background, Color foreground) = switch ((onTap, i)) {
      (_, _) when i == current => (primaryBlue, Colors.white),
      (final _?, _) => (primaryBlue.withValues(alpha: 0.12), primaryBlue),
      (null, _) when i < current => (primaryBlue, Colors.white),
      (null, _) => (borderColor, inkSecondary),
    };
    final column = Column(
      children: [
        CircleAvatar(
          radius: 12,
          backgroundColor: background,
          foregroundColor: foreground,
          child: onTap == null && i < current
              ? const Icon(Icons.check, size: 14)
              : Text('${i + 1}', style: const TextStyle(fontSize: 12)),
        ),
        const SizedBox(height: 4),
        Text(
          label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            fontSize: 12,
            color: i == current ? inkDefault : inkTertiary,
            fontWeight: i == current ? FontWeight.w500 : FontWeight.normal,
          ),
        ),
      ],
    );
    if (onTap == null) return column;
    return Semantics(
      button: true,
      selected: i == current,
      label: 'Step ${i + 1}, $label',
      excludeSemantics: true,
      child: InkWell(
        onTap: () => onTap(i),
        borderRadius: BorderRadius.circular(8),
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: column,
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
