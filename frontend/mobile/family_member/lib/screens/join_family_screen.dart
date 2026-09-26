import 'package:flutter/material.dart';

import '../api/family_link_requests_api.dart';
import '../app_ui.dart';
import '../utils/kenyan_phone.dart';

/// A family member asks a dependant's primary contact to link them (2026-09-26, user request).
/// The answer never says whether the contact matched anyone (user decision), so the confirmation
/// is worded for both outcomes; the request then shows as pending in the bell until the primary
/// contact answers.
class JoinFamilyScreen extends StatefulWidget {
  final FamilyLinkRequestsApi linkRequestsApi;

  const JoinFamilyScreen({super.key, required this.linkRequestsApi});

  @override
  State<JoinFamilyScreen> createState() => _JoinFamilyScreenState();
}

class _JoinFamilyScreenState extends State<JoinFamilyScreen> {
  final _contact = TextEditingController();
  final _relationship = TextEditingController();
  bool _sending = false;
  bool _sent = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _contact.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _contact.dispose();
    _relationship.dispose();
    super.dispose();
  }

  /// The email as typed, or the phone number in the E.164 form the server expects; null when
  /// it's neither.
  String? get _normalizedContact {
    final text = _contact.text.trim();
    if (text.contains('@')) {
      return RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(text) ? text : null;
    }
    return normalizeKenyanPhoneNumber(text);
  }

  Future<void> _send() async {
    final contact = _normalizedContact;
    if (contact == null) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final relationship = _relationship.text.trim();
      await widget.linkRequestsApi.request(
        contact: contact,
        relationship: relationship.isEmpty ? null : relationship,
      );
      if (mounted) setState(() => _sent = true);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.white,
        title: const Text('Join a family', style: TextStyle(fontSize: 16)),
      ),
      body: constrainedContent(
        ListView(
          padding: const EdgeInsets.all(20),
          children: _sent ? _buildSent() : _buildForm(),
        ),
      ),
    );
  }

  List<Widget> _buildForm() {
    final contact = _contact.text.trim();
    final invalid = contact.isNotEmpty && _normalizedContact == null;
    return [
      const Text(
        "To be linked to a dependant someone else registered, ask their primary contact - "
        'usually the family member who registered them. Enter the email or phone number they '
        'use for Mzazi Care, and they can approve your request in their app.',
        style: TextStyle(fontSize: 14, color: inkSecondary),
      ),
      const SizedBox(height: 16),
      TextField(
        controller: _contact,
        keyboardType: TextInputType.emailAddress,
        autocorrect: false,
        decoration: InputDecoration(
          labelText: "Primary contact's email or phone",
          errorText: invalid
              ? 'Enter an email address or a Kenyan phone number.'
              : null,
        ),
      ),
      const SizedBox(height: 12),
      TextField(
        controller: _relationship,
        textCapitalization: TextCapitalization.words,
        decoration: const InputDecoration(
          labelText: 'Your relationship to the dependant (optional)',
          hintText: 'e.g. Grandson',
        ),
      ),
      const SizedBox(height: 20),
      if (_error case final error?)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Text(error, style: const TextStyle(color: dangerRed)),
        ),
      ElevatedButton(
        onPressed: _sending || _normalizedContact == null ? null : _send,
        style: pillButtonStyle,
        child: _sending
            ? const SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            : const Text('Send request'),
      ),
    ];
  }

  List<Widget> _buildSent() => [
    const Icon(Icons.mark_email_read_outlined, size: 40, color: primaryBlue),
    const SizedBox(height: 12),
    const Text(
      'Request sent',
      textAlign: TextAlign.center,
      style: TextStyle(
        fontSize: 18,
        fontWeight: FontWeight.w600,
        color: inkDefault,
      ),
    ),
    const SizedBox(height: 8),
    // Worded for both outcomes: the server doesn't say whether the contact matched anyone.
    const Text(
      "If that person is a dependant's primary contact, they'll get your request. You'll see "
      "their answer under the bell on your home screen.",
      textAlign: TextAlign.center,
      style: TextStyle(fontSize: 14, color: inkSecondary),
    ),
    const SizedBox(height: 20),
    ElevatedButton(
      onPressed: () => Navigator.of(context).pop(true),
      style: pillButtonStyle,
      child: const Text('Done'),
    ),
  ];
}
