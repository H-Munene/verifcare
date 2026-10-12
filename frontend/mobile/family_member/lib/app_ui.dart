import 'package:flutter/material.dart';

import 'api/api_client.dart';

// The app palette, copied from frontend/mobile/caregiver/lib/app_ui.dart so both mobile apps look
// the same (the two apps deliberately share no package - user decision 2026-09-24). The older
// auth screens still use the plain Material theme.
const primaryGreen = Color(0xFF047857);
const successGreen = Color(0xFF15B042);
const successTint = Color(0xFFCAFCE0);
const dangerRed = Color(0xFFE0392B);
const dangerTint = Color(0xFFFDE8E6);
const inkDefault = Color(0xFF292929);
const inkSecondary = Color(0xFF525252);
const inkTertiary = Color(0xFF9E9E9E);
const borderColor = Color(0xFFE5E5E5);
const waveformIdle = Color(0xFFE5E5E5);

final pillButtonStyle = ElevatedButton.styleFrom(
  backgroundColor: primaryGreen,
  foregroundColor: Colors.white,
  disabledBackgroundColor: primaryGreen.withValues(alpha: 0.4),
  disabledForegroundColor: Colors.white,
  minimumSize: const Size.fromHeight(44),
  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(999)),
  elevation: 0,
);

/// Readable line length for the visit-flow screens on tablets, foldables and landscape - they
/// were designed phone-first and would otherwise stretch edge to edge.
const contentMaxWidth = 600.0;

// heightFactor: 1 so it hugs its child's height - without it, used as a Scaffold's
// bottomNavigationBar, it would stretch to the whole screen.
Widget constrainedContent(Widget child) => Align(
  alignment: Alignment.topCenter,
  heightFactor: 1,
  child: ConstrainedBox(
    constraints: const BoxConstraints(maxWidth: contentMaxWidth),
    child: child,
  ),
);

/// A readable message for anything a load can throw: the server's own Problem detail for an API
/// error, a connectivity hint for anything else (no network, timeout).
String errorText(Object error) => switch (error) {
  ApiException(:final problem) => problem.detail ?? problem.title,
  _ => 'Could not reach the server. Check your connection and try again.',
};

void showSnack(BuildContext context, String message, {bool error = true}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: error ? dangerRed : inkDefault,
        behavior: SnackBarBehavior.floating,
      ),
    );
}
