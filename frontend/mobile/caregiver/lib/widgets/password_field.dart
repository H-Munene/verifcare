import 'package:flutter/material.dart';

/// Cognito's password policy for this pool (infra/lib/auth.ts leaves Cognito's default), in the words shown under the new-password field.
/// Cognito still checks it and its own message is shown if a password falls short.
const passwordPolicyHint =
    'At least 8 characters, with an upper-case letter, a lower-case letter, a number and a '
    'symbol.';

/// A password [TextFormField] with a show/hide toggle, so a password typed on a phone keyboard can
/// be checked before it's submitted. Every password field in the app uses this, so they all behave
/// the same way.
class PasswordField extends StatefulWidget {
  final TextEditingController controller;
  final String labelText;
  final String? helperText;
  final Iterable<String> autofillHints;
  final FormFieldValidator<String>? validator;

  const PasswordField({
    super.key,
    required this.controller,
    required this.labelText,
    this.helperText,
    this.autofillHints = const [AutofillHints.password],
    this.validator,
  });

  @override
  State<PasswordField> createState() => _PasswordFieldState();
}

class _PasswordFieldState extends State<PasswordField> {
  bool _obscured = true;

  @override
  Widget build(BuildContext context) {
    return TextFormField(
      controller: widget.controller,
      obscureText: _obscured,
      autocorrect: false,
      enableSuggestions: false,
      autofillHints: widget.autofillHints,
      validator: widget.validator,
      decoration: InputDecoration(
        labelText: widget.labelText,
        helperText: widget.helperText,
        helperMaxLines: 3,
        suffixIcon: IconButton(
          icon: Icon(
            _obscured
                ? Icons.visibility_outlined
                : Icons.visibility_off_outlined,
          ),
          tooltip: _obscured ? 'Show password' : 'Hide password',
          onPressed: () => setState(() => _obscured = !_obscured),
        ),
      ),
    );
  }
}
