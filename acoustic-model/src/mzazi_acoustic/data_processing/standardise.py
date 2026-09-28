"""Stage 2 audio standardisation: 16 kHz mono, edge trimming, 90 s truncation (PLAN.md Stage 2).

Works on a single waveform, so the deployed service can reuse it unchanged.

Trimming uses the pause detector's own silence rule: speech starts at the detector's first speech
onset and ends at its last speech offset. Reason: one definition of "silence" across the whole
pipeline. A second rule (e.g. librosa's trim at 60 dB below the peak) would disagree with the
detector about where speech starts, and the pre-registered 30 s minimum would then be measured
differently from the span the pause features are computed on. Internal silences are never touched.
"""

import numpy as np
import soxr

from mzazi_acoustic.common import config
from mzazi_acoustic.feature_engineering import pause_detector


def to_16k_mono(y, sr):
    """y must already be mono (common.audio.read_mono averages channels)."""
    if sr == config.TARGET_SAMPLE_RATE:
        return y.astype(np.float32)
    return soxr.resample(y, sr, config.TARGET_SAMPLE_RATE, quality="HQ").astype(np.float32)


def speech_span(y, sr):
    """(start_s, end_s) of the speech, from the pause detector; (0.0, 0.0) if no speech is found."""
    segments = pause_detector.detect_pauses(y, sr).speech_segments
    if not segments:
        return 0.0, 0.0
    return segments[0][0], segments[-1][1]


def trim_and_truncate(y, sr):
    """Trim edge silence, then keep at most MAX_DURATION_SECONDS. Returns (audio, trimmed_seconds).

    trimmed_seconds is the length *before* truncation: the 30 s minimum is judged on it.
    """
    start, end = speech_span(y, sr)
    trimmed = y[int(round(start * sr)):int(round(end * sr))]
    kept = trimmed[:int(config.MAX_DURATION_SECONDS * sr)]
    return kept, len(trimmed) / sr
