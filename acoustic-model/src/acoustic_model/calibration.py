"""Phase 7 calibration: sigmoid calibration applied uniformly to Phase 6's three
surviving candidates (XGBoost, Random Forest, SVM - Logistic Regression was
eliminated in Phase 6 Stage 1), on their Phase 6-locked hyperparameters - see
docs/ml-development-spec.md section 9c for the full settled methodology.

The originally-sketched fix for SVM's Phase 5 internal-CV leakage risk -
CalibratedClassifierCV(SVC(probability=False), cv=<subject-grouped>,
ensemble=False) via scikit-learn's metadata routing - was tried directly and does
not work in scikit-learn 1.9.1: its ensemble=False branch never forwards the
routed `groups` to its internal cross_val_predict call (traced to
CalibratedClassifierCV's own source; verified by reproducing the failure).
Calibration is built manually instead: cross_val_predict(..., groups=groups, ...)
(the older, non-routing mechanism, verified working) supplies genuinely
out-of-fold, subject-safe raw scores, and sklearn.calibration._SigmoidCalibration
(the same class CalibratedClassifierCV uses internally for method="sigmoid") is
fit directly on them - statistically identical to what ensemble=False was
supposed to do (fit the base estimator once on all data; fit one calibrator on
the pooled out-of-fold scores), verified by reading the rest of its source.

Applied to all three candidates uniformly, not just SVM, so any difference in
calibration quality reflects the base model, not the calibration mechanism.

Run via `scripts/run_calibration.py`, not this module directly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from itertools import combinations
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import ttest_1samp
from sklearn.calibration import _SigmoidCalibration
from sklearn.metrics import average_precision_score, brier_score_loss, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold, cross_val_predict

from acoustic_model.baseline_models import (
    _make_pipeline,
    _sensitivity_at_fixed_specificity,
    _youden_threshold_metrics,
    pooled_calibration,
)
from acoustic_model.config import (
    CALIBRATION_BRIER_COMPARISON_FAMILY_SIZE,
    CALIBRATION_INNER_CV_FOLDS,
    CALIBRATION_OUTER_CV_FOLDS,
    CALIBRATION_RESULTS_DIR,
    FEATURE_SELECTION_RESULTS_DIR,
    FEATURES_RESULTS_DIR,
    RANDOM_SEED,
    TUNING_RESULTS_DIR,
)

# Which raw-score method each candidate's fitted pipeline actually exposes -
# predict_proba for the two tree-based models, decision_function for SVM
# (built with svm_probability=False throughout, same as Phase 6).
_RAW_SCORE_METHOD = {
    "xgboost": "predict_proba",
    "random_forest": "predict_proba",
    "svm": "decision_function",
}

# Fixed 90% specificity operating point for the descriptive threshold readout,
# matching Phase 5's BASELINE_FIXED_SPECIFICITY_TARGET exactly (not re-decided).
_FIXED_SPECIFICITY_TARGET = 0.90


@dataclass
class CalibratedModel:
    model_name: str
    pipeline: object
    calibrator: _SigmoidCalibration

    def raw_scores(self, x: pd.DataFrame) -> np.ndarray:
        method = _RAW_SCORE_METHOD[self.model_name]
        if method == "predict_proba":
            return self.pipeline.predict_proba(x)[:, 1]
        return self.pipeline.decision_function(x)

    def predict_proba_calibrated(self, x: pd.DataFrame) -> np.ndarray:
        return self.calibrator.predict(self.raw_scores(x))


def _load_train_pool_features() -> pd.DataFrame:
    path = FEATURES_RESULTS_DIR / "feature_matrix.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_features.py first.")
    df = pd.read_csv(path)
    return df[df["split"] == "train_pool"].reset_index(drop=True)


def _load_selected_features() -> list[str]:
    path = FEATURE_SELECTION_RESULTS_DIR / "selected_features.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_feature_selection.py first.")
    return pd.read_csv(path)["feature"].tolist()


def _load_locked_hyperparameters() -> dict[str, dict]:
    """Phase 6's surviving candidates and their final-lock-in hyperparameters -
    read from the committed CSV, not hardcoded, so this module always reflects
    whatever Phase 6 actually produced."""
    path = TUNING_RESULTS_DIR / "final_lock_in.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_hyperparameter_tuning.py first.")
    df = pd.read_csv(path)
    return {row["model"]: json.loads(row["best_params"]) for _, row in df.iterrows()}


def _compute_scale_pos_weight(y: pd.Series) -> float:
    n_pos = int((y == 1).sum())
    n_neg = int((y == 0).sum())
    return n_neg / n_pos


def _build_outer_folds(df: pd.DataFrame, y: pd.Series, groups: pd.Series) -> list[tuple[np.ndarray, np.ndarray]]:
    """Identical n_splits/shuffle/random_state to Phase 4/5/6's own fold
    builders, applied to train_pool in the same row order - reproduces the same
    fold assignments (verified in tests, not just asserted)."""
    splitter = StratifiedGroupKFold(n_splits=CALIBRATION_OUTER_CV_FOLDS, shuffle=True, random_state=RANDOM_SEED)
    return list(splitter.split(df, y, groups))


def fit_calibrated_model(
    model_name: str,
    best_params: dict,
    x: pd.DataFrame,
    y: pd.Series,
    groups: pd.Series,
    inner_cv_folds: int = CALIBRATION_INNER_CV_FOLDS,
) -> CalibratedModel:
    """The manual calibration procedure (see module docstring): cross_val_predict
    with a subject-grouped inner CV supplies genuinely out-of-fold raw scores; a
    _SigmoidCalibration is fit on those scores; the base pipeline is separately
    refit on the *entire* x/y passed in - matching exactly what
    CalibratedClassifierCV(ensemble=False) does internally (verified against its
    source), just via APIs that actually respect subject grouping."""
    scale_pos_weight = _compute_scale_pos_weight(y)
    base_pipeline = _make_pipeline(model_name, scale_pos_weight, svm_probability=False)
    base_pipeline.set_params(**best_params)

    inner_cv = StratifiedGroupKFold(n_splits=inner_cv_folds, shuffle=True, random_state=RANDOM_SEED)
    method = _RAW_SCORE_METHOD[model_name]
    oof_raw = cross_val_predict(base_pipeline, x, y, groups=groups, cv=inner_cv, method=method, n_jobs=-1)
    if method == "predict_proba":
        oof_raw = oof_raw[:, 1]

    calibrator = _SigmoidCalibration().fit(oof_raw, y)

    fitted_pipeline = _make_pipeline(model_name, scale_pos_weight, svm_probability=False)
    fitted_pipeline.set_params(**best_params)
    fitted_pipeline.fit(x, y)

    return CalibratedModel(model_name=model_name, pipeline=fitted_pipeline, calibrator=calibrator)


def evaluate_folds(
    df: pd.DataFrame,
    y: pd.Series,
    groups: pd.Series,
    selected_features: list[str],
    locked_hyperparameters: dict[str, dict],
    outer_folds: list[tuple[np.ndarray, np.ndarray]],
) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    """For each outer fold, for each surviving candidate: fit the calibrated
    model on the outer-training portion (subject-grouped internally), score on
    the outer held-out portion. Also asserts, per fold/model, that calibrated
    ROC-AUC equals raw-score ROC-AUC on that same held-out data - calibration is
    a monotonic transform and cannot change ranking; a real, checked invariant,
    not just a claim (see section 9c for why this replaced an earlier, wrong
    cross-phase invariant claim)."""
    rows: list[dict] = []
    pooled: dict[str, list[tuple]] = {name: [] for name in locked_hyperparameters}

    for fold_index, (train_idx, val_idx) in enumerate(outer_folds):
        x_train = df.iloc[train_idx][selected_features]
        x_val = df.iloc[val_idx][selected_features]
        y_train = y.iloc[train_idx]
        y_val = y.iloc[val_idx].to_numpy()
        groups_train = groups.iloc[train_idx]
        subjects_val = df.iloc[val_idx]["subject_id"].to_numpy()

        for model_name, best_params in locked_hyperparameters.items():
            calibrated = fit_calibrated_model(model_name, best_params, x_train, y_train, groups_train)
            calibrated_probs = calibrated.predict_proba_calibrated(x_val)

            raw_scores = calibrated.raw_scores(x_val)
            calibrated_auc = roc_auc_score(y_val, calibrated_probs)
            raw_auc = roc_auc_score(y_val, raw_scores)
            assert np.isclose(calibrated_auc, raw_auc, atol=1e-9), (
                f"Calibration changed ranking for {model_name} fold {fold_index}: "
                f"calibrated AUC={calibrated_auc}, raw AUC={raw_auc} - calibration must be monotonic."
            )

            rows.append(
                {
                    "fold": fold_index,
                    "model": model_name,
                    "roc_auc": calibrated_auc,
                    "pr_auc": average_precision_score(y_val, calibrated_probs),
                    "brier_score": brier_score_loss(y_val, calibrated_probs),
                }
            )
            for subject_id, true_label, prob in zip(subjects_val, y_val, calibrated_probs):
                pooled[model_name].append((fold_index, subject_id, int(true_label), float(prob)))

    fold_metrics = pd.DataFrame(rows)
    pooled_frames = {
        name: pd.DataFrame(records, columns=["fold", "subject_id", "y_true", "y_prob"])
        for name, records in pooled.items()
    }
    return fold_metrics, pooled_frames


def aggregate_metrics(fold_metrics: pd.DataFrame) -> pd.DataFrame:
    metric_cols = ["roc_auc", "pr_auc", "brier_score"]
    agg = fold_metrics.groupby("model")[metric_cols].agg(["mean", "std"])
    agg.columns = [f"{col}_{stat}" for col, stat in agg.columns]
    agg = agg.reset_index().sort_values("brier_score_mean", ascending=True).reset_index(drop=True)
    return agg


def pairwise_brier_comparison(fold_metrics: pd.DataFrame, model_names: list[str]) -> pd.DataFrame:
    """Paired t-test (per outer fold, same folds for every model) on Brier score
    for each of the 3 pairwise comparisons, Bonferroni-corrected across that
    family of 3 - flat/naive, matching the convention already used in Phases 1
    and 3 (never Holm-Bonferroni), not a fresh choice."""
    rows: list[dict] = []
    pairs = list(combinations(sorted(model_names), 2))
    family_size = max(len(pairs), CALIBRATION_BRIER_COMPARISON_FAMILY_SIZE)
    for model_a, model_b in pairs:
        a = fold_metrics[fold_metrics["model"] == model_a].sort_values("fold")["brier_score"].to_numpy()
        b = fold_metrics[fold_metrics["model"] == model_b].sort_values("fold")["brier_score"].to_numpy()
        diffs = a - b  # negative: model_a has the lower (better) Brier score
        t_stat, p_raw = ttest_1samp(diffs, 0.0)
        p_bonferroni = min(float(p_raw) * family_size, 1.0)
        rows.append(
            {
                "model_a": model_a,
                "model_b": model_b,
                "mean_diff_a_minus_b": float(diffs.mean()),
                "t_stat": float(t_stat),
                "p_raw": float(p_raw),
                "p_bonferroni": p_bonferroni,
                "n_family": family_size,
                "significant_at_0.05": p_bonferroni < 0.05,
            }
        )
    return pd.DataFrame(rows)


def determine_winner(pairwise: pd.DataFrame, model_names: list[str]) -> str | None:
    """A model wins only if it has a significantly lower (Bonferroni-corrected)
    Brier score than *every* other surviving candidate - not the lowest point
    estimate. Returns None (no forced winner) otherwise, matching Phase 5/6's own
    precedent - the likely outcome, planned for, not a fallback surprise (Phase
    6's own real effect didn't clear significance at this same n=5 folds)."""
    for candidate in model_names:
        beats_all_others = True
        for _, row in pairwise.iterrows():
            if row["model_a"] == candidate:
                beats = row["mean_diff_a_minus_b"] < 0 and row["significant_at_0.05"]
            elif row["model_b"] == candidate:
                beats = row["mean_diff_a_minus_b"] > 0 and row["significant_at_0.05"]
            else:
                continue
            if not beats:
                beats_all_others = False
                break
        if beats_all_others:
            return candidate
    return None


def descriptive_threshold_analysis(pooled: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Youden's J and sensitivity-at-fixed-specificity on each candidate's
    pooled out-of-fold calibrated predictions - descriptive only, matching Phase
    5's own "optimistic upper bound, not the final clinical threshold" precedent
    (section 8b): the threshold is still chosen and evaluated on the same pooled
    data. Not locked anywhere - real threshold-locking belongs at Phase 10
    (section 9c)."""
    rows: list[dict] = []
    for model_name, preds in pooled.items():
        y_true = preds["y_true"].to_numpy()
        y_prob = preds["y_prob"].to_numpy()
        row = {"model": model_name}
        row.update(_youden_threshold_metrics(y_true, y_prob))
        row["sensitivity_at_fixed_specificity"] = _sensitivity_at_fixed_specificity(
            y_true, y_prob, _FIXED_SPECIFICITY_TARGET
        )
        rows.append(row)
    return pd.DataFrame(rows)


