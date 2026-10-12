"""Pause detector on synthetic signals with known pauses (PLAN.md 3.3 tests)."""

import numpy as np
import pytest

from mzazi_acoustic.feature_engineering import pause_detector

SR = 16_000
HOP = 0.010  # expected accuracy: within one hop


def voiced(seconds, amplitude=0.3):
    """A stand-in for speech: a 150 Hz tone with two harmonics."""
    t = np.arange(int(seconds * SR)) / SR
    return amplitude * (np.sin(2 * np.pi * 150 * t) + 0.5 * np.sin(2 * np.pi * 300 * t)
                        + 0.25 * np.sin(2 * np.pi * 450 * t)) / 1.75


def silence(seconds):
    return np.zeros(int(seconds * SR))


def build(pieces):
    return np.concatenate(pieces).astype(np.float32)


# Leading/trailing silence, three real pauses (500, 120, 300 ms) and one gap too short to count (50 ms).
SIGNAL = build([silence(0.4), voiced(1.0), silence(0.5), voiced(1.0), silence(0.12), voiced(1.0),
                silence(0.05), voiced(1.0), silence(0.3), voiced(1.0), silence(0.3)])
EXPECTED_PAUSES = [(1.4, 1.9), (2.9, 3.02), (5.07, 5.37)]


def test_finds_exactly_the_known_pauses():
    result = pause_detector.detect_pauses(SIGNAL, SR)
    assert len(result.pauses) == len(EXPECTED_PAUSES)
    for (start, end), (true_start, true_end) in zip(result.pauses, EXPECTED_PAUSES):
        assert start == pytest.approx(true_start, abs=HOP)
        assert end == pytest.approx(true_end, abs=HOP)


def test_edge_silence_is_not_a_pause_and_analysed_span_excludes_it():
    result = pause_detector.detect_pauses(SIGNAL, SR)
    assert result.analysed_seconds == pytest.approx(6.37 - 0.4, abs=2 * HOP)
    # Pauses and speech tile the analysed span exactly.
    covered = sum(e - s for s, e in result.pauses) + sum(e - s for s, e in result.speech_segments)
    assert covered == pytest.approx(result.analysed_seconds, abs=1e-9)


def test_volume_does_not_change_the_pauses():
    loud = pause_detector.detect_pauses(SIGNAL, SR).pauses
    quiet = pause_detector.detect_pauses(SIGNAL * 0.1, SR).pauses
    assert quiet == pytest.approx(loud)


def test_a_click_does_not_split_a_pause():
    click = np.zeros(int(0.5 * SR))
    click[4000:4160] = 0.3  # 10 ms burst in the middle of the 500 ms pause
    signal = build([silence(0.4), voiced(1.0), click, voiced(1.0), silence(0.3)])
    result = pause_detector.detect_pauses(signal, SR)
    assert len(result.pauses) == 1
    assert result.pauses[0][1] - result.pauses[0][0] == pytest.approx(0.5, abs=HOP)


def test_click_at_the_start_does_not_create_a_pause():
    signal = SIGNAL.copy()
    signal[:160] = 0.3  # 10 ms burst at t = 0, before the 0.4 s of leading silence
    assert len(pause_detector.detect_pauses(signal, SR).pauses) == len(EXPECTED_PAUSES)


def test_noise_guard_still_finds_pauses_at_20_db_snr():
    # Without the guard, "25 dB below speech" is under a noise floor only 20 dB down,
    # so no frame would ever count as silent.
    rng = np.random.default_rng(0)
    speech_rms = np.sqrt(np.mean(voiced(1.0) ** 2))
    noise = rng.normal(0, speech_rms / 10, len(SIGNAL))  # 20 dB below the speech
    result = pause_detector.detect_pauses((SIGNAL + noise).astype(np.float32), SR)
    assert len(result.pauses) == len(EXPECTED_PAUSES)


def test_features_from_a_single_waveform():
    features = pause_detector.extract_pause_features(SIGNAL, SR)
    minutes = features["analysed_seconds"] / 60
    assert features["n_pauses"] == 3
    assert features["pause_rate_per_min"] == pytest.approx(3 / minutes)
    assert features["long_pause_rate_per_min"] == pytest.approx(2 / minutes)  # 500 and 300 ms
    assert features["short_pause_rate_per_min"] == pytest.approx(1 / minutes)  # 120 ms
    assert features["median_pause_s"] == pytest.approx(0.3, abs=HOP)
    assert features["long_pause_time_share"] == pytest.approx(0.8 / 0.92, abs=0.02)
    assert 0 < features["phonation_time_ratio"] < 1


def test_no_pauses_gives_structural_zeros_and_nan_only_where_undefined():
    features = pause_detector.extract_pause_features(build([voiced(3.0)]), SR)
    assert features["n_pauses"] == 0
    # Structurally defined: no pauses means none per minute and no long-pause share.
    assert features["pause_rate_per_min"] == 0
    assert features["long_pause_rate_per_min"] == 0
    assert features["long_pause_time_share"] == 0
    # Genuinely undefined: there is no pause to take a length of.
    assert np.isnan(features["median_pause_s"]) and np.isnan(features["mean_pause_s"])
    assert features["phonation_time_ratio"] == pytest.approx(1.0)
