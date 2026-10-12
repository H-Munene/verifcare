import 'package:flutter/material.dart';

// The wireframe palette (temp_images/Mzazi Care Caregiver App Wireframes.dc.html), shared by the
// visit-flow screens. The older screens still carry their own private copies of these values.
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
