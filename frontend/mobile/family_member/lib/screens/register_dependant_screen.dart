import 'package:flutter/material.dart';

import '../api/dependants_api.dart';
import '../auth/cognito_auth_service.dart';

/// Minimal form matching backend/src/routes/dependants.ts's createDependantRequestSchema.
/// primaryFamilyMember is always the signed-in caller - a family_member caller may only name
/// themselves as primary contact (enforced server-side too), matching this app's scope.
class RegisterDependantScreen extends StatefulWidget {
  final DependantsApi dependantsApi;
  final IdentityClaims identity;
  final VoidCallback onDone;

  const RegisterDependantScreen({
    super.key,
    required this.dependantsApi,
    required this.identity,
    required this.onDone,
  });

  @override
  State<RegisterDependantScreen> createState() => _RegisterDependantScreenState();
}

class _RegisterDependantScreenState extends State<RegisterDependantScreen> {
  final _formKey = GlobalKey<FormState>();
  final _fullNameController = TextEditingController();
  final _dobController = TextEditingController();
  final _homeAddressController = TextEditingController();
  final _relationshipController = TextEditingController();

  // 20m default, matching the web app's settled geofence default (docs/project-state.md) -
  // typical smartphone GPS accuracy (~5m under open sky, worse indoors) leaves too thin a margin
  // at the originally-proposed 10m.
  final _latController = TextEditingController();
  final _lngController = TextEditingController();
  final _radiusController = TextEditingController(text: '20');

  bool _cognitiveMonitoringEnabled = false;
  bool _submitting = false;
  String? _error;

  @override
  void dispose() {
    _fullNameController.dispose();
    _dobController.dispose();
    _homeAddressController.dispose();
    _relationshipController.dispose();
    _latController.dispose();
    _lngController.dispose();
    _radiusController.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) {
      return;
    }
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      await widget.dependantsApi.registerDependant(
        fullName: _fullNameController.text.trim(),
        dob: _dobController.text.trim(),
        homeAddressText:
            _homeAddressController.text.trim().isEmpty ? null : _homeAddressController.text.trim(),
        geofenceLat: double.parse(_latController.text.trim()),
        geofenceLng: double.parse(_lngController.text.trim()),
        geofenceRadiusMeters: int.parse(_radiusController.text.trim()),
        cognitiveMonitoringEnabled: _cognitiveMonitoringEnabled,
        selfCognitoSub: widget.identity.sub,
        selfPhoneNumber: widget.identity.phoneNumber ?? '',
        selfFullName: widget.identity.fullName ?? '',
        relationship:
            _relationshipController.text.trim().isEmpty ? null : _relationshipController.text.trim(),
      );
      widget.onDone();
    } catch (err) {
      setState(() => _error = 'Could not register the dependant: $err');
    } finally {
      if (mounted) {
        setState(() => _submitting = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Register a dependant')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Form(
          key: _formKey,
          child: ListView(
            children: [
              TextFormField(
                controller: _fullNameController,
                decoration: const InputDecoration(labelText: 'Dependant full name'),
                validator: (value) =>
                    (value == null || value.trim().isEmpty) ? 'Full name is required.' : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _dobController,
                decoration: const InputDecoration(labelText: 'Date of birth (YYYY-MM-DD)'),
                validator: (value) {
                  if (value == null || value.trim().isEmpty) {
                    return 'Date of birth is required.';
                  }
                  if (!RegExp(r'^\d{4}-\d{2}-\d{2}$').hasMatch(value.trim())) {
                    return 'Use the format YYYY-MM-DD.';
                  }
                  return null;
                },
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _homeAddressController,
                decoration: const InputDecoration(labelText: 'Home address (optional)'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _relationshipController,
                decoration: const InputDecoration(labelText: 'Your relationship (optional)'),
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _latController,
                keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
                decoration: const InputDecoration(labelText: 'Geofence latitude'),
                validator: (value) => (value == null || double.tryParse(value.trim()) == null)
                    ? 'Enter a valid latitude.'
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _lngController,
                keyboardType: const TextInputType.numberWithOptions(decimal: true, signed: true),
                decoration: const InputDecoration(labelText: 'Geofence longitude'),
                validator: (value) => (value == null || double.tryParse(value.trim()) == null)
                    ? 'Enter a valid longitude.'
                    : null,
              ),
              const SizedBox(height: 12),
              TextFormField(
                controller: _radiusController,
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(labelText: 'Geofence radius (meters)'),
                validator: (value) => (value == null || int.tryParse(value.trim()) == null)
                    ? 'Enter a valid whole number of meters.'
                    : null,
              ),
              const SizedBox(height: 12),
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                title: const Text('Enable cognitive monitoring'),
                value: _cognitiveMonitoringEnabled,
                onChanged: (value) => setState(() => _cognitiveMonitoringEnabled = value),
              ),
              const SizedBox(height: 12),
              if (_error != null) ...[
                Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error)),
                const SizedBox(height: 12),
              ],
              FilledButton(
                onPressed: _submitting ? null : _submit,
                child: Text(_submitting ? 'Registering...' : 'Register dependant'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
