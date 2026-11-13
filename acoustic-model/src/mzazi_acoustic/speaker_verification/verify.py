"""Score one visit recording against the enrolled voiceprint it claims to be."""

import numpy as np

from mzazi_acoustic.common import config


def score_clip(y, vad, embedder, voiceprint, min_speech=config.SV_MIN_CLIP_SPEECH_SECONDS):
    """(cosine similarity, seconds of speech) for one raw clip, silence removed.

    A clip with too little speech isn't embedded and scores NaN, so it can never pass as a match.
    """
    y = np.asarray(y, dtype=np.float32)
    speech = y[vad.speech_mask(y)]
    seconds = len(speech) / config.SV_SAMPLE_RATE
    if seconds < min_speech:
        return float("nan"), seconds
    return float(embedder.embed(speech) @ voiceprint), seconds
