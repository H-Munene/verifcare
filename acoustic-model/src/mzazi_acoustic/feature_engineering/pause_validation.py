"""Scoring the pause detector against hand-marked pauses (PLAN.md 3.2).

Matching rule: a detected pause matches an annotated one when both its start and its end are
within BOUNDARY_TOLERANCE_SECONDS. Matching is one-to-one, closest pairs first.

Reported per recording and condition:
- pause-level precision/recall, overall and per band. For precision a detected pause is banded by
  its detected length; for recall an annotated pause is banded by its annotated length.
- boundary-level precision/recall: every start and end treated as a separate point.

Only pauses lying fully inside the annotated segment are scored, on both sides, because the
detector runs on the whole recording but the annotator only marked the segment.
"""

import numpy as np

from mzazi_acoustic.common import config, degradation
from mzazi_acoustic.feature_engineering import pause_detector

BANDS = ("short", "long")


def read_audacity_labels(path):
    """Label track exported from Audacity: 'start<TAB>end<TAB>text' per line.

    Lines starting with a backslash (spectral-selection details) and point labels (start == end)
    are skipped.
    """
    pauses = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip() or line.startswith("\\"):
            continue
        start, end = (float(v) for v in line.split("\t")[:2])
        if end > start:
            pauses.append((start, end))
    return sorted(pauses)


def band_of(duration):
    return "long" if duration > config.LONG_PAUSE_SECONDS else "short"


def inside(pauses, segment_start, segment_end):
    return [(s, e) for s, e in pauses if s >= segment_start and e <= segment_end]


def _greedy_match(pairs_with_cost):
    """One-to-one matching, cheapest pairs first. Input: (cost, i, j). Returns set of (i, j)."""
    used_i, used_j, matches = set(), set(), set()
    for _, i, j in sorted(pairs_with_cost):
        if i not in used_i and j not in used_j:
            used_i.add(i)
            used_j.add(j)
            matches.add((i, j))
    return matches


def match_pauses(detected, annotated, tolerance=config.BOUNDARY_TOLERANCE_SECONDS):
    candidates = []
    for i, (ds, de) in enumerate(detected):
        for j, (a_s, a_e) in enumerate(annotated):
            if abs(ds - a_s) <= tolerance and abs(de - a_e) <= tolerance:
                candidates.append((abs(ds - a_s) + abs(de - a_e), i, j))
    return _greedy_match(candidates)


def _ratio(numerator, denominator):
    return numerator / denominator if denominator else np.nan


def agreement(detected, annotated, tolerance=config.BOUNDARY_TOLERANCE_SECONDS):
    """Counts and precision/recall for one recording. Counts are kept so results can be pooled."""
    matches = match_pauses(detected, annotated, tolerance)
    matched_detected = {i for i, _ in matches}
    matched_annotated = {j for _, j in matches}
    row = {"n_detected": len(detected), "n_annotated": len(annotated), "n_matched": len(matches)}
    row["precision"] = _ratio(len(matches), len(detected))
    row["recall"] = _ratio(len(matches), len(annotated))

    for band in BANDS:
        det_in_band = [i for i, (s, e) in enumerate(detected) if band_of(e - s) == band]
        ann_in_band = [j for j, (s, e) in enumerate(annotated) if band_of(e - s) == band]
        det_hits = sum(i in matched_detected for i in det_in_band)
        ann_hits = sum(j in matched_annotated for j in ann_in_band)
        row.update({
            f"{band}_n_detected": len(det_in_band), f"{band}_detected_matched": det_hits,
            f"{band}_n_annotated": len(ann_in_band), f"{band}_annotated_matched": ann_hits,
            f"{band}_precision": _ratio(det_hits, len(det_in_band)),
            f"{band}_recall": _ratio(ann_hits, len(ann_in_band)),
        })

    det_points = [t for pause in detected for t in pause]
    ann_points = [t for pause in annotated for t in pause]
    point_matches = _greedy_match([(abs(d - a), i, j) for i, d in enumerate(det_points)
                                   for j, a in enumerate(ann_points) if abs(d - a) <= tolerance])
    row["boundary_precision"] = _ratio(len(point_matches), len(det_points))
    row["boundary_recall"] = _ratio(len(point_matches), len(ann_points))
    return row


def score_recording(y, sr, annotated, segment_start, segment_end, rng):
    """Agreement on clean audio and under every degradation condition, one row per condition.

    Annotated pauses shorter than the detector's minimum are dropped (the detector can't report
    them by design), and how many were dropped is recorded.
    """
    annotated = inside(annotated, segment_start, segment_end)
    kept = [(s, e) for s, e in annotated if e - s >= config.MIN_PAUSE_SECONDS]
    rows = []
    audio_by_condition = [("clean", y, None)]
    for name, noise_type, snr in degradation.conditions():
        degraded, measured_snr = degradation.degrade(y, sr, noise_type, snr, rng)
        audio_by_condition.append((name, degraded, measured_snr))
    for name, audio, measured_snr in audio_by_condition:
        detected = inside(pause_detector.detect_pauses(audio, sr).pauses, segment_start, segment_end)
        row = {"condition": name, "measured_snr_db": measured_snr,
               "n_annotated_below_minimum": len(annotated) - len(kept)}
        row.update(agreement(detected, kept))
        rows.append(row)
    return rows
