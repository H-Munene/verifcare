/// Normalizes a Kenyan phone number entered in any common local format into Cognito's required
/// E.164 shape (+254XXXXXXXXX), so "0741405735", "254741405735", and "+254741405735" all resolve
/// to the same value. This POC is deliberately Kenya-only - no other country codes are recognized.
/// Returns null if the input doesn't match any recognized Kenyan format.
String? normalizeKenyanPhoneNumber(String input) {
  final cleaned = input.trim().replaceAll(RegExp(r'[\s\-()]'), '');

  String? nationalNumber; // the 9-digit number, without a leading 0 or the 254 country code
  if (RegExp(r'^\+254\d{9}$').hasMatch(cleaned)) {
    nationalNumber = cleaned.substring(4);
  } else if (RegExp(r'^254\d{9}$').hasMatch(cleaned)) {
    nationalNumber = cleaned.substring(3);
  } else if (RegExp(r'^0\d{9}$').hasMatch(cleaned)) {
    nationalNumber = cleaned.substring(1);
  } else if (RegExp(r'^\d{9}$').hasMatch(cleaned)) {
    nationalNumber = cleaned;
  }

  // Kenyan mobile numbers start with 7 or 1 (landline prefixes are deliberately not accepted -
  // this app only ever needs to reach the family member's own mobile).
  if (nationalNumber == null || !RegExp(r'^[17]\d{8}$').hasMatch(nationalNumber)) {
    return null;
  }
  return '+254$nationalNumber';
}
