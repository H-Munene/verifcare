"""The visit-level decision, and choosing its rule on calibration speakers only."""

import numpy as np

from mzazi_acoustic.common import config
from mzazi_acoustic.speaker_verification import segment

GENUINE = "genuine"
FRAUD_SCENARIOS = ("caregiver_alone", "different_dependant", "different_caregiver")
SCENARIOS = (GENUINE, *FRAUD_SCENARIOS)


def speech_seconds(labels):
    """Seconds of speech labelled (caregiver, dependant, unknown). Each window stands for one hop."""
    labels = np.asarray(labels)
    return tuple(float((labels == who).sum() * config.SV_HOP_SECONDS)
                 for who in (segment.CAREGIVER, segment.DEPENDANT, segment.UNKNOWN))


def decide(labels, caregiver_seconds, dependant_seconds):
    """Whether each enrolled voice was heard for at least its required time."""
    heard_caregiver, heard_dependant, unknown = speech_seconds(labels)
    caregiver_present = heard_caregiver >= caregiver_seconds
    dependant_present = heard_dependant >= dependant_seconds
    return {"caregiver_present": caregiver_present, "dependant_present": dependant_present,
            "passed": caregiver_present and dependant_present, "caregiver_seconds": heard_caregiver,
            "dependant_seconds": heard_dependant, "unknown_seconds": unknown}


def error_rates(visits, threshold, caregiver_seconds, dependant_seconds):
    """False reject rate on genuine visits and false accept rate per fraud scenario."""
    passed = {name: [] for name in SCENARIOS}
    for visit in visits:
        labels = segment.label_windows(visit["caregiver_scores"], visit["dependant_scores"], threshold)
        passed[visit["scenario"]].append(decide(labels, caregiver_seconds, dependant_seconds)["passed"])
    return {"false_reject": 1 - float(np.mean(passed[GENUINE])),
            "false_accept": {name: float(np.mean(passed[name])) for name in FRAUD_SCENARIOS}}


def calibrate(visits, target_false_accept=config.SV_TARGET_FALSE_ACCEPT,
              thresholds=config.SV_THRESHOLD_GRID, seconds_grid=config.SV_SECONDS_GRID):
    """The rule with the fewest false rejects among those meeting the false accept target in every scenario.

    If none meets it, the rule with the lowest worst-scenario false accept rate, and met_target is False.
    """
    best, best_key = None, None
    for threshold in thresholds:
        for x in seconds_grid:
            for y in seconds_grid:
                rates = error_rates(visits, threshold, x, y)
                worst = max(rates["false_accept"].values())
                met = worst <= target_false_accept
                key = (not met, 0 if met else worst, rates["false_reject"], worst, -threshold)
                if best_key is None or key < best_key:
                    best_key = key
                    best = {"threshold": threshold, "caregiver_seconds": x, "dependant_seconds": y,
                            "met_target": met, **rates}
    return best
