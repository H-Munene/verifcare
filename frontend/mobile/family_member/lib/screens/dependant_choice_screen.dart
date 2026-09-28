import 'package:flutter/material.dart';

/// Shown once right after registration completes - "optional, skippable, do-it-later" per the
/// settled design (docs/project-state.md). Linking to an *existing* dependant someone else
/// registered is deliberately not offered here: that path has zero backend support (no request/
/// accept/reject table or discovery endpoint) and is out of scope for this pass.
class DependantChoiceScreen extends StatelessWidget {
  final VoidCallback onRegisterNow;
  final VoidCallback onSkip;

  const DependantChoiceScreen({super.key, required this.onRegisterNow, required this.onSkip});

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
              'Would you like to register the dependant you care for now? '
              'You can also do this later.',
            ),
            const SizedBox(height: 24),
            FilledButton(onPressed: onRegisterNow, child: const Text('Register a dependant now')),
            const SizedBox(height: 12),
            OutlinedButton(onPressed: onSkip, child: const Text('Skip for now')),
          ],
        ),
      ),
    );
  }
}
