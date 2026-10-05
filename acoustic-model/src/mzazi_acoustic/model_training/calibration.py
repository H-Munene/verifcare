"""Sigmoid (Platt) calibration fitted on subject-grouped out-of-fold scores (PLAN.md 4.2 step 4).

Done by hand instead of CalibratedClassifierCV so the grouping is explicit and testable: the
out-of-fold scores come from a StratifiedGroupKFold that receives the subject groups, so no
person's clips score a model that trained on them. The 1-D logistic fit uses per-person weights
only (1 / clips), not class balancing, so the output keeps the dataset's class balance.
"""

import numpy as np
from sklearn.base import clone
from sklearn.linear_model import LogisticRegression

from mzazi_acoustic.model_training import candidates, weights


class CalibratedModel:
    """A fitted pipeline plus the sigmoid that maps its scores to probabilities."""

    def __init__(self, pipeline, slope, intercept):
        self.pipeline, self.slope, self.intercept = pipeline, slope, intercept

    def predict_proba(self, X):
        p = 1.0 / (1.0 + np.exp(-(self.slope * candidates.scores(self.pipeline, X) + self.intercept)))
        return np.column_stack([1 - p, p])


def fit_sigmoid(scores, y, sample_weight):
    """Platt scaling with the slope constrained to be non-negative.

    Calibration may rescale a model's scores but must never reverse their order: that would turn
    calibration into a second, unvalidated classifier. With a weak signal the out-of-fold scores
    can, by chance, run against the labels; an unconstrained fit then returns a negative slope
    and inverts the model's ranking (found in Stage 4: 13 of 25 folds, 2026-10-05). The
    log-loss is convex in (slope, intercept), so when the unconstrained slope is negative the
    constrained optimum is slope = 0: predict the weighted base rate for everyone.
    """
    y, w = np.asarray(y), np.asarray(sample_weight, float)
    fit = LogisticRegression(C=np.inf).fit(np.asarray(scores).reshape(-1, 1), y, sample_weight=w)
    slope, intercept = float(fit.coef_[0, 0]), float(fit.intercept_[0])
    if slope >= 0:
        return slope, intercept
    base_rate = np.sum(w * (y == 1)) / np.sum(w)
    return 0.0, float(np.log(base_rate / (1 - base_rate)))


def out_of_fold_scores(pipeline, X, y, groups, train_weights, seed):
    """Scores for every row from a clone of `pipeline` that never trained on that row's person."""
    oof = np.empty(len(y))
    splitter = candidates.inner_splitter(seed)
    with candidates.routing():
        for train_idx, test_idx in splitter.split(X, y, groups=groups):
            model = clone(pipeline).fit(X[train_idx], y[train_idx], sample_weight=train_weights[train_idx])
            oof[test_idx] = candidates.scores(model, X[test_idx])
    return oof


def calibrate(fitted_pipeline, X, y, groups, seed):
    """Wrap an already-fitted pipeline (trained on all of X) with a sigmoid learned out-of-fold."""
    X, y, groups = np.asarray(X), np.asarray(y), np.asarray(groups)
    oof = out_of_fold_scores(fitted_pipeline, X, y, groups, weights.training_weights(groups, y), seed)
    slope, intercept = fit_sigmoid(oof, y, weights.person_weights(groups))
    return CalibratedModel(fitted_pipeline, slope, intercept)
