"""The D5 operating threshold (supervisor, 2026-10-01: favour fewer false alarms).

Pre-registered computation: in each CV repeat, the lowest threshold on the calibrated out-of-fold
probabilities whose person-weighted specificity is at least D5_TARGET_SPECIFICITY; the frozen
threshold is the median over repeats. "Lowest" because, among thresholds that keep false alarms
within the target, it catches the most cases. A clip is flagged when its probability >= threshold.
Computed only from out-of-fold predictions (training portion), and written to config before the
test set is ever used.
"""

import numpy as np

from mzazi_acoustic.common import config
from mzazi_acoustic.model_training.weights import person_weights


def person_weighted_specificity(y, p, subject_ids, threshold):
    y, p = np.asarray(y), np.asarray(p, float)
    w = person_weights(np.asarray(subject_ids))
    controls = y == 0
    return float(np.sum(w[controls] * (p[controls] < threshold)) / np.sum(w[controls]))


def threshold_for_specificity(y, p, subject_ids, target=config.D5_TARGET_SPECIFICITY):
    """Lowest threshold t (from the observed probabilities, or just above the largest) with
    person-weighted specificity >= target."""
    p = np.asarray(p, float)
    candidates = np.append(np.unique(p), np.nextafter(p.max(), np.inf))
    for t in candidates:  # ascending: specificity only grows with t
        if person_weighted_specificity(y, p, subject_ids, t) >= target:
            return float(t)
    raise AssertionError("unreachable: the last candidate flags nothing, so specificity is 1")


def frozen_threshold(oof, target=config.D5_TARGET_SPECIFICITY):
    """Median over CV repeats of each repeat's threshold.

    `oof` holds the chosen model's out-of-fold predictions: repeat, label, subject_id, probability.
    Returns (frozen threshold, per-repeat thresholds).
    """
    per_repeat = {int(r): threshold_for_specificity(g["label"], g["probability"], g["subject_id"], target)
                  for r, g in oof.groupby("repeat")}
    return float(np.median(list(per_repeat.values()))), per_repeat
