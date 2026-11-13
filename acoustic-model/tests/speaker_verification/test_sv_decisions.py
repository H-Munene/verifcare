"""The clip check, the visit decision, calibration and metrics."""

import numpy as np
import pytest

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, verify

SR = config.SV_SAMPLE_RATE
ENOUGH = config.SV_MIN_CLIP_SPEECH_SECONDS


class HalfSpeech:
    """A stand-in VAD that hears speech in the first half of any recording."""

    def speech_mask(self, y):
        mask = np.zeros(len(y), dtype=bool)
        mask[:len(y) // 2] = True
        return mask


class FixedVoice:
    def __init__(self):
        self.calls = 0

    def embed(self, y):
        self.calls += 1
        return np.array([1.0, 0.0], dtype=np.float32)


def test_a_clip_is_scored_on_its_speech_only():
    embedder = FixedVoice()
    score, seconds = verify.score_clip(np.ones(SR * 12, dtype=np.float32), HalfSpeech(), embedder, np.array([0.6, 0.8]))
    assert seconds == 6.0 and score == pytest.approx(0.6) and embedder.calls == 1


def test_a_clip_with_too_little_speech_is_not_embedded():
    embedder = FixedVoice()
    score, seconds = verify.score_clip(np.ones(SR * 4, dtype=np.float32), HalfSpeech(), embedder, np.array([1.0, 0.0]))
    assert np.isnan(score) and seconds == 2.0 and embedder.calls == 0


def test_a_clip_is_a_match_mismatch_or_too_short():
    assert decide.check_clip(0.6, ENOUGH, 0.5) == decide.MATCH
    assert decide.check_clip(0.4, ENOUGH, 0.5) == decide.MISMATCH
    assert decide.check_clip(0.9, ENOUGH - 0.1, 0.5) == decide.TOO_SHORT
    assert decide.check_clip(float("nan"), ENOUGH, 0.5) == decide.TOO_SHORT


def test_a_visit_passes_only_when_both_recordings_match():
    assert decide.decide(0.8, ENOUGH, 0.7, ENOUGH, 0.5)["passed"] is True
    result = decide.decide(0.8, ENOUGH, 0.2, ENOUGH, 0.5)
    assert (result["caregiver"], result["dependant"], result["passed"]) == (decide.MATCH, decide.MISMATCH, False)
    assert decide.decide(0.8, ENOUGH, 0.9, 1.0, 0.5)["passed"] is False


def visit(scenario, caregiver, dependant):
    return {"scenario": scenario, "caregiver_score": caregiver, "caregiver_speech": ENOUGH,
            "dependant_score": dependant, "dependant_speech": ENOUGH}


def separable_visits():
    return [visit(decide.GENUINE, 0.8, 0.8), visit("caregiver_alone", 0.8, 0.1),
            visit("different_dependant", 0.8, 0.1), visit("different_caregiver", 0.1, 0.8)]


def test_error_rates_count_each_scenario_separately():
    rates = decide.error_rates(separable_visits(), 0.5)
    assert rates["false_reject"] == 0
    assert set(rates["false_accept"].values()) == {0.0}


def test_calibration_finds_a_threshold_that_meets_the_target():
    rule = decide.calibrate(separable_visits())
    assert rule["met_target"] is True and rule["false_reject"] == 0


def test_calibration_says_so_when_nothing_meets_the_target():
    visits = [visit(name, 0.9, 0.9) for name in decide.SCENARIOS]
    assert decide.calibrate(visits)["met_target"] is False


def test_equal_error_rate_on_known_examples():
    assert metrics.equal_error_rate([1, 1, 0, 0], [0.9, 0.8, 0.2, 0.1])[0] == 0
    assert metrics.equal_error_rate([1, 1, 0, 0], [0.1, 0.2, 0.8, 0.9])[0] == 1
    labels = [1, 0, 1, 0]
    assert metrics.equal_error_rate(labels, [0.9, 0.8, 0.5, 0.2])[0] == pytest.approx(0.5)


def test_min_dcf_is_zero_when_perfect():
    assert metrics.min_dcf([1, 1, 0, 0], [0.9, 0.8, 0.2, 0.1]) == 0


def test_the_interval_resamples_whole_clusters():
    # One cluster holds every event, so a resample without it is all zeros: only cluster resampling is this wide.
    events = np.array([1, 1, 1, 1, 0, 0, 0, 0])
    clusters = np.array([0, 0, 0, 0, 1, 1, 1, 1])
    low, high = metrics.rate_ci(events, clusters, n=200)
    assert low == 0.0 and high == 1.0
