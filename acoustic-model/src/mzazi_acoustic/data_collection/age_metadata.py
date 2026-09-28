"""Age at recording, from DementiaNet's metadata sheet and the clip-name suffix (decision D6).

DementiaNet records no recording dates. It does record birth year, death year (or "present") and,
for dementia, the year symptoms began, and it sorts each person's clip URLs into time buckets.
The number at the end of a clip name tells which bucket the clip came from:

- dementia `_0/_5/_10/_15`: after symptom onset, 0-5, 5-10 and 10-15 years before onset.
- no dementia `_1/_2/_3`: younger than 55, 55-70, older than 70.

The no-dementia order was established from the data on 2026-09-28, not from the README (which
doesn't say, and describes the buckets two inconsistent ways). For the 61 controls in the
metadata sheet, the URL columns each person has were compared with the suffixes on disk under all
six orderings: `1 = <55, 2 = 55-70, 3 = >70` matched 55 of 61 exactly and 60 of 61 as a subset.
The sheet's own column order (>70 first) matched only 41. So an age is a range, never a point.
"""

import itertools
import re

import numpy as np
import pandas as pd

from mzazi_acoustic.data_collection.subjects import normalise_name

DEMENTIA_BUCKETS = {"0": "after onset", "5": "0-5 y before onset", "10": "5-10 y before onset",
                    "15": "10-15 y before onset"}
CONTROL_BUCKETS = {"1": (None, 55), "2": (55, 70), "3": (70, None)}  # age range in years
AGE_BANDS = [("<55", 0, 55), ("55-70", 55, 70), (">70", 70, 200)]


def bucket_of(filename):
    """'aileenhernandez_5_2.wav' -> '5'; 'DavidSoul_3.wav' -> '3'; no number -> None."""
    match = re.search(r"(\d+)(?:_\d+)?\.wav$", filename, flags=re.IGNORECASE)
    return match.group(1) if match else None


def _year(value):
    number = pd.to_numeric(value, errors="coerce")
    return None if pd.isna(number) else int(number)


def dementia_age_range(bucket, birth, onset, death, last_year):
    """(youngest, oldest) possible age for a dementia clip, or (nan, nan) if it can't be bounded."""
    if bucket not in DEMENTIA_BUCKETS or birth is None or onset is None:
        return np.nan, np.nan
    if bucket == "0":
        first, last = onset, death if death is not None else last_year
    else:
        years_before = int(bucket)
        first, last = onset - years_before, onset - years_before + 5
    return first - birth, last - birth


def control_age_range(bucket, birth, death, last_year):
    """(youngest, oldest) possible age for a control clip. The band holds even without metadata."""
    if bucket not in CONTROL_BUCKETS:
        return np.nan, np.nan
    low, high = CONTROL_BUCKETS[bucket]
    if high is None and birth is not None:  # >70: at most their age at death, or at the last year
        high = (death if death is not None else last_year) - birth
    return (np.nan if low is None else low), (np.nan if high is None else high)


def age_band(low, high):
    """The one band a range falls inside, 'straddles' if it crosses a boundary.

    A NaN bound is open ('<55' has no lower bound; '>70' without a birth year has no upper bound),
    so it only fits the outermost band on that side. Both bounds NaN means 'unknown'.
    """
    if np.isnan(low) and np.isnan(high):
        return "unknown"
    for name, band_low, band_high in AGE_BANDS:
        low_ok = band_low == AGE_BANDS[0][1] if np.isnan(low) else low >= band_low
        high_ok = band_high == AGE_BANDS[-1][2] if np.isnan(high) else high <= band_high
        if low_ok and high_ok:
            return name
    return "straddles"


def control_suffix_order_evidence(files, control_sheet):
    """How well each possible suffix -> age-band ordering fits the metadata.

    For each control in the sheet, the set of age-band columns holding a URL should equal (or at
    least contain) the set of bands their clips on disk map to. Returns one row per ordering.
    `files` needs label, filename, person_folder.
    """
    columns = {"<55": "age less than 55", "55-70": "age above 55 less than 70", ">70": "age above 70"}
    has_url = {}
    for _, row in control_sheet.iterrows():
        has_url[normalise_name(row["name"])] = {band for band, column in columns.items()
                                                if isinstance(row[column], str) and row[column].strip()}
    controls = files[files["label"] == 0]
    on_disk = controls.groupby(controls["person_folder"].map(normalise_name))["filename"].agg(
        lambda names: {bucket_of(n) for n in names})

    rows = []
    for order in itertools.permutations(columns):
        mapping = dict(zip(["1", "2", "3"], order))
        exact = subset = checked = 0
        for person, suffixes in on_disk.items():
            if person not in has_url:
                continue
            checked += 1
            bands = {mapping.get(s) for s in suffixes}
            exact += bands == has_url[person]
            subset += bands <= has_url[person]
        rows.append({"suffix_1": order[0], "suffix_2": order[1], "suffix_3": order[2],
                     "people_checked": checked, "exact_match": exact, "subset_match": subset})
    return pd.DataFrame(rows).sort_values("exact_match", ascending=False)


def ages_for_files(files, dementia_sheet, control_sheet):
    """One row per file: bucket, age range and band. `files` needs file_id, label, filename, person_folder."""
    dementia_sheet = dementia_sheet.assign(key=dementia_sheet["name"].map(normalise_name)).set_index("key")
    control_sheet = control_sheet.assign(key=control_sheet["name"].map(normalise_name)).set_index("key")
    last_year = max(pd.to_numeric(dementia_sheet["death"], errors="coerce").max(),
                    pd.to_numeric(control_sheet["deathdate"], errors="coerce").max())

    rows = []
    for row in files.itertuples():
        key = normalise_name(row.person_folder)
        bucket = bucket_of(row.filename)
        if row.label == 1:
            meta = dementia_sheet.loc[key] if key in dementia_sheet.index else None
            birth = _year(meta["birth"]) if meta is not None else None
            low, high = dementia_age_range(bucket, birth,
                                           _year(meta["first symptoms"]) if meta is not None else None,
                                           _year(meta["death"]) if meta is not None else None, int(last_year))
        else:
            meta = control_sheet.loc[key] if key in control_sheet.index else None
            birth = _year(meta["birthdate"]) if meta is not None else None
            low, high = control_age_range(bucket, birth,
                                          _year(meta["deathdate"]) if meta is not None else None, int(last_year))
        rows.append({"file_id": row.file_id, "label": row.label, "bucket": bucket,
                     "in_metadata": meta is not None, "age_low": low, "age_high": high,
                     "age_band": age_band(low, high)})
    return pd.DataFrame(rows), int(last_year)
