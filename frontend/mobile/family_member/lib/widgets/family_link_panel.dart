import 'package:flutter/material.dart';

import '../api/api_client.dart';
import '../api/dependants_api.dart';
import '../app_ui.dart';

/// The primary contact links someone who already has a Mzazi Care account, by the email they
/// signed up with, straight away (2026-09-26, user request). Someone without an account can't be
/// created from here: they sign up in the app and send a link request, which the primary contact
/// approves from the bell on the home screen - the note says so, and so does the server's answer
/// when no account uses the email. Used by the registration/edit wizard's Family step and the
/// dependant page's Family tab.
class FamilyLinkPanel extends StatefulWidget {
  final DependantsApi dependantsApi;
  final String dependantId;
  final ValueChanged<FamilyMemberLink> onLinked;

  const FamilyLinkPanel({
    super.key,
    required this.dependantsApi,
    required this.dependantId,
    required this.onLinked,
  });

  @override
  State<FamilyLinkPanel> createState() => _FamilyLinkPanelState();
}

class _FamilyLinkPanelState extends State<FamilyLinkPanel> {
  final _email = TextEditingController();
  final _relationship = TextEditingController();
  bool _linking = false;
  String? _error;
  String? _linkedName;

  @override
  void initState() {
    super.initState();
    _email.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _email.dispose();
    _relationship.dispose();
    super.dispose();
  }

  bool get _emailLooksValid {
    final email = _email.text.trim();
    return RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email);
  }

  Future<void> _link() async {
    setState(() {
      _linking = true;
      _error = null;
      _linkedName = null;
    });
    try {
      final relationship = _relationship.text.trim();
      final member = await widget.dependantsApi.linkExistingMember(
        widget.dependantId,
        email: _email.text.trim(),
        relationship: relationship.isEmpty ? null : relationship,
      );
      if (!mounted) return;
      _email.clear();
      _relationship.clear();
      setState(() => _linkedName = member.fullName);
      widget.onLinked(member);
    } on ApiException catch (e) {
      // 404 (no account - the detail explains the request route), 409 (already linked).
      if (mounted) setState(() => _error = e.problem.detail ?? e.problem.title);
    } catch (e) {
      if (mounted) setState(() => _error = errorText(e));
    } finally {
      if (mounted) setState(() => _linking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Link someone who already has a VerifCare account, using the email they signed up '
          "with. If they don't have an account yet, they can create one in the app and send you "
          'a request to link them, which you can approve from the bell on your home screen.',
          style: TextStyle(fontSize: 13, color: inkSecondary),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _email,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          decoration: const InputDecoration(labelText: 'Their email'),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: _relationship,
          textCapitalization: TextCapitalization.words,
          decoration: const InputDecoration(
            labelText: 'Their relationship to the dependant (optional)',
            hintText: 'e.g. Grandson',
          ),
        ),
        const SizedBox(height: 12),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              error,
              style: const TextStyle(fontSize: 13, color: dangerRed),
            ),
          ),
        if (_linkedName case final name?)
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              '$name is now linked.',
              style: const TextStyle(fontSize: 13, color: successGreen),
            ),
          ),
        OutlinedButton.icon(
          onPressed: _linking || !_emailLooksValid ? null : _link,
          icon: _linking
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.person_add_alt_1_outlined),
          label: const Text('Link family member'),
        ),
      ],
    );
  }
}
