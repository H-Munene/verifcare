import 'package:flutter/material.dart';

/// Shown once right after registration completes - "optional, skippable, do-it-later" per the
/// settled design (docs/project-state.md). Since 2026-09-26 it also offers joining a family whose
/// dependant someone else already registered, by asking that dependant's primary contact to link
/// them (family link requests).
class DependantChoiceScreen extends StatelessWidget {
  final VoidCallback onRegisterNow;
  final VoidCallback onJoinFamily;
  final VoidCallback onSkip;

  const DependantChoiceScreen({
    super.key,
    required this.onRegisterNow,
    required this.onJoinFamily,
    required this.onSkip,
  });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('One more thing')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text(
              'Would you like to register the dependant you care for now? If someone in your '
              'family already registered them, ask them to link you instead. You can also do '
              'either later.',
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: onRegisterNow,
              child: const Text('Register a dependant now'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: onJoinFamily,
              child: const Text('Ask to join a family'),
            ),
            const SizedBox(height: 12),
            OutlinedButton(
              onPressed: onSkip,
              child: const Text('Skip for now'),
            ),
          ],
        ),
      ),
    );
  }
}
