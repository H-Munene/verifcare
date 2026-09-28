import numpy as np
import pytest

from mzazi_acoustic.data_processing import standardise
from mzazi_acoustic.feature_engineering import pause_detector

SR = 16_000


def tone(seconds):
    t = np.arange(int(seconds * SR)) / SR
    return 0.3 * np.sin(2 * np.pi * 150 * t)


def test_trimming_removes_edges_but_keeps_the_internal_gap():
    y = np.concatenate([np.zeros(SR), tone(2), np.zeros(SR // 2), tone(2), np.zeros(SR)]).astype(np.float32)
    trimmed, trimmed_seconds = standardise.trim_and_truncate(y, SR)
    assert trimmed_seconds == pytest.approx(4.5, abs=0.02)
    pauses = pause_detector.detect_pauses(trimmed, SR).pauses
    assert len(pauses) == 1
    assert pauses[0][1] - pauses[0][0] == pytest.approx(0.5, abs=0.01)


def test_truncation_keeps_the_first_90_seconds_but_reports_the_full_trimmed_length():
    y = tone(100).astype(np.float32)
    kept, trimmed_seconds = standardise.trim_and_truncate(y, SR)
    assert trimmed_seconds == pytest.approx(100, abs=0.02)
    assert len(kept) / SR == pytest.approx(90)


def test_resampling_to_16k():
    y44 = np.sin(2 * np.pi * 200 * np.arange(44_100) / 44_100)
    assert len(standardise.to_16k_mono(y44, 44_100)) == SR
