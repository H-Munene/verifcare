"""Label short windows of a recording as the enrolled caregiver, the enrolled dependant, or unknown."""

import numpy as np

from mzazi_acoustic.common import config

UNKNOWN, CAREGIVER, DEPENDANT = 0, 1, 2


def speech_windows(y, mask):
    """Fixed-length windows that are mostly speech: (start samples, array of windows)."""
    y = np.asarray(y, dtype=np.float32)
    length = round(config.SV_WINDOW_SECONDS * config.SV_SAMPLE_RATE)
    hop = round(config.SV_HOP_SECONDS * config.SV_SAMPLE_RATE)
    if len(y) < length:
        return np.empty(0, dtype=int), np.empty((0, length), dtype=np.float32)
    starts = np.arange(0, len(y) - length + 1, hop)
    speech_so_far = np.concatenate([[0], np.cumsum(mask)])
    share = (speech_so_far[starts + length] - speech_so_far[starts]) / length
    kept = starts[share >= config.SV_MIN_WINDOW_SPEECH_SHARE]
    if len(kept) == 0:
        return kept, np.empty((0, length), dtype=np.float32)
    return kept, np.stack([y[start:start + length] for start in kept])


def score_windows(y, mask, embedder, caregiver, dependant):
    """Cosine similarity of each speech window to the two enrolled voiceprints."""
    _, windows = speech_windows(y, mask)
    embeddings = embedder.embed_batch(windows)
    return embeddings @ caregiver, embeddings @ dependant


def label_windows(caregiver_scores, dependant_scores, threshold, margin=config.SV_LABEL_MARGIN):
    """Each window goes to the voice it matches, unless it matches neither or is too close to call."""
    caregiver_scores, dependant_scores = np.asarray(caregiver_scores), np.asarray(dependant_scores)
    labels = np.full(len(caregiver_scores), UNKNOWN)
    labels[(caregiver_scores >= threshold) & (caregiver_scores - dependant_scores >= margin)] = CAREGIVER
    labels[(dependant_scores >= threshold) & (dependant_scores - caregiver_scores >= margin)] = DEPENDANT
    return labels
