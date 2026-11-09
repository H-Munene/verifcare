import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';

import 'api/visit_schedules_api.dart';

/// On-device notifications only (user decision 2026-09-24): the only events worth notifying
/// about here - an ongoing visit and its checkout - both happen on this same phone, so a server
/// push pipeline would add device-token registration and a send path for no benefit.
class VisitNotifications {
  static final _plugin = FlutterLocalNotificationsPlugin();
  static const _ongoingId = 1;
  static const _checkedOutId = 2;
  static const _coverOfferId = 3;

  /// The visit id of a tapped ongoing-visit notification (including the one that cold-launched
  /// the app) - the authenticated shell listens and opens that visit's checklist screen.
  static final tappedVisitId = ValueNotifier<String?>(null);

  static Future<void> init() async {
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('@mipmap/ic_launcher'),
        // Permission is asked for at the first real notification instead of at launch, so the
        // prompt appears with context (right after check-in), not on a cold login screen.
        iOS: DarwinInitializationSettings(
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
      ),
      onDidReceiveNotificationResponse: (response) =>
          tappedVisitId.value = response.payload,
    );
    final launch = await _plugin.getNotificationAppLaunchDetails();
    if (launch?.didNotificationLaunchApp ?? false) {
      tappedVisitId.value = launch!.notificationResponse?.payload;
    }
  }

  static Future<void> _requestPermission() async {
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.requestNotificationsPermission();
    await _plugin
        .resolvePlatformSpecificImplementation<
          IOSFlutterLocalNotificationsPlugin
        >()
        ?.requestPermissions(alert: true);
  }

  /// Pinned (ongoing) on Android until [showCheckedOut] replaces it. iOS has no equivalent of a
  /// non-dismissible notification, so there it is a normal one the caregiver can swipe away.
  static Future<void> showOngoing(VisitSchedule visit) async {
    await _requestPermission();
    await _plugin.show(
      id: _ongoingId,
      title: 'Visit in progress',
      body: 'With ${visit.dependantDisplayName} - tap to open the checklist',
      payload: visit.id,
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'ongoing_visit',
          'Ongoing visit',
          channelDescription: 'Shown while a visit is checked in',
          importance: Importance.low,
          ongoing: true,
          autoCancel: false,
        ),
        iOS: DarwinNotificationDetails(presentSound: false),
      ),
    );
  }

  // For when the visit stopped being in progress without a checkout on this phone (e.g. the
  // missed-visit sweep closed it), so the pinned notification doesn't outlive the visit.
  static Future<void> cancelOngoing() => _plugin.cancel(id: _ongoingId);

  /// A nudge that a cover offer is waiting. No name or address: it can show on a locked screen.
  static Future<void> showCoverOffer(String? ward) async {
    await _requestPermission();
    await _plugin.show(
      id: _coverOfferId,
      title: 'Can you cover a visit nearby?',
      body: ward == null ? 'Open Mzazi Care to answer' : '$ward - open Mzazi Care to answer',
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'cover_offers',
          'Cover offers',
          channelDescription: 'Requests to cover a nearby late visit',
          importance: Importance.high,
          priority: Priority.high,
        ),
        iOS: DarwinNotificationDetails(),
      ),
    );
  }

  static Future<void> showCheckedOut(VisitSchedule visit) async {
    await _plugin.cancel(id: _ongoingId);
    await _plugin.show(
      id: _checkedOutId,
      title: 'Checked out',
      body: 'Visit with ${visit.dependantDisplayName} completed',
      notificationDetails: const NotificationDetails(
        android: AndroidNotificationDetails(
          'visit_updates',
          'Visit updates',
          channelDescription: 'Check-out confirmations',
        ),
        iOS: DarwinNotificationDetails(),
      ),
    );
  }
}
