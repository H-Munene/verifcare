import 'package:flutter/material.dart';

import '../app_ui.dart';

// The signed-out screens' shared look (2026-10-12, user request): a white page with the MZAZI
// CARE word logo top left, and no "Caregiver"/"Family member" label, since each app is already
// only for one kind of user. Kept identical in both mobile apps (they share no package).

/// The word logo: the name in spaced emerald capitals.
class Wordmark extends StatelessWidget {
  const Wordmark({super.key});

  @override
  Widget build(BuildContext context) => Semantics(
    // Read as a name, not spelled out letter by letter.
    label: 'Mzazi Care',
    child: ExcludeSemantics(
      child: const Text(
        'MZAZI CARE',
        style: TextStyle(
          fontSize: 15,
          fontWeight: FontWeight.w800,
          letterSpacing: 3,
          color: primaryGreen,
        ),
      ),
    ),
  );
}

/// A signed-out page: the word logo in the app bar (after the back arrow, when there is one),
/// then [child] near the top, in a scrollable column of readable width so it fits above the
/// keyboard and doesn't stretch across a tablet. [bottom], if given, is pinned to the foot of the
/// screen (the Welcome page's buttons).
class AuthScaffold extends StatelessWidget {
  final Widget child;
  final Widget? bottom;

  const AuthScaffold({super.key, required this.child, this.bottom});

  @override
  Widget build(BuildContext context) {
    final canPop = Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: Colors.white,
      appBar: AppBar(
        backgroundColor: Colors.white,
        surfaceTintColor: Colors.transparent,
        scrolledUnderElevation: 0,
        centerTitle: false,
        // Lines the logo up with the page content when there's no back arrow before it.
        titleSpacing: canPop ? 0 : 24,
        title: const Wordmark(),
      ),
      body: SafeArea(
        child: Align(
          alignment: Alignment.topCenter,
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: child,
            ),
          ),
        ),
      ),
      bottomNavigationBar: switch (bottom) {
        final bottom? => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
            child: Align(
              heightFactor: 1,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: bottom,
              ),
            ),
          ),
        ),
        null => null,
      },
    );
  }
}

/// The large heading and one-line explanation at the top of a signed-out page.
class AuthHeading extends StatelessWidget {
  final String title;
  final String subtitle;

  const AuthHeading({super.key, required this.title, required this.subtitle});

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 28),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          title,
          style: const TextStyle(
            fontSize: 28,
            fontWeight: FontWeight.w700,
            height: 1.2,
            color: inkDefault,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          subtitle,
          style: const TextStyle(fontSize: 15, color: inkSecondary),
        ),
      ],
    ),
  );
}

/// The full-width, tall primary button the signed-out pages end with.
final authButtonStyle = FilledButton.styleFrom(
  minimumSize: const Size.fromHeight(52),
  textStyle: const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
);
