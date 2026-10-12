import 'package:flutter/material.dart';

import '../app_ui.dart';

/// Whose care the tab shows, at the top of Today and Visits (2026-10-12: moved out of the app
/// bar, which now carries the word logo). Tappable, with an arrow, only when the family member
/// has more than one dependant to switch between.
class DependantSwitcher extends StatelessWidget {
  final String name;
  final VoidCallback? onSwitch;

  const DependantSwitcher({super.key, required this.name, required this.onSwitch});

  @override
  Widget build(BuildContext context) {
    final label = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.person_outline, size: 18, color: primaryGreen),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            name,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 14,
              fontWeight: FontWeight.w600,
              color: primaryGreen,
            ),
          ),
        ),
        if (onSwitch != null) ...[
          const SizedBox(width: 2),
          const Icon(Icons.keyboard_arrow_down, size: 20, color: primaryGreen),
        ],
      ],
    );
    return Align(
      alignment: Alignment.centerLeft,
      child: onSwitch == null
          ? Padding(padding: const EdgeInsets.symmetric(vertical: 6), child: label)
          : Material(
              color: primaryTint,
              child: InkWell(
                onTap: onSwitch,
                child: Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  child: label,
                ),
              ),
            ),
    );
  }
}