def final_calibration_lock_in(
    df: pd.DataFrame,
    y: pd.Series,
    groups: pd.Series,
    selected_features: list[str],
    model_name: str,
    best_params: dict,
) -> CalibratedModel:
    """Mirrors Phase 4/6's final-refit rule: one more calibration fit on the
    full train_pool, no outer holdout - the honest performance estimate already
    came from evaluate_folds() above. Still subject-grouped internally (section
    3's rule applies to every fit, not only reported ones)."""
    x_full = df[selected_features]
    return fit_calibrated_model(model_name, best_params, x_full, y, groups)


def run() -> dict:
    CALIBRATION_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    df = _load_train_pool_features()
    selected_features = _load_selected_features()
    locked_hyperparameters = _load_locked_hyperparameters()
    model_names = list(locked_hyperparameters.keys())
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    outer_folds = _build_outer_folds(df, y, groups)

    fold_metrics, pooled = evaluate_folds(df, y, groups, selected_features, locked_hyperparameters, outer_folds)
    aggregated = aggregate_metrics(fold_metrics)
    pairwise = pairwise_brier_comparison(fold_metrics, model_names)
    winner = determine_winner(pairwise, model_names)
    threshold_analysis = descriptive_threshold_analysis(pooled)
    calibration_curve_df, ece_df = pooled_calibration(pooled)

    final_models = {
        model_name: final_calibration_lock_in(df, y, groups, selected_features, model_name, best_params)
        for model_name, best_params in locked_hyperparameters.items()
    }

    fold_metrics.to_csv(CALIBRATION_RESULTS_DIR / "fold_metrics.csv", index=False)
    aggregated.to_csv(CALIBRATION_RESULTS_DIR / "aggregated_metrics.csv", index=False)
    pairwise.to_csv(CALIBRATION_RESULTS_DIR / "pairwise_brier_comparison.csv", index=False)
    threshold_analysis.to_csv(CALIBRATION_RESULTS_DIR / "descriptive_threshold_analysis.csv", index=False)
    calibration_curve_df.to_csv(CALIBRATION_RESULTS_DIR / "calibration_curve.csv", index=False)
    ece_df.to_csv(CALIBRATION_RESULTS_DIR / "calibration_ece.csv", index=False)
    for model_name, preds in pooled.items():
        preds.to_csv(CALIBRATION_RESULTS_DIR / f"pooled_predictions_{model_name}.csv", index=False)

    _write_summary(
        CALIBRATION_RESULTS_DIR / "calibration_summary.md",
        df=df,
        model_names=model_names,
        aggregated=aggregated,
        pairwise=pairwise,
        winner=winner,
        threshold_analysis=threshold_analysis,
        ece=ece_df,
    )

    return {
        "model_names": model_names,
        "winner": winner,
        "aggregated": aggregated.to_dict(orient="records"),
    }


