"""Evaluation metrics, person-weighted (primary) and unweighted (PLAN.md 4.2, pre-registered 2026-09-28).

Person-weighted = each clip weighs 1 / its person's clip count, so every person counts equally.
Threshold-dependent metrics use Youden's J threshold chosen on the same predictions, so they are
optimistic and labelled as such; sensitivity at a fixed specificity is the fairer companion.
Reused by Stage 5.
"""

import numpy as np
from sklearn.metrics import average_precision_score, brier_score_loss, f1_score, roc_auc_score, roc_curve

from mzazi_acoustic.common import config
from mzazi_acoustic.model_training.weights import person_weights


def expected_calibration_error(y, p, sample_weight=None, bins=config.CALIBRATION_BINS):
    """Weighted mean over equal-width probability bins of |observed rate - mean predicted|."""
    y, p = np.asarray(y, float), np.asarray(p, float)
    w = np.ones_like(p) if sample_weight is None else np.asarray(sample_weight, float)
    which = np.minimum((p * bins).astype(int), bins - 1)
    ece = 0.0
    for b in range(bins):
        in_bin = which == b
        if w[in_bin].sum() > 0:
            ece += w[in_bin].sum() / w.sum() * abs(np.average(y[in_bin], weights=w[in_bin])
                                                   - np.average(p[in_bin], weights=w[in_bin]))
    return ece


def _metrics(y, p, w):
    fpr, tpr, thresholds = roc_curve(y, p, sample_weight=w)
    best = np.argmax(tpr - fpr)
    predicted = p >= thresholds[best]
    meets_spec = (1 - fpr) >= config.FIXED_SPECIFICITY
    return {
        "roc_auc": roc_auc_score(y, p, sample_weight=w),
        "pr_auc": average_precision_score(y, p, sample_weight=w),
        "brier": brier_score_loss(y, p, sample_weight=w),
        "ece": expected_calibration_error(y, p, w),
        "youden_threshold": float(min(thresholds[best], 1.0)),
        "f1_at_youden_optimistic": f1_score(y, predicted, sample_weight=w),
        "sensitivity_at_youden_optimistic": float(tpr[best]),
        "specificity_at_youden_optimistic": float(1 - fpr[best]),
        f"sensitivity_at_{round(config.FIXED_SPECIFICITY * 100)}_specificity": float(tpr[meets_spec].max()),
    }


def evaluate(y, p, subject_ids):
    """All metrics twice: '<name>_person' (primary) and '<name>_clip' (unweighted)."""
    y, p = np.asarray(y), np.asarray(p)
    person = {f"{k}_person": v for k, v in _metrics(y, p, person_weights(subject_ids)).items()}
    clip = {f"{k}_clip": v for k, v in _metrics(y, p, None).items()}
    return person | clip
