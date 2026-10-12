import 'package:flutter/material.dart';

import '../app_ui.dart';

// Loading, empty and error states shared by every tab (2026-10-12, family app redesign), so a
// screen never shows a bare spinner or a blank list.

const _skeletonColor = Color(0xFFEDEDED);

/// A grey placeholder bar standing in for text or a card that is still loading.
class SkeletonBlock extends StatelessWidget {
  final double height;
  final double? width;

  const SkeletonBlock({super.key, this.height = 14, this.width});

  @override
  Widget build(BuildContext context) =>
      Container(height: height, width: width, color: _skeletonColor);
}

/// Placeholder cards shaped like the content they stand in for. Static on purpose: a pulsing
/// animation never settles, which would also stall widget tests waiting for the screen to settle.
/// ponytail: no shimmer; add one (gated on MediaQuery.disableAnimations) if loading ever feels
/// frozen on slow networks.
class SkeletonCards extends StatelessWidget {
  final int count;
  final double cardHeight;

  const SkeletonCards({super.key, this.count = 3, this.cardHeight = 72});

  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Loading',
    child: Column(
      children: [
        for (var i = 0; i < count; i++)
          Container(
            // A minimum, not a fixed height, so the placeholder lines never overflow it.
            constraints: BoxConstraints(minHeight: cardHeight),
            alignment: Alignment.centerLeft,
            margin: const EdgeInsets.only(bottom: 10),
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Colors.white,
              border: Border.all(color: borderColor),
            ),
            child: const Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SkeletonBlock(width: 160),
                SizedBox(height: 8),
                SkeletonBlock(height: 10, width: 100),
              ],
            ),
          ),
      ],
    ),
  );
}

/// A friendly explanation for an empty section, with an optional way forward.
class EmptyState extends StatelessWidget {
  final IconData icon;
  final String title;
  final String message;
  final Widget? action;

  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
    this.action,
  });

  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    padding: const EdgeInsets.fromLTRB(20, 24, 20, 20),
    decoration: BoxDecoration(
      color: Colors.white,
      border: Border.all(color: borderColor),
    ),
    child: Column(
      children: [
        Container(
          width: 48,
          height: 48,
          color: primaryTint,
          child: Icon(icon, color: primaryGreen),
        ),
        const SizedBox(height: 12),
        Text(
          title,
          textAlign: TextAlign.center,
          style: const TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            color: inkDefault,
          ),
        ),
        const SizedBox(height: 4),
        Text(
          message,
          textAlign: TextAlign.center,
          style: const TextStyle(fontSize: 13, color: inkSecondary),
        ),
        if (action case final action?) ...[
          const SizedBox(height: 12),
          action,
        ],
      ],
    ),
  );
}

/// A load that failed: the reason, and a retry.
class ErrorState extends StatelessWidget {
  final String message;
  final VoidCallback onRetry;

  const ErrorState({super.key, required this.message, required this.onRetry});

  @override
  Widget build(BuildContext context) => EmptyState(
    icon: Icons.cloud_off_outlined,
    title: "Couldn't load this",
    message: message,
    action: OutlinedButton(onPressed: onRetry, child: const Text('Retry')),
  );
}
