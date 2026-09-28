"""Nested, repeated, subject-grouped cross-validation (PLAN.md 4.2 steps 2-4).

For each (repeat, fold) in cv_folds.csv: train on the other folds of that repeat, validate on this
one. Per candidate, a default-settings baseline and a tuned model (inner 3-fold grouped search),
both calibrated, then scored on the validation clips. Every learned step (imputation, scaling,
the model, the sigmoid) sees only the training clips of that fold.
"""

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config
from mzazi_acoustic.model_training import calibration, candidates, metrics, weights


def fit_calibrated(name, variant, X, y, groups, seed):
    """Returns (CalibratedModel, tuning log rows). variant: 'baseline' (defaults) or 'tuned'."""
    X, y, groups = np.asarray(X, float), np.asarray(y), np.asarray(groups)
    train_weights = weights.training_weights(groups, y)
    log = []
    with candidates.routing():
        if variant == "baseline":
            pipeline = candidates.make_pipeline(name, seed).fit(X, y, sample_weight=train_weights)
        else:
            search = candidates.make_search(name, seed).fit(X, y, sample_weight=train_weights, groups=groups)
            pipeline = search.best_estimator_
            results = search.cv_results_
            for i, params in enumerate(results["params"]):
                log.append({"model": name, "config": i, "params": str(params),
                            "inner_roc_auc_person": results["mean_test_score"][i],
                            "rank": int(results["rank_test_score"][i])})
    return calibration.calibrate(pipeline, X, y, groups, seed), log


def run_fold(train, val, feature_cols, name, variant, seed):
    """Fit on `train` rows only, predict `val`. Returns (metrics row, prediction rows, log rows, model)."""
    model, log = fit_calibrated(name, variant, train[feature_cols], train["label"], train["subject_id"], seed)
    p = model.predict_proba(np.asarray(val[feature_cols], float))[:, 1]
    row = {"model": name, "variant": variant, **metrics.evaluate(val["label"], p, val["subject_id"])}
    predictions = val[["file_id", "subject_id", "label"]].assign(model=name, variant=variant, probability=p)
    return row, predictions, log, model


def run_cv(training, folds, feature_cols, models=config.CANDIDATES, trajectory=None, progress=print):
    """training: training-portion rows (file_id, subject_id, label, features). folds: cv_folds.csv.
    trajectory: optional rows of trajectory-only clips; each is scored by the tuned model of the fold
    where its person is validated, i.e. a model that never saw that person (PLAN.md 5.2 step 7).
    """
    fold_rows, prediction_rows, log_rows, trajectory_rows = [], [], [], []
    for (repeat, fold), val_ids in folds.groupby(["repeat", "fold"])["file_id"]:
        in_val = training["file_id"].isin(set(val_ids))
        train, val = training[~in_val], training[in_val]
        seed = config.SEED + 100 * repeat + fold
        for name in models:
            for variant in ("baseline", "tuned"):
                row, predictions, log, model = run_fold(train, val, feature_cols, name, variant, seed)
                context = {"repeat": repeat, "fold": fold}
                fold_rows.append({**context, **row, "n_train": len(train), "n_val": len(val)})
                prediction_rows.append(predictions.assign(**context))
                log_rows += [{**context, **entry} for entry in log]
                if variant == "tuned" and trajectory is not None:
                    mine = trajectory[trajectory["subject_id"].isin(set(val["subject_id"]))]
                    if len(mine):
                        p = model.predict_proba(np.asarray(mine[feature_cols], float))[:, 1]
                        trajectory_rows.append(mine[["file_id", "subject_id", "label"]].assign(
                            model=name, probability=p, **context))
            progress(f"  repeat {repeat} fold {fold}: {name} done")
    return {
        "fold_metrics": pd.DataFrame(fold_rows),
        "oof_predictions": pd.concat(prediction_rows, ignore_index=True),
        "tuning_log": pd.DataFrame(log_rows),
        "trajectory_predictions": pd.concat(trajectory_rows, ignore_index=True) if trajectory_rows else None,
    }
