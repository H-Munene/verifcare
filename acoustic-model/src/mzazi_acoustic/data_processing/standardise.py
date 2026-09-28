"""Stage 2 audio standardisation: 16 kHz mono, edge trimming, 90 s truncation (PLAN.md Stage 2).

Works on a single waveform, so the deployed service can reuse it unchanged.

Trimming has its own simple energy rule with its own frozen parameters (config.TRIM_*), and is
deliberately independent of the pause detector. The detector may later be tuned against manual
annotations; if trimming used the detector, that tuning would move the 30 s minimum and therefore
the split. Internal silences are never touched. A consequence: the pause features describe the
detector's span (first to last detected speech), which can be slightly narrower than the trimmed
audio.
"""

import numpy as np
import soxr

from mzazi_acoustic.common import config
from mzazi_acoustic.common.audio import rms_db


def to_16k_mono(y, sr):
    """y must already be mono (common.audio.read_mono averages channels)."""
    if sr == config.TARGET_SAMPLE_RATE:
        return y.astype(np.float32)
    return soxr.resample(y, sr, config.TARGET_SAMPLE_RATE, quality="HQ").astype(np.float32)


def speech_span(y, sr):
    """(start_s, end_s) from the first to the last frame within TRIM_DB_BELOW_REFERENCE of the
    file's reference level. Frames are centred on multiples of the hop, so each kept frame
    contributes half a window either side. Returns (0.0, 0.0) for an empty or all-silent signal.
    """
    hop = int(round(config.TRIM_HOP_SECONDS * sr))
    level = rms_db(y, int(round(config.TRIM_FRAME_SECONDS * sr)), hop)
    if len(level) == 0 or np.max(level) <= -120:
        return 0.0, 0.0
    reference = np.percentile(level, config.TRIM_REFERENCE_PERCENTILE)
    loud = np.flatnonzero(level >= reference - config.TRIM_DB_BELOW_REFERENCE)
    half_window = config.TRIM_FRAME_SECONDS / 2
    start = max(loud[0] * config.TRIM_HOP_SECONDS - half_window, 0.0)
    end = min(loud[-1] * config.TRIM_HOP_SECONDS + half_window, len(y) / sr)
    return start, end


def trim_and_truncate(y, sr):
    """Trim edge silence, then keep at most MAX_DURATION_SECONDS. Returns (audio, trimmed_seconds).

    trimmed_seconds is the length *before* truncation: the 30 s minimum is judged on it.
    """
    start, end = speech_span(y, sr)
    trimmed = y[int(round(start * sr)):int(round(end * sr))]
    kept = trimmed[:int(config.MAX_DURATION_SECONDS * sr)]
    return kept, len(trimmed) / sr
