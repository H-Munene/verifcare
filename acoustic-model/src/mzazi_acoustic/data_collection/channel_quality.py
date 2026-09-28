"""Channel-quality proxies: descriptions of the recording conditions, not of the speaker.

Computed at each file's native sample rate, because resampling would hide exactly the bandwidth
differences we want to see. Known limitation (PLAN.md 3.3): the "quiet frames" used for the noise
floor and noise flatness are mostly pauses in the speech, so these proxies are partly coupled to how
much a person pauses. That is why family A features are only reported against them, not removed.
"""

import numpy as np
from scipy import signal

from mzazi_acoustic.common import config


def channel_proxies(y, sr):
    frame = int(round(config.PROXY_FRAME_SECONDS * sr))
    n_frames = len(y) // frame
    # Non-overlapping frames are enough for a file-level summary.
    frames = y[: n_frames * frame].reshape(n_frames, frame).astype(np.float64)
    intensity = 20 * np.log10(np.maximum(np.sqrt((frames**2).mean(axis=1)), 1e-6))
    quiet_level = np.percentile(intensity, config.PROXY_QUIET_PERCENTILE)

    # Power spectrum of exactly the same frames.
    _, _, spec = signal.stft(y[: n_frames * frame], fs=sr, nperseg=frame, noverlap=0,
                             boundary=None, padded=False)
    power = np.abs(spec) ** 2  # (freq bins, frames)
    freqs = np.linspace(0, sr / 2, power.shape[0])

    # Bandwidth: the frequency below which 99 % of the long-term spectral energy lies.
    long_term = power.mean(axis=1)
    cumulative = np.cumsum(long_term) / long_term.sum()
    bandwidth = freqs[np.searchsorted(cumulative, config.PROXY_BANDWIDTH_ENERGY_SHARE)]

    # Spectral flatness (geometric / arithmetic mean) of the quiet frames: 1 = white noise,
    # near 0 = tonal hum or strongly coloured noise.
    quiet = intensity <= quiet_level
    quiet_power = power[:, quiet] + 1e-20
    flatness = np.exp(np.log(quiet_power).mean(axis=0)) / quiet_power.mean(axis=0)

    return {
        "noise_floor_dbfs": float(quiet_level),
        "bandwidth_hz": float(bandwidth),
        "noise_flatness": float(np.median(flatness)),
    }
