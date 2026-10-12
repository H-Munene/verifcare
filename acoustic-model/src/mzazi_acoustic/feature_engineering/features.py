"""The single-recording feature function (PLAN.md 1.2): one waveform in, one dict out.

Training builds the feature matrix by calling this on every clip, and the deployed service calls it
on each uploaded recording, so the model always sees features computed the same way.
"""

import numpy as np

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering import pause_detector
from mzazi_acoustic.feature_engineering.egemaps import egemaps_features


def extract_features(y, sr):
    result = pause_detector.detect_pauses(y, sr)
    pauses = pause_detector.pause_features(result)
    smile = egemaps_features(y, sr)

    # Articulation-rate proxy = loudness peaks per second of SPEECH (PLAN.md 3.1).
    # openSMILE divides its peak count by the total input duration (verified, see egemaps.py),
    # so peaks = loudnessPeaksPerSec x len(y)/sr; dividing by the detector's speech time
    # (sum of speech segments) removes the pausing that a speaking rate would include.
    peak_count = smile.pop("loudness_peaks_per_s") * len(y) / sr
    speech_seconds = sum(end - start for start, end in result.speech_segments)
    articulation = peak_count / speech_seconds if speech_seconds > 0 else np.nan

    features = {name: pauses[name] for name in config.FAMILY_A_FEATURES if name in pauses}
    features.update(smile)
    features["articulation_rate_proxy"] = articulation
    ordered = {name: features[name] for name in config.MODEL_FEATURES}
    ordered["short_pause_rate_per_min"] = pauses["short_pause_rate_per_min"]  # descriptive only
    for name in ["n_pauses", "analysed_seconds", "detector_threshold_db", "detector_dynamic_range_db"]:
        ordered[name] = pauses[name]
    ordered["noise_guard_active"] = bool(pauses["detector_dynamic_range_db"] < config.NOISE_GUARD_ACTIVE_BELOW_DB)
    return ordered
