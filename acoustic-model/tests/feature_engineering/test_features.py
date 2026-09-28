"""openSMILE subset, the single-recording feature function, and the gated Stage 3 scripts."""

import runpy
from pathlib import Path

import numpy as np
import pytest

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering.egemaps import egemaps_features
from mzazi_acoustic.feature_engineering.features import extract_features

SR = 16_000
SCRIPTS = Path(__file__).resolve().parents[2] / "scripts"


def syllables(seconds, rate=4.0, amplitude=0.3):
    """Harmonic 150 Hz tone amplitude-modulated at `rate` peaks per second: a crude syllable train."""
    t = np.arange(int(seconds * SR)) / SR
    carrier = sum(np.sin(2 * np.pi * 150 * k * t) / k for k in (1, 2, 3))
    return (amplitude * carrier * 0.5 * (1 - np.cos(2 * np.pi * rate * t))).astype(np.float32)


def silence(seconds):
    return np.zeros(int(seconds * SR), dtype=np.float32)


def test_opensmile_loudness_peaks_are_per_second_of_total_input():
    # Pins openSMILE 2.6's behaviour: the same 16 peaks read 4/s over 4 s but 2/s once 4 s of
    # silence is appended. If an upgrade changes this, articulation_rate_proxy must be revisited.
    alone = egemaps_features(syllables(4), SR)["loudness_peaks_per_s"]
    padded = egemaps_features(np.concatenate([syllables(4), silence(4)]), SR)["loudness_peaks_per_s"]
    assert alone == pytest.approx(4.0, rel=0.05)
    assert padded == pytest.approx(2.0, rel=0.05)


def speech_like():
    return np.concatenate([silence(0.3), syllables(3), silence(0.6), syllables(3), silence(0.25),
                           syllables(3), silence(0.3)])


def test_extract_features_returns_every_model_feature_finite():
    features = extract_features(speech_like(), SR)
    for name in config.MODEL_FEATURES:
        assert name in features, name
        assert np.isfinite(features[name]), name
    assert list(features)[:len(config.MODEL_FEATURES)] == config.MODEL_FEATURES
    assert {"short_pause_rate_per_min", "n_pauses", "noise_guard_active"} <= set(features)


def test_articulation_rate_counts_peaks_per_second_of_speech_and_ignores_gain():
    y = speech_like()
    loud, quiet = extract_features(y, SR), extract_features(y * 0.1, SR)
    assert quiet["articulation_rate_proxy"] == pytest.approx(loud["articulation_rate_proxy"], rel=1e-3)
    # 4 peaks per second of sound: pauses must not dilute it the way loudnessPeaksPerSec does.
    assert loud["articulation_rate_proxy"] == pytest.approx(4.0, rel=0.1)


@pytest.mark.parametrize("script", ["03a_annotation_sample.py", "03c_validate_detector.py", "03_features.py"])
def test_gated_scripts_exit_while_their_gate_is_closed(script, monkeypatch, tmp_path):
    monkeypatch.setattr(config, "D1_DECISION", None)
    monkeypatch.setattr(config, "DETECTOR_SIGNED_OFF", False)
    monkeypatch.setattr(config, "FEATURE_RESULTS", tmp_path / "features")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    with pytest.raises(SystemExit, match="Not yet"):
        runpy.run_path(str(SCRIPTS / script), run_name="__main__")
