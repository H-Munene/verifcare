import 'dart:convert';

import 'package:flutter/services.dart';

/// One county, constituency or ward: the code links a level to its children, and the name is
/// what the API stores (dependants.county/constituency/ward hold plain names, not codes).
typedef Area = ({String code, String name});

/// Kenya's county -> constituency -> ward lists, bundled from the same IEBC extracts the admin
/// web app uses (assets/geo/), plus each county's centre for pointing the registration map.
class KenyaAreas {
  final List<Area> counties;
  final Map<String, List<Area>> _constituenciesByCounty;
  final Map<String, List<Area>> _wardsByConstituency;
  final Map<String, ({double lat, double lng})> _countyCentres;

  KenyaAreas._(
    this.counties,
    this._constituenciesByCounty,
    this._wardsByConstituency,
    this._countyCentres,
  );

  List<Area> constituenciesOf(Area county) =>
      _constituenciesByCounty[county.code] ?? const [];

  List<Area> wardsOf(Area constituency) =>
      _wardsByConstituency[constituency.code] ?? const [];

  ({double lat, double lng})? centreOf(Area county) =>
      _countyCentres[county.name];

  static Future<KenyaAreas>? _loading;

  /// Parsed once per app run; later calls reuse the same result.
  static Future<KenyaAreas> load() => _loading ??= _load();

  static Future<KenyaAreas> _load() async {
    Future<List<Map<String, dynamic>>> rows(String name) async =>
        (jsonDecode(await rootBundle.loadString('assets/geo/$name')) as List)
            .cast<Map<String, dynamic>>();

    final counties = [
      for (final row in await rows('counties.json'))
        (code: '${row['county_code']}', name: row['county_name'] as String),
    ]..sort(_byName);

    final constituencies = <String, List<Area>>{};
    for (final row in await rows('constituencies.json')) {
      constituencies.putIfAbsent('${row['county_code']}', () => []).add((
        code: '${row['constituency_code']}',
        name: row['constituency_name'] as String,
      ));
    }

    final wards = <String, List<Area>>{};
    for (final row in await rows('wards.json')) {
      wards.putIfAbsent('${row['constituency_code']}', () => []).add((
        code: '${row['ward_code']}',
        name: row['ward_name'] as String,
      ));
    }

    final rawCentres =
        jsonDecode(
              await rootBundle.loadString('assets/geo/county_centres.json'),
            )
            as Map<String, dynamic>;
    final centres = {
      for (final MapEntry(:key, :value) in rawCentres.entries)
        key: switch (value) {
          [num lat, num lng] => (lat: lat.toDouble(), lng: lng.toDouble()),
          _ => throw FormatException('Bad county centre for $key: $value'),
        },
    };

    for (final list in [...constituencies.values, ...wards.values]) {
      list.sort(_byName);
    }
    return KenyaAreas._(counties, constituencies, wards, centres);
  }

  static int _byName(Area a, Area b) => a.name.compareTo(b.name);
}
