"""Agreement scoring on hand-built cases with known precision and recall."""

import numpy as np
import pytest

from mzazi_acoustic.feature_engineering import pause_validation as pv


def test_perfect_agreement():
    pauses = [(1.0, 1.5), (2.0, 2.1)]
    row = pv.agreement(pauses, pauses)
    assert row["precision"] == row["recall"] == 1.0
    assert row["boundary_precision"] == row["boundary_recall"] == 1.0


def test_tolerance_is_applied_to_both_boundaries():
    annotated = [(1.00, 1.50)]
    assert pv.agreement([(1.03, 1.47)], annotated)["n_matched"] == 1  # both within 40 ms
    assert pv.agreement([(1.03, 1.55)], annotated)["n_matched"] == 0  # end is 50 ms off


def test_per_band_precision_and_recall():
    annotated = [(1.0, 1.5), (3.0, 3.1), (5.0, 5.12)]  # long, short, short
    detected = [(1.01, 1.49), (3.0, 3.1), (7.0, 7.09)]  # long hit, short hit, short false alarm
    row = pv.agreement(detected, annotated)
    assert row["long_precision"] == 1.0 and row["long_recall"] == 1.0
    assert row["short_precision"] == pytest.approx(1 / 2)  # one of two detected shorts is real
    assert row["short_recall"] == pytest.approx(1 / 2)  # one of two annotated shorts was found
    assert row["precision"] == pytest.approx(2 / 3) and row["recall"] == pytest.approx(2 / 3)


def test_matching_is_one_to_one():
    # Two detections near one annotation: only one may match.
    row = pv.agreement([(1.0, 1.5), (1.01, 1.51)], [(1.0, 1.5)])
    assert row["n_matched"] == 1 and row["precision"] == 0.5


def test_no_detections_gives_nan_precision_not_a_crash():
    row = pv.agreement([], [(1.0, 1.5)])
    assert np.isnan(row["precision"]) and row["recall"] == 0.0


def test_read_audacity_labels_skips_point_and_spectral_lines(tmp_path):
    labels = tmp_path / "labels.txt"
    labels.write_text("1.000\t1.500\tp\n\\\t100.0\t2000.0\n2.0\t2.0\tpoint\n0.2\t0.3\tp\n")
    assert pv.read_audacity_labels(labels) == [(0.2, 0.3), (1.0, 1.5)]


def test_score_recording_covers_clean_and_every_condition():
    sr = 16_000
    t = np.arange(4 * sr) / sr
    y = 0.3 * np.sin(2 * np.pi * 150 * t)
    y[int(1.5 * sr):int(2.0 * sr)] = 0  # one 500 ms pause
    rows = pv.score_recording(y, sr, [(1.5, 2.0)], 0.5, 3.5, np.random.default_rng(0))
    assert [r["condition"] for r in rows][:2] == ["clean", "bandpass"] and len(rows) == 6
    assert rows[0]["recall"] == 1.0 and rows[0]["precision"] == 1.0
