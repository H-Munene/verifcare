import 'package:flutter/material.dart';

import '../../app_ui.dart';
import '../../widgets/visit_widgets.dart';

/// The signed-in family member and the things that aren't about one dependant: family requests,
/// joining a family, registering another dependant, signing out (2026-10-12 redesign; these used
/// to be scattered across the home screen's bell, floating button and app bar).
class AccountTab extends StatelessWidget {
  final String? fullName;
  final String? email;

  /// Family link requests needing the caller's attention.
  final int attention;
  final VoidCallback onOpenRequests;
  final VoidCallback onJoinFamily;
  final VoidCallback onRegisterDependant;
  final VoidCallback onSignOut;

  const AccountTab({
    super.key,
    required this.fullName,
    required this.email,
    required this.attention,
    required this.onOpenRequests,
    required this.onJoinFamily,
    required this.onRegisterDependant,
    required this.onSignOut,
  });

  @override
  Widget build(BuildContext context) {
    final name = fullName;
    return constrainedContent(
      ListView(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 24),
        children: [
          SectionCard(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Container(
                  width: 48,
                  height: 48,
                  alignment: Alignment.center,
                  color: primaryTint,
                  child: name == null
                      ? const Icon(Icons.person_outline, color: primaryGreen)
                      : Text(
                          name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase(),
                          style: const TextStyle(
                            fontSize: 20,
                            fontWeight: FontWeight.w700,
                            color: primaryGreen,
                          ),
                        ),
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        name ?? 'Your account',
                        style: const TextStyle(
                          fontSize: 16,
                          fontWeight: FontWeight.w600,
                          color: inkDefault,
                        ),
                      ),
                      if (email case final email?)
                        Text(email, style: const TextStyle(fontSize: 13, color: inkSecondary)),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          const SectionTitle('Family'),
          SectionCard(
            child: Column(
              children: [
                _Row(
                  icon: Icons.mail_outline,
                  label: 'Family requests',
                  trailing: attention > 0
                      ? Badge(label: Text('$attention'), backgroundColor: dangerRed)
                      : null,
                  onTap: onOpenRequests,
                ),
                const Divider(height: 1, color: borderColor),
                _Row(
                  icon: Icons.link,
                  label: 'Ask to join a family',
                  onTap: onJoinFamily,
                ),
                const Divider(height: 1, color: borderColor),
                _Row(
                  icon: Icons.person_add_alt_1_outlined,
                  label: 'Register a dependant',
                  onTap: onRegisterDependant,
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          SectionCard(
            child: _Row(
              icon: Icons.logout,
              label: 'Sign out',
              color: dangerRed,
              onTap: onSignOut,
            ),
          ),
        ],
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final IconData icon;
  final String label;
  final Widget? trailing;
  final Color color;
  final VoidCallback onTap;

  const _Row({
    required this.icon,
    required this.label,
    this.trailing,
    this.color = inkDefault,
    required this.onTap,
  });

  @override
  // Its own transparent Material, so the tap ripple isn't hidden behind the card's background.
  Widget build(BuildContext context) => Material(
    type: MaterialType.transparency,
    child: ListTile(
      minTileHeight: 56,
      leading: Icon(icon, color: color == inkDefault ? inkSecondary : color),
      title: Text(label, style: TextStyle(fontSize: 15, color: color)),
      trailing: trailing ?? const Icon(Icons.chevron_right, color: inkTertiary),
      onTap: onTap,
    ),
  );
}
