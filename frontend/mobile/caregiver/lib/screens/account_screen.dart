import 'package:flutter/material.dart';

import '../api/voice_enrollment_api.dart';
import '../app_ui.dart';
import '../auth/cognito_auth_service.dart';
import 'voice_enrolment_screen.dart';

/// The caregiver's account (2026-10-12): who is signed in, and signing out - which used to be an
/// icon in the old Home stub's app bar.
class AccountScreen extends StatelessWidget {
  final CognitoAuthService authService;
  final IdentityClaims identity;
  final VoiceEnrollmentApi voiceEnrollmentApi;
  final VoidCallback onSignedOut;

  const AccountScreen({
    super.key,
    required this.authService,
    required this.identity,
    required this.voiceEnrollmentApi,
    required this.onSignedOut,
  });

  Future<void> _signOut() async {
    await authService.signOut();
    onSignedOut();
  }

  @override
  Widget build(BuildContext context) {
    final name = identity.fullName?.trim();
    final contact = identity.email ?? identity.phoneNumber;
    return Scaffold(
      backgroundColor: const Color(0xFFF7F7F7),
      body: SafeArea(
        child: constrainedContent(
          ListView(
            padding: const EdgeInsets.fromLTRB(16, 24, 16, 24),
            children: [
              const Text(
                'Account',
                style: TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.w700,
                  color: inkDefault,
                ),
              ),
              const SizedBox(height: 20),
              Container(
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: borderColor),
                ),
                child: Row(
                  children: [
                    Container(
                      width: 48,
                      height: 48,
                      alignment: Alignment.center,
                      color: primaryTint,
                      child: name == null || name.isEmpty
                          ? const Icon(
                              Icons.person_outline,
                              color: primaryGreen,
                            )
                          : Text(
                              name[0].toUpperCase(),
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
                            name == null || name.isEmpty ? 'Caregiver' : name,
                            style: const TextStyle(
                              fontSize: 16,
                              fontWeight: FontWeight.w600,
                              color: inkDefault,
                            ),
                          ),
                          if (contact != null)
                            Text(
                              contact,
                              style: const TextStyle(
                                fontSize: 13,
                                color: inkSecondary,
                              ),
                            ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 16),
              Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: borderColor),
                ),
                child: Material(
                  type: MaterialType.transparency,
                  child: ListTile(
                    minTileHeight: 56,
                    leading: const Icon(
                      Icons.record_voice_over_outlined,
                      color: inkSecondary,
                    ),
                    title: const Text(
                      'Your voice',
                      style: TextStyle(fontSize: 15),
                    ),
                    subtitle: const Text(
                      'The voiceprint your visit recordings are checked against',
                      style: TextStyle(fontSize: 12, color: inkTertiary),
                    ),
                    trailing: const Icon(
                      Icons.chevron_right,
                      color: inkTertiary,
                    ),
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute<bool>(
                        builder: (_) =>
                            VoiceEnrolmentScreen(api: voiceEnrollmentApi),
                      ),
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Container(
                decoration: BoxDecoration(
                  color: Colors.white,
                  border: Border.all(color: borderColor),
                ),
                // Its own transparent Material, so the tap ripple isn't hidden by the background.
                child: Material(
                  type: MaterialType.transparency,
                  child: ListTile(
                    minTileHeight: 56,
                    leading: const Icon(Icons.logout, color: dangerRed),
                    title: const Text(
                      'Sign out',
                      style: TextStyle(fontSize: 15, color: dangerRed),
                    ),
                    trailing: const Icon(
                      Icons.chevron_right,
                      color: inkTertiary,
                    ),
                    onTap: _signOut,
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
