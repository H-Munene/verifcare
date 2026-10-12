"""Simulated phone recording conditions (PLAN.md 3.2 validation, 3.3 step 4, 5.1).

One place for this, so the detector validation, the family A robustness check and the Stage 5
robustness curve all degrade audio identically.

The noise level is set from the SNR measured *after* the phone bandpass. Setting it before
filtering would miss the target, because the filter removes noise unevenly: pink noise has
much of its energy below 100 Hz, which the bandpass throws away. By linearity,
bandpass(speech + g * noise) = bandpass(speech) + g * bandpass(noise), so the gain g that hits
the target in-band SNR can be computed exactly, in one step.
"""

import numpy as np
from scipy import signal

from mzazi_acoustic.common import config


def bandpass(y, sr):
    sos = signal.butter(config.BANDPASS_ORDER, [config.BANDPASS_LOW_HZ, config.BANDPASS_HIGH_HZ],
                        btype="band", fs=sr, output="sos")
    return signal.sosfiltfilt(sos, y)  # zero-phase, so pause boundaries don't shift in time


def white_noise(n, rng):
    return rng.standard_normal(n)


def pink_noise(n, rng):
    """1/f power spectrum: shape white noise in the frequency domain by 1/sqrt(f)."""
    spectrum = np.fft.rfft(rng.standard_normal(n))
    f = np.arange(len(spectrum))
    spectrum[1:] /= np.sqrt(f[1:])
    spectrum[0] = 0  # no DC offset
    return np.fft.irfft(spectrum, n)


NOISE_MAKERS = {"white": white_noise, "pink": pink_noise}


def power(x):
    return float(np.mean(np.square(x, dtype=np.float64)))


def degrade(y, sr, noise_type=None, snr_db=None, rng=None):
    """Phone bandpass, optionally plus noise at an SNR measured after filtering.

    Returns (degraded_signal, measured_snr_db); the SNR is None for bandpass alone.
    """
    speech = bandpass(y, sr)
    if noise_type is None:
        return speech, None
    noise = bandpass(NOISE_MAKERS[noise_type](len(y), rng), sr)
    gain = np.sqrt(power(speech) / (power(noise) * 10 ** (snr_db / 10)))
    scaled_noise = gain * noise
    measured_snr = 10 * np.log10(power(speech) / power(scaled_noise))
    return speech + scaled_noise, measured_snr


def conditions():
    """The degradation conditions in PLAN.md order: bandpass alone, then each noise at each SNR."""
    result = [("bandpass", None, None)]
    for noise_type in config.NOISE_TYPES:
        for snr in config.TARGET_SNRS_DB:
            result.append((f"bandpass+{noise_type}@{snr:g}dB", noise_type, snr))
    return result
