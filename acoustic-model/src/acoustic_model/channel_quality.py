"""Cheap per-file recording-channel-quality proxies.

These are not perceptual voice-quality features - jitter, shimmer, and
HNR belong to the later feature-engineering phase, where they measure
the speaker's vocal-fold physiology. The proxies here measure the
recording channel itself (background noise, frequency content), and
exist purely to check whether the dementia/no_dementia label
correlates with recording-channel characteristics rather than speaker
physiology - a distinct, channel-driven confound risk given this
dataset mixes broadcast-quality archival footage with more recent
clips. The same functions are reused later for the synthetic
degradation robustness check.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import librosa
import numpy as np

# Files are resampled to this rate for the quality-proxy computation
# only (not for the eventual feature pipeline) so the noise-floor and
# spectral proxies are comparable across files regardless of their
# original sample rate.
_ANALYSIS_SAMPLE_RATE_HZ = 22050
# Capped to the first 30 seconds per file: enough to characterize the
# recording channel, without paying the cost of decoding and
# resampling multi-minute interview audio for a cheap proxy check.
_MAX_ANALYSIS_DURATION_SECONDS = 30.0


@dataclass
class ChannelQualityProxies:
    noise_floor_db: float
    spectral_bandwidth_hz: float
    spectral_flatness: float


def compute(waveform: np.ndarray, sample_rate_hz: int) -> ChannelQualityProxies:
    """Compute channel-quality proxies for a mono waveform."""
    if waveform.ndim > 1:
        waveform = np.mean(waveform, axis=0)
    waveform = waveform.astype(np.float32)

    rms = librosa.feature.rms(y=waveform)[0]
    # The lowest-energy 10th percentile of frames approximates the
    # noise floor during pauses, without needing a separate
    # voice-activity-detection step.
    noise_floor_amplitude = np.percentile(rms, 10)
    noise_floor_db = 20 * np.log10(max(float(noise_floor_amplitude), 1e-10))

    bandwidth = librosa.feature.spectral_bandwidth(y=waveform, sr=sample_rate_hz)[0]
    flatness = librosa.feature.spectral_flatness(y=waveform)[0]

    return ChannelQualityProxies(
        noise_floor_db=float(noise_floor_db),
        spectral_bandwidth_hz=float(np.mean(bandwidth)),
        spectral_flatness=float(np.mean(flatness)),
    )


def compute_from_file(path: Path) -> ChannelQualityProxies:
    """Load an audio file (resampled, mono, capped in duration) and compute proxies."""
    waveform, sample_rate_hz = librosa.load(
        str(path),
        sr=_ANALYSIS_SAMPLE_RATE_HZ,
        mono=True,
        duration=_MAX_ANALYSIS_DURATION_SECONDS,
    )
    return compute(waveform, sample_rate_hz)
