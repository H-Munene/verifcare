import 'package:geolocator/geolocator.dart';

/// Asks for location permission if needed and returns why the device's location can't be used
/// to [action] (e.g. 'check in'), or null when it can. Shared by check-in and checkout, which both
/// have to prove the caregiver is at the dependant's home, so both ask the same way and explain a
/// refusal in the same words.
Future<String?> locationUnavailableReason(String action) async {
  var permission = await Geolocator.checkPermission();
  if (permission == LocationPermission.denied) {
    permission = await Geolocator.requestPermission();
  }
  if (permission == LocationPermission.deniedForever) {
    return 'Location permission permanently denied. Enable it in device settings to $action.';
  }
  if (permission == LocationPermission.denied) {
    return 'Location permission is required to $action.';
  }
  if (!await Geolocator.isLocationServiceEnabled()) {
    return 'Turn on device location services to $action.';
  }
  return null;
}
