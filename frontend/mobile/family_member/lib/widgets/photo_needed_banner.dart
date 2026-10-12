import 'package:flutter/material.dart';

import '../api/dependants_api.dart';
import '../app_ui.dart';

/// Caregivers confirm who they're visiting against this photo, and the backend won't schedule a
/// visit until there is one - so it's called out at the top of Today rather than left to be
/// noticed. (Moved here from the old dependant page in the 2026-10-12 redesign.)
class PhotoNeededBanner extends StatelessWidget {
  final Dependant dependant;

  /// Opens the Photo step. Null for anyone but the primary contact, who alone can add it.
  final VoidCallback? onAddPhoto;

  const PhotoNeededBanner({
    super.key,
    required this.dependant,
    required this.onAddPhoto,
  });

  @override
  Widget build(BuildContext context) {
    final firstName = dependant.fullName.split(' ').first;
    final awaitingReview =
        dependant.checkinPhotoStatus == CheckinPhotoStatus.awaitingReview;
    final (title, body) = switch ((awaitingReview, onAddPhoto)) {
      (true, _) => (
        "$firstName's photo is waiting for review",
        'It looked like someone already enrolled, so a supervisor is checking it. Visits can be '
            'scheduled once it is approved.',
      ),
      (false, _?) => (
        'Add a photo of $firstName',
        "Caregivers confirm who they're visiting against this photo, so visits can't be "
            'scheduled until there is one.',
      ),
      (false, null) => (
        '$firstName has no photo yet',
        "Visits can't be scheduled until the primary contact adds one.",
      ),
    };
    return Container(
      padding: const EdgeInsets.all(14),
      color: dangerTint,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Padding(
            padding: EdgeInsets.only(top: 2),
            child: Icon(Icons.photo_camera_outlined, color: dangerRed, size: 20),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 14,
                    fontWeight: FontWeight.w600,
                    color: inkDefault,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  body,
                  style: const TextStyle(fontSize: 13, color: inkSecondary),
                ),
                if (!awaitingReview && onAddPhoto != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: FilledButton.icon(
                      onPressed: onAddPhoto,
                      style: FilledButton.styleFrom(backgroundColor: dangerRed),
                      icon: const Icon(Icons.photo_camera_outlined, size: 18),
                      label: const Text('Add photo'),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