def _write_summary(
    path: Path,
    df: pd.DataFrame,
    model_names: list[str],
    aggregated: pd.DataFrame,
    pairwise: pd.DataFrame,
    winner: str | None,
    threshold_analysis: pd.DataFrame,
    ece: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("# Phase 7 Calibration Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_calibration.py`.")
    lines.append(
        f"Sigmoid calibration applied uniformly to Phase 6's {len(model_names)} surviving candidates "
        f"({', '.join(model_names)}), on their Phase 6-locked hyperparameters, under 5-fold subject-aware "
        "(StratifiedGroupKFold) outer CV - the same folds Phase 4/5/6 used."
    )
    lines.append(f"train_pool: {df['subject_id'].nunique()} subjects, {len(df)} files.")
    lines.append("")

    lines.append("## Calibrated performance (mean across 5 outer folds, SD in parentheses)")
    lines.append("")
    lines.append(
        "Sorted by mean Brier score ascending (lower is better-calibrated) - the primary criterion for "
        "this phase, per ml-development-spec.md section 9c."
    )
    lines.append("")
    for _, row in aggregated.iterrows():
        lines.append(
            f"- **{row['model']}**: Brier={row['brier_score_mean']:.4f} ({row['brier_score_std']:.4f}), "
            f"ROC-AUC={row['roc_auc_mean']:.4f} ({row['roc_auc_std']:.4f}), "
            f"PR-AUC={row['pr_auc_mean']:.4f} ({row['pr_auc_std']:.4f})"
        )
    lines.append("")

    lines.append("## Pairwise Brier comparison (paired t-test, Bonferroni-corrected across the 3 pairs)")
    lines.append("")
    for _, row in pairwise.iterrows():
        sig = " **significant**" if row["significant_at_0.05"] else " not significant"
        lines.append(
            f"- {row['model_a']} vs {row['model_b']}: mean diff (a-b)={row['mean_diff_a_minus_b']:+.4f}, "
            f"t={row['t_stat']:+.3f}, p_raw={row['p_raw']:.4f}, "
            f"p_bonferroni={row['p_bonferroni']:.4f} ({row['n_family']} comparisons) -{sig}."
        )
    lines.append("")
    if winner is not None:
        lines.append(f"**{winner}** has a significantly lower Brier score than every other surviving candidate.")
    else:
        lines.append(
            "**No significant winner.** No candidate has a Bonferroni-corrected significantly lower Brier "
            "score than every other one. Planned for as the likely outcome, not a fallback surprise - "
            "Phase 6's own real effect (XGBoost's tuning improvement) didn't clear significance at this "
            "same n=5 folds, so a Brier difference among three already-ROC-AUC-tied models clearing "
            "significance isn't the base-rate expectation here. Per section 9c: defer to Phase 8's tie-break "
            "(prefer whichever candidate leans least on the channel-confounded shimmer/jitter features), "
            "then a last-resort simpler-model rule if that doesn't resolve it either."
        )
    lines.append("")

    lines.append("## Calibration quality (pooled out-of-fold predictions, ECE)")
    lines.append("")
    for _, row in ece.iterrows():
        lines.append(
            f"  {row['model']}: ECE={row['expected_calibration_error']:.4f} "
            f"({int(row['n_pooled_predictions'])} pooled predictions)."
        )
    lines.append(
        "Reported descriptively, not fed into the pairwise significance test above - a binned statistic "
        "isn't naturally decomposable into 5 per-fold values the way Brier is (same reasoning as Phase 5's "
        "own pooled-ECE design)."
    )
    lines.append("")

    lines.append(
        "## Descriptive threshold analysis (NOT locked - real threshold-locking belongs at Phase 10, section 9c)"
    )
    lines.append("")
    lines.append(
        "Youden's J and sensitivity-at-90%-specificity on each candidate's pooled out-of-fold calibrated "
        "predictions - an \"optimistic upper bound,\" not a fair fixed-threshold estimate, same caveat as "
        "Phase 5's own per-fold Youden's J (section 8b): the threshold is chosen and evaluated on the same "
        "pooled data. A head start for Phase 10, not a commitment."
    )
    lines.append("")
    for _, row in threshold_analysis.iterrows():
        lines.append(
            f"- **{row['model']}**: Youden threshold={row['youden_threshold']:.4f}, "
            f"sensitivity={row['sensitivity_youden']:.4f}, specificity={row['specificity_youden']:.4f}, "
            f"sensitivity@90%-specificity={row['sensitivity_at_fixed_specificity']:.4f}"
        )
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")
