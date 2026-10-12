import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Persists the Cognito session across restarts; the default storage is in-memory only.
class SharedPreferencesCognitoStorage extends CognitoStorage {
  Future<SharedPreferences> get _prefs => SharedPreferences.getInstance();

  @override
  Future<dynamic> setItem(String key, value) async {
    final prefs = await _prefs;
    await prefs.setString(key, value as String);
    return value;
  }

  @override
  Future<dynamic> getItem(String key) async {
    final prefs = await _prefs;
    return prefs.getString(key);
  }

  @override
  Future<dynamic> removeItem(String key) async {
    final prefs = await _prefs;
    await prefs.remove(key);
    return null;
  }

  @override
  Future<void> clear() async {
    final prefs = await _prefs;
    await prefs.clear();
  }
}
