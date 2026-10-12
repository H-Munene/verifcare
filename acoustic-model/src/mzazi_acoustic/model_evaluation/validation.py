"""Stage 5.1 helpers (PLAN.md 5.1): person-weighted permutation importance and the robustness test.

Everything here works on the training portion only (CV validation folds); the test set is untouched.
"""

import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score

from mzazi_acoustic.model_training.weights import person_weights


def person_weighted_auc(y, p, subject_ids):
    return float(roc_auc_score(np.asarray(y), np.asarray(p), sample_weight=person_weights(np.asarray(subject_ids))))


def permutation_importance(model, X, y, subject_ids, feature_cols, n_repeats, rng):
    """Drop in person-weighted ROC-AUC when one feature's values are shuffled across clips.

    Shuffling breaks that feature's link to the label while keeping its distribution, so the drop
    shows how much the model relies on it. It measures association, not causation (PLAN.md 5.1).
    Returns one row per feature: mean and SD of the drop over n_repeats shuffles.
    """
    X = pd.DataFrame(X, columns=feature_cols).reset_index(drop=True)
    baseline = person_weighted_auc(y, model.predict_proba(X.to_numpy(float))[:, 1], subject_ids)
    rows = []
    for feature in feature_cols:
        drops = []
        for _ in range(n_repeats):
            shuffled = X.copy()
            shuffled[feature] = rng.permutation(shuffled[feature].to_numpy())
            p = model.predict_proba(shuffled.to_numpy(float))[:, 1]
            drops.append(baseline - person_weighted_auc(y, p, subject_ids))
        rows.append({"feature": feature, "importance_mean": float(np.mean(drops)), "importance_sd": float(np.std(drops))})
    return pd.DataFrame(rows)
