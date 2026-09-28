"""Intensity-based pause detector (PLAN.md 3.2) and the pause/timing features built on it (PLAN.md 3.1 A).

Works on a single waveform, so the same code runs in training and in the deployed service.

How it works:
1. Frame intensity in dB (25 ms window, 10 ms hop, frames centred on multiples of the hop).
2. Threshold = max(speech level - 25 dB, noise level + 6 dB). Both levels are percentiles of the
   file's own intensity, so gain doesn't matter; the second term only matters in noisy recordings.
3. Sounding bursts shorter than 25 ms become silence (clicks can't split a pause), then silent
   stretches shorter than 80 ms become speech (too short to be a pause).
4. Silence before the first speech or after the last speech is ignored: pauses are internal only.

Boundary convention: a frame reads as silent only once its whole window is silent, so a run of
silent frames centred at t_a..t_b means silence from about t_a - window/2 to t_b + window/2.
Using the window edges (not the frame centres) avoids shortening every pause by about one window
length, which would push true 80-100 ms pauses under the minimum. Each boundary is moved out a
further half hop: the first fully silent frame lands anywhere up to one hop after the true
start, so half a hop centres the error at zero (each boundary is then within +/- hop/2).
Pauses and speech segments tile the analysed span exactly.
"""

from dataclasses import dataclass

import numpy as np

from mzazi_acoustic.common import config
from mzazi_acoustic.common.audio import rms_db


@dataclass
class PauseResult:
    pauses: list  # (start_s, end_s) of each internal pause
    speech_segments: list  # (start_s, end_s) of each stretch of speech
    analysed_seconds: float  # first speech onset to last speech offset
    threshold_db: float
    dynamic_range_db: float  # speech level minus noise level; low values mean an unreliable result


def silence_threshold(intensity_db):
    """Returns (threshold_db, dynamic_range_db).

    The noise guard raises the threshold to at least NOISE_MARGIN_DB above the noise level, but the
    threshold is also kept at least NOISE_MARGIN_DB below the speech level. When a recording has
    too little dynamic range for both (under 12 dB), the speech side wins: missing a pause is
    safer than turning speech into invented pauses. The dynamic range is returned so such files
    can be flagged.
    """
    speech_level = np.percentile(intensity_db, config.SPEECH_LEVEL_PERCENTILE)
    noise_level = np.percentile(intensity_db, config.NOISE_LEVEL_PERCENTILE)
    threshold = max(speech_level - config.SILENCE_DB_BELOW_SPEECH, noise_level + config.NOISE_MARGIN_DB)
    threshold = min(threshold, speech_level - config.NOISE_MARGIN_DB)
    return threshold, speech_level - noise_level


def runs(mask):
    """Split a boolean array into runs: list of [start_index, end_index_exclusive, value]."""
    if len(mask) == 0:
        return []
    change = np.flatnonzero(np.diff(mask.astype(np.int8))) + 1
    starts = np.concatenate([[0], change])
    ends = np.concatenate([change, [len(mask)]])
    return [[int(s), int(e), bool(mask[s])] for s, e in zip(starts, ends)]


def _flip_short_runs(silent, value, min_seconds, duration_of):
    """Flip runs of `value` (True = silent) shorter than min_seconds.

    Short sounding bursts are flipped anywhere: a click at the very start must not become
    "speech" that turns the leading silence into a pause. Silent runs are only flipped when
    internal, since edge silence is ignored anyway.
    """
    silent = silent.copy()
    all_runs = runs(silent)
    for i, (start, end, is_silent) in enumerate(all_runs):
        internal = 0 < i < len(all_runs) - 1
        eligible = internal or not value
        if eligible and is_silent == value and duration_of(start, end) < min_seconds:
            silent[start:end] = not value
    return silent


def detect_pauses(y, sr):
    hop = config.HOP_SECONDS
    window = config.FRAME_SECONDS
    intensity = rms_db(y, int(round(window * sr)), int(round(hop * sr)))
    total_seconds = len(y) / sr
    threshold, dynamic_range = silence_threshold(intensity)
    silent = intensity < threshold

    # A silent run of frames [start, end) is the pause from pause_start(start) to pause_end(end);
    # a sounding run is the speech between those same boundaries (see module docstring).
    def pause_start(start):
        return start * hop - window / 2 - hop / 2

    def pause_end(end):
        return (end - 1) * hop + window / 2 + hop / 2

    def pause_seconds(start, end):
        return pause_end(end) - pause_start(start)  # = frames * hop + window

    def speech_seconds(start, end):
        return pause_start(end) - pause_end(start)  # = frames * hop - window

    silent = _flip_short_runs(silent, False, config.MIN_SPEECH_SECONDS, speech_seconds)
    silent = _flip_short_runs(silent, True, config.MIN_PAUSE_SECONDS, pause_seconds)

    pauses, speech = [], []
    for start, end, is_silent in runs(silent):
        if is_silent:
            if start > 0 and end < len(silent):  # internal pauses only
                pauses.append((pause_start(start), pause_end(end)))
        else:
            seg_start = 0.0 if start == 0 else pause_end(start)
            seg_end = total_seconds if end == len(silent) else pause_start(end)
            speech.append((max(seg_start, 0.0), min(seg_end, total_seconds)))

    analysed = speech[-1][1] - speech[0][0] if speech else 0.0
    return PauseResult(pauses, speech, analysed, float(threshold), float(dynamic_range))


def pause_features(result):
    """Family A pause/timing features (PLAN.md 3.1, frozen set) plus descriptive and diagnostic values.

    Values that are undefined for a recording (e.g. median pause length with no pauses) are NaN;
    how NaNs are handled is decided in PLAN.md 3.3 step 1, not here.
    """
    durations = np.array([end - start for start, end in result.pauses])
    minutes = result.analysed_seconds / 60
    speech_time = sum(end - start for start, end in result.speech_segments)
    is_long = durations > config.LONG_PAUSE_SECONDS
    has_pauses = len(durations) > 0
    has_speech = minutes > 0

    return {
        # model features (frozen set)
        "pause_rate_per_min": len(durations) / minutes if has_speech else np.nan,
        "mean_pause_s": durations.mean() if has_pauses else np.nan,
        "median_pause_s": float(np.median(durations)) if has_pauses else np.nan,
        "long_pause_rate_per_min": is_long.sum() / minutes if has_speech else np.nan,
        "long_pause_time_share": durations[is_long].sum() / durations.sum() if has_pauses else np.nan,
        "phonation_time_ratio": speech_time / result.analysed_seconds if has_speech else np.nan,
        "mean_speech_segment_s": speech_time / len(result.speech_segments) if has_speech else np.nan,
        # descriptive only: short = total - long, kept out of the model (PLAN.md 3.1)
        "short_pause_rate_per_min": (~is_long).sum() / minutes if has_speech else np.nan,
        # diagnostics
        "n_pauses": len(durations),
        "analysed_seconds": result.analysed_seconds,
        "detector_threshold_db": result.threshold_db,
        "detector_dynamic_range_db": result.dynamic_range_db,
    }


def extract_pause_features(y, sr):
    return pause_features(detect_pauses(y, sr))
