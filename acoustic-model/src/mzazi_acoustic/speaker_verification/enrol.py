"""An enrolment voiceprint from about 30 seconds of speech."""

import numpy as np

from mzazi_acoustic.common import config


def voiceprint_from_speech(speech, embedder, seconds=config.SV_ENROL_SECONDS):
    """The voiceprint of the first `seconds` of audio already reduced to speech only."""
    return embedder.embed(np.asarray(speech, dtype=np.float32)[:round(seconds * config.SV_SAMPLE_RATE)])


def voiceprint(y, vad, embedder, seconds=config.SV_ENROL_SECONDS):
    """The voiceprint of a raw recording: silence removed, then the first `seconds` of speech."""
    y = np.asarray(y, dtype=np.float32)
    return voiceprint_from_speech(y[vad.speech_mask(y)], embedder, seconds)
