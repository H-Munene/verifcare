import 'dart:convert';

import 'package:google_maps_flutter/google_maps_flutter.dart';
import 'package:http/http.dart' as http;

import '../config.dart';

/// A route from the caregiver to the dependant's home: the path to draw, and a short summary.
class DirectionsRoute {
  final List<LatLng> points;
  final String summary; // e.g. "3.4 km · 12 mins"
  DirectionsRoute(this.points, this.summary);
}

/// Calls Google's Directions web service straight from the app (user decision, 2026-09-26), with
/// the build-time key in AppConfig.directionsApiKey. Returns null when there's no key or no route,
/// so the check-in map simply shows no path rather than an error.
class DirectionsApi {
  static bool get enabled => AppConfig.directionsApiKey.isNotEmpty;

  Future<DirectionsRoute?> route(LatLng from, LatLng to) async {
    if (!enabled) return null;
    final uri = Uri.https('maps.googleapis.com', '/maps/api/directions/json', {
      'origin': '${from.latitude},${from.longitude}',
      'destination': '${to.latitude},${to.longitude}',
      'mode': 'driving',
      'key': AppConfig.directionsApiKey,
    });
    final response = await http.get(uri);
    if (response.statusCode != 200) return null;
    final json = jsonDecode(response.body);
    return switch (json) {
      {
        'status': 'OK',
        'routes': [
          {
            'overview_polyline': {'points': String encoded},
            'legs': [
              {
                'distance': {'text': String distance},
                'duration': {'text': String duration},
              },
              ...,
            ],
          },
          ...,
        ],
      } =>
        DirectionsRoute(decodePolyline(encoded), '$distance · $duration'),
      _ => null,
    };
  }
}

/// Google's encoded polyline format, decoded to points
/// (developers.google.com/maps/documentation/utilities/polylinealgorithm).
List<LatLng> decodePolyline(String encoded) {
  final points = <LatLng>[];
  var index = 0, lat = 0, lng = 0;
  int next() {
    var result = 0, shift = 0, byte = 0;
    do {
      byte = encoded.codeUnitAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    return (result & 1) != 0 ? ~(result >> 1) : result >> 1;
  }

  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.add(LatLng(lat / 1e5, lng / 1e5));
  }
  return points;
}
