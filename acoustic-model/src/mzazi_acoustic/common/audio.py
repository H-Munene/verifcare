"""Reading audio files. Every stage loads audio through here, so they all see the same waveform."""

import numpy as np
import soundfile as sf


def read_mono(path):
    """Return (waveform, sample_rate) with channels averaged into one float32 signal in [-1, 1]."""
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    return y.mean(axis=1), sr


def rms_db(y, frame_length, hop_length):
    """Frame-level RMS intensity in dB relative to full scale, one value per hop (frames centred)."""
    padded = np.pad(y.astype(np.float64), frame_length // 2)
    n_frames = 1 + (len(padded) - frame_length) // hop_length
    if n_frames < 1:
        return np.array([])
    # Running sum of squares: O(n) memory, unlike materialising every frame of a long file.
    cumulative = np.concatenate([[0.0], np.cumsum(padded**2)])
    starts = np.arange(n_frames) * hop_length
    energy = np.maximum(cumulative[starts + frame_length] - cumulative[starts], 0.0)
    rms = np.sqrt(energy / frame_length)
    # Floor at -120 dBFS so digital silence gives a finite value instead of -inf.
    return 20 * np.log10(np.maximum(rms, 1e-6))
