import 'package:flutter_test/flutter_test.dart';

import 'package:family_member/utils/kenyan_phone.dart';

void main() {
  group('normalizeKenyanPhoneNumber', () {
    test('accepts local 0-prefixed format', () {
      expect(normalizeKenyanPhoneNumber('0741405735'), '+254741405735');
    });

    test('accepts country code without +', () {
      expect(normalizeKenyanPhoneNumber('254741405735'), '+254741405735');
    });

    test('accepts already-correct E.164 format', () {
      expect(normalizeKenyanPhoneNumber('+254741405735'), '+254741405735');
    });

    test('accepts bare 9-digit national number', () {
      expect(normalizeKenyanPhoneNumber('741405735'), '+254741405735');
    });

    test('strips spaces and dashes before normalizing', () {
      expect(normalizeKenyanPhoneNumber('0741 405 735'), '+254741405735');
      expect(normalizeKenyanPhoneNumber('0741-405-735'), '+254741405735');
    });

    test('accepts numbers starting with 1 (newer Safaricom range)', () {
      expect(normalizeKenyanPhoneNumber('0112345678'), '+254112345678');
    });

    test('rejects a number that is too short', () {
      expect(normalizeKenyanPhoneNumber('07414057'), isNull);
    });

    test('rejects a number that is too long', () {
      expect(normalizeKenyanPhoneNumber('07414057355'), isNull);
    });

    test('rejects a landline-looking prefix', () {
      expect(normalizeKenyanPhoneNumber('0204412345'), isNull);
    });

    test('rejects a non-Kenyan country code', () {
      expect(normalizeKenyanPhoneNumber('+15551234567'), isNull);
    });

    test('rejects empty input', () {
      expect(normalizeKenyanPhoneNumber(''), isNull);
    });
  });
}
