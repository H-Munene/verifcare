import 'package:flutter/material.dart';

// The wireframe palette (temp_images/Mzazi Care Caregiver App Wireframes.dc.html), shared by the
// visit-flow screens. The older screens still carry their own private copies of these values.
const primaryGreen = Color(0xFF047857);
const primaryTint = Color(0xFFE7F5EF);
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
  shape: RoundedRectangleBorder(borderRadius: BorderRadius.zero),
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

/// The app's Material theme: the shared emerald primary, and square corners on every component
/// Material 3 rounds by default (2026-10-12, user decision: the mobile apps match the web
/// console's square-cornered look). Count badges are the one exception, as on the web.
ThemeData buildAppTheme() {
  const square = RoundedRectangleBorder();
  final squareButton = ButtonStyle(
    shape: WidgetStateProperty.all(const RoundedRectangleBorder()),
  );
  // Fields are a single underline, no box (user request 2026-10-12): neutral grey that only darkens
  // on focus, never a coloured outline - the same rule as the web console's fields.
  UnderlineInputBorder underline(Color color) =>
      UnderlineInputBorder(borderSide: BorderSide(color: color));
  return ThemeData(
    // primary is pinned to the exact emerald; a bare seed would shift it to a generated tone.
    colorScheme: ColorScheme.fromSeed(
      seedColor: primaryGreen,
      primary: primaryGreen,
    ),
    useMaterial3: true,
    filledButtonTheme: FilledButtonThemeData(style: squareButton),
    elevatedButtonTheme: ElevatedButtonThemeData(style: squareButton),
    outlinedButtonTheme: OutlinedButtonThemeData(style: squareButton),
    textButtonTheme: TextButtonThemeData(style: squareButton),
    iconButtonTheme: IconButtonThemeData(style: squareButton),
    segmentedButtonTheme: SegmentedButtonThemeData(style: squareButton),
    floatingActionButtonTheme: const FloatingActionButtonThemeData(
      shape: square,
    ),
    inputDecorationTheme: InputDecorationTheme(
      border: underline(const Color(0xFFD4D4D4)),
      enabledBorder: underline(const Color(0xFFD4D4D4)),
      focusedBorder: underline(inkTertiary),
      errorBorder: underline(dangerRed),
      focusedErrorBorder: underline(dangerRed),
      floatingLabelStyle: WidgetStateTextStyle.resolveWith(
        (states) => TextStyle(
          color: states.contains(WidgetState.error) ? dangerRed : inkSecondary,
        ),
      ),
    ),
    cardTheme: const CardThemeData(shape: square),
    chipTheme: const ChipThemeData(shape: square),
    dialogTheme: const DialogThemeData(shape: square),
    bottomSheetTheme: const BottomSheetThemeData(shape: square),
    snackBarTheme: const SnackBarThemeData(shape: square),
    popupMenuTheme: const PopupMenuThemeData(shape: square),
    menuTheme: const MenuThemeData(
      style: MenuStyle(shape: WidgetStatePropertyAll(square)),
    ),
    navigationBarTheme: const NavigationBarThemeData(indicatorShape: square),
    tabBarTheme: const TabBarThemeData(indicatorSize: TabBarIndicatorSize.tab),
    progressIndicatorTheme: const ProgressIndicatorThemeData(
      color: primaryGreen,
    ),
  );
}
