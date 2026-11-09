"""Window labelling, the visit decision, calibration and metrics."""

import numpy as np
import pytest

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import decide, metrics, segment

SR = config.SV_SAMPLE_RATE
HOP = config.SV_HOP_SECONDS


def test_only_mostly_speech_windows_are_kept():
    y = np.ones(SR * 6, dtype=np.float32)
    mask = np.zeros(len(y), dtype=bool)
    mask[:SR * 3] = True
    starts, windows = segment.speech_windows(y, mask)
    assert len(windows) == len(starts) > 0
    assert (starts / SR <= 3 - config.SV_WINDOW_SECONDS * config.SV_MIN_WINDOW_SPEECH_SHARE + 1e-9).all()
    assert windows.shape[1] == round(config.SV_WINDOW_SECONDS * SR)


def test_a_recording_with_no_speech_gives_no_windows():
    y = np.ones(SR * 3, dtype=np.float32)
    assert len(segment.speech_windows(y, np.zeros(len(y), dtype=bool))[1]) == 0


def test_a_recording_shorter_than_a_window_gives_no_windows():
    y = np.ones(SR // 2, dtype=np.float32)
    assert len(segment.speech_windows(y, np.ones(len(y), dtype=bool))[1]) == 0


def test_windows_go_to_the_clear_match_otherwise_unknown():
    labels = segment.label_windows([0.8, 0.1, 0.1, 0.60], [0.1, 0.8, 0.1, 0.58], threshold=0.5, margin=0.05)
    assert list(labels) == [segment.CAREGIVER, segment.DEPENDANT, segment.UNKNOWN, segment.UNKNOWN]


def test_a_visit_passes_only_when_both_voices_are_heard_for_long_enough():
    both = [segment.CAREGIVER] * 8 + [segment.DEPENDANT] * 4
    assert decide.decide(both, 3 * HOP, 4 * HOP)["passed"] is True
    result = decide.decide(both, 3 * HOP, 5 * HOP)
    assert (result["caregiver_present"], result["dependant_present"], result["passed"]) == (True, False, False)


def test_unknown_speech_is_counted():
    result = decide.decide([segment.UNKNOWN] * 4, HOP, HOP)
    assert result["unknown_seconds"] == 4 * HOP and result["passed"] is False


def visit(scenario, caregiver, dependant):
    return {"scenario": scenario, "caregiver_scores": np.array(caregiver), "dependant_scores": np.array(dependant)}


def separable_visits():
    high, low = [0.8] * 12, [0.0] * 12
    return [visit(decide.GENUINE, high + low, low + high), visit("caregiver_alone", high + low, low + low),
            visit("different_dependant", high + low, low + low), visit("different_caregiver", low + low, low + high)]


def test_error_rates_count_each_scenario_separately():
    rates = decide.error_rates(separable_visits(), 0.5, HOP, HOP)
    assert rates["false_reject"] == 0
    assert set(rates["false_accept"].values()) == {0.0}


def test_calibration_finds_a_rule_that_meets_the_target():
    rule = decide.calibrate(separable_visits())
    assert rule["met_target"] is True and rule["false_reject"] == 0


def test_calibration_says_so_when_nothing_meets_the_target():
    high = [0.9] * 24
    visits = [visit(name, high[:12] + [0.0] * 12, [0.0] * 12 + high[:12]) for name in decide.SCENARIOS]
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
