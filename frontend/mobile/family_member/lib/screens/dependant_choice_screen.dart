import 'package:flutter/material.dart';

/// Optional step after registration. Linking to an existing dependant isn't supported yet.
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
