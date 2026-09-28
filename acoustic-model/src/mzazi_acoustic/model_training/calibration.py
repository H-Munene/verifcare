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
    """Platt scaling: an unpenalised 1-D logistic regression of the label on the score."""
    fit = LogisticRegression(C=np.inf).fit(np.asarray(scores).reshape(-1, 1), y, sample_weight=sample_weight)
    return float(fit.coef_[0, 0]), float(fit.intercept_[0])


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
