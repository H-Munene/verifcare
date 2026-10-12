/// Normalizes a Kenyan number ("0741405735", "254741405735", "+254741405735") to E.164
/// (+254XXXXXXXXX). Returns null for anything else.
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

  // Mobile numbers only: they start with 7 or 1.
  if (nationalNumber == null || !RegExp(r'^[17]\d{8}$').hasMatch(nationalNumber)) {
    return null;
  }
  return '+254$nationalNumber';
}
