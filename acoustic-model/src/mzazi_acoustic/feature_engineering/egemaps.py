"""The eGeMAPS subset used by the model (PLAN.md 3.1): voiced/unvoiced timing, loudness peaks,
jitter, shimmer and HNR, from openSMILE's eGeMAPSv02 functionals. Everything else eGeMAPS computes
(MFCCs, formants, pitch level, spectral balance, loudness level) is deliberately dropped, because
it encodes the language or the microphone.

Verified 2026-09-28 on synthetic signals (test_egemaps.py pins it): `loudnessPeaksPerSec` is
normalised by the TOTAL input duration, silence included. The same 16 peaks give 4.0 over 4 s,
2.0 over 8 s and 1.33 over 12 s. So it is a speaking rate, not an articulation rate.
"""

import functools

import opensmile

from mzazi_acoustic.common import config


@functools.cache
def _smile():
    # Building the extractor loads the config from disk; do it once per process.
    return opensmile.Smile(feature_set=opensmile.FeatureSet.eGeMAPSv02,
                           feature_level=opensmile.FeatureLevel.Functionals)


def egemaps_features(y, sr):
    """The subset in config.EGEMAPS_COLUMNS, renamed to our feature names."""
    row = _smile().process_signal(y, sr).iloc[0]
    return {ours: float(row[theirs]) for theirs, ours in config.EGEMAPS_COLUMNS.items()}
