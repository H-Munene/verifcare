"""The visit decision from its two recordings, and choosing the threshold on calibration speakers only."""

import numpy as np

from mzazi_acoustic.common import config

GENUINE = "genuine"
FRAUD_SCENARIOS = ("caregiver_alone", "different_dependant", "different_caregiver")
SCENARIOS = (GENUINE, *FRAUD_SCENARIOS)
MATCH, MISMATCH, TOO_SHORT = "match", "mismatch", "too_short"


def check_clip(score, speech_seconds, threshold, min_speech=config.SV_MIN_CLIP_SPEECH_SECONDS):
    """Whether one recording matches the voiceprint it claims, or has too little speech to judge."""
    if speech_seconds < min_speech or np.isnan(score):
        return TOO_SHORT
    return MATCH if score >= threshold else MISMATCH


def decide(caregiver_score, caregiver_speech, dependant_score, dependant_speech, threshold,
           min_speech=config.SV_MIN_CLIP_SPEECH_SECONDS):
    """A visit passes only when the caregiver's recording and the dependant's recording both match."""
    caregiver = check_clip(caregiver_score, caregiver_speech, threshold, min_speech)
    dependant = check_clip(dependant_score, dependant_speech, threshold, min_speech)
    return {"caregiver": caregiver, "dependant": dependant, "passed": caregiver == dependant == MATCH,
            "caregiver_score": caregiver_score, "dependant_score": dependant_score,
            "caregiver_speech_seconds": caregiver_speech, "dependant_speech_seconds": dependant_speech}


def decide_visit(visit, threshold):
    return decide(visit["caregiver_score"], visit["caregiver_speech"], visit["dependant_score"],
                  visit["dependant_speech"], threshold)


def error_rates(visits, threshold):
    """False reject rate on genuine visits and false accept rate per fraud scenario."""
    passed = {name: [] for name in SCENARIOS}
    for visit in visits:
        passed[visit["scenario"]].append(decide_visit(visit, threshold)["passed"])
    return {"false_reject": 1 - float(np.mean(passed[GENUINE])),
            "false_accept": {name: float(np.mean(passed[name])) for name in FRAUD_SCENARIOS}}


def calibrate(visits, target_false_accept=config.SV_TARGET_FALSE_ACCEPT, thresholds=config.SV_THRESHOLD_GRID):
    """The threshold with the fewest false rejects among those meeting the false accept target in every scenario.

    If none meets it, the threshold with the lowest worst-scenario false accept rate, and met_target is False.
    """
    best, best_key = None, None
    for threshold in thresholds:
        rates = error_rates(visits, threshold)
        worst = max(rates["false_accept"].values())
        met = worst <= target_false_accept
        key = (not met, 0 if met else worst, rates["false_reject"], worst, -threshold)
        if best_key is None or key < best_key:
            best_key = key
            best = {"threshold": threshold, "min_clip_speech_seconds": config.SV_MIN_CLIP_SPEECH_SECONDS,
                    "met_target": met, **rates}
    return best
