import 'package:amazon_cognito_identity_dart_2/cognito.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// The package's own default storage (CognitoMemoryStorage) is in-memory only, so a signed-in
/// session would not survive an app restart - unlike the web app, where amazon-cognito-identity-js
/// persists to the browser's localStorage automatically. This backs the same CognitoStorage
/// interface with shared_preferences instead, so "already signed in" on relaunch actually works.
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
