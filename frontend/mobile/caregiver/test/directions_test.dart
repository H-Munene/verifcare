import 'package:caregiver/api/directions_api.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test("decodes Google's documented example polyline", () {
    final points = decodePolyline(r'_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(points.map((p) => [p.latitude, p.longitude]).toList(), [
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ]);
  });
}
