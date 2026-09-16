"""Phase 5 baseline models: the four section-7 candidates (Logistic Regression,
Random Forest, SVM, XGBoost), trained on the fixed 20-feature subset Phase 4
selected, under the same subject-aware (StratifiedGroupKFold) CV shape used there -
see docs/ml-development-spec.md section 8b for the threshold policy this module
implements (Youden's J per fold as the primary threshold-dependent readout, plus
sensitivity at a fixed 90% specificity, both explicitly labeled provisional; ROC-AUC/
PR-AUC/Brier score as the threshold-free primary comparison; pooled out-of-fold
calibration curve and ECE).

This phase does not declare a winner among the four candidates - see section 8b.

Run via `scripts/run_baseline_models.py`, not this module directly.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import calibration_curve
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    average_precision_score,
    balanced_accuracy_score,
    brier_score_loss,
    f1_score,
    recall_score,
    roc_auc_score,
    roc_curve,
)
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from xgboost import XGBClassifier

from acoustic_model.config import (
    BASELINE_FIXED_SPECIFICITY_TARGET,
    BASELINE_MODEL_CV_FOLDS,
    BASELINE_MODELS_RESULTS_DIR,
    BASELINE_RF_N_ESTIMATORS,
    BASELINE_XGB_N_ESTIMATORS,
    CALIBRATION_N_BINS,
    FEATURE_SELECTION_RESULTS_DIR,
    FEATURES_RESULTS_DIR,
    RANDOM_SEED,
)

MODEL_NAMES = ("logistic_regression", "random_forest", "svm", "xgboost")

# Threshold-free metrics: Phase 5's primary comparison (section 8b).
_THRESHOLD_FREE_METRICS = ("roc_auc", "pr_auc", "brier_score")
# Threshold-dependent secondary metrics: Youden's-J-derived, plus the fixed-
# specificity readout - both explicitly labeled provisional in the summary output.
_THRESHOLD_DEPENDENT_METRICS = (
    "sensitivity_at_fixed_specificity",
    "sensitivity_youden",
    "specificity_youden",
    "f1_youden",
    "balanced_accuracy_youden",
)


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


def _build_folds(df: pd.DataFrame, y: pd.Series, groups: pd.Series) -> list[tuple[np.ndarray, np.ndarray]]:
    """Same n_splits/shuffle/random_state as feature_selection.py's own fold
    builder, applied to train_pool in the same row order - reproduces the identical
    fold assignments Phase 4 used (see config.BASELINE_MODEL_CV_FOLDS's docstring)."""
    splitter = StratifiedGroupKFold(n_splits=BASELINE_MODEL_CV_FOLDS, shuffle=True, random_state=RANDOM_SEED)
    return list(splitter.split(df, y, groups))


def _make_pipeline(model_name: str, scale_pos_weight: float) -> Pipeline:
    """StandardScaler applied uniformly ahead of all four models, fit train-fold-
    only inside the pipeline (never leaking validation-fold statistics into
    scaling). Required for Logistic Regression and the RBF-kernel SVM; a no-op in
    substance for the two tree-based models (monotonic per-feature scaling doesn't
    change their splits), so one pipeline shape is used for all four rather than
    branching."""
    if model_name == "logistic_regression":
        clf = LogisticRegression(class_weight="balanced", max_iter=5000, random_state=RANDOM_SEED)
    elif model_name == "random_forest":
        clf = RandomForestClassifier(
            n_estimators=BASELINE_RF_N_ESTIMATORS,
            class_weight="balanced",
            random_state=RANDOM_SEED,
            n_jobs=-1,
        )
    elif model_name == "svm":
        # probability=True is deprecated in scikit-learn 1.9 (removal targeted for
        # 1.11), in favor of CalibratedClassifierCV(SVC(), ensemble=False). Not
        # switched here: CalibratedClassifierCV's own internal cv defaults to plain
        # (non-subject-grouped) K-fold, which would split a subject's files across
        # its internal train/calibration halves - a real leakage risk this project
        # treats as non-negotiable, not a warning worth accepting to silence another
        # warning. Left as SVC(probability=True) - still fully functional on the
        # pinned scikit-learn==1.9.1 - and tracked here for whenever this actually
        # needs fixing (removal, or wiring a subject-grouped inner cv through
        # explicitly), not silently ignored.
        clf = SVC(kernel="rbf", probability=True, class_weight="balanced", random_state=RANDOM_SEED)
    elif model_name == "xgboost":
        clf = XGBClassifier(
            n_estimators=BASELINE_XGB_N_ESTIMATORS,
            scale_pos_weight=scale_pos_weight,
            eval_metric="logloss",
            random_state=RANDOM_SEED,
        )
    else:
        raise ValueError(f"Unknown model_name: {model_name!r}")
    return Pipeline([("scaler", StandardScaler()), ("clf", clf)])


def _youden_threshold_metrics(y_true: np.ndarray, y_score: np.ndarray) -> dict:
    """Picks the threshold maximizing sensitivity + specificity - 1 (Youden's J) on
    this same fold's held-out predictions, then scores that same fold at it - the
    "optimistic upper bound, not a fair fixed-threshold estimate" caveat in section
    8b applies to every value this returns."""
    fpr, tpr, thresholds = roc_curve(y_true, y_score)
    j_statistic = tpr - fpr
    best_idx = int(np.argmax(j_statistic))
    threshold = float(thresholds[best_idx])
    y_pred = (y_score >= threshold).astype(int)
    return {
        "youden_threshold": threshold,
        "sensitivity_youden": recall_score(y_true, y_pred, pos_label=1, zero_division=0),
        "specificity_youden": recall_score(y_true, y_pred, pos_label=0, zero_division=0),
        "f1_youden": f1_score(y_true, y_pred, zero_division=0),
        "balanced_accuracy_youden": balanced_accuracy_score(y_true, y_pred),
    }


def _sensitivity_at_fixed_specificity(y_true: np.ndarray, y_score: np.ndarray, target_specificity: float) -> float:
    """Reads the most sensitive point on this fold's ROC curve that still meets the
    target specificity - no threshold optimization, just a lookup. NaN if no point
    on the curve reaches the target (possible with a fold this small)."""
    fpr, tpr, _ = roc_curve(y_true, y_score)
    specificity = 1 - fpr
    eligible = specificity >= target_specificity
    if not eligible.any():
        return float("nan")
    return float(tpr[eligible].max())


def evaluate_folds(
    df: pd.DataFrame, y: pd.Series, groups: pd.Series, selected_features: list[str]
) -> tuple[pd.DataFrame, dict[str, pd.DataFrame]]:
    """Fits each of the four candidates per fold on that fold's training portion
    only (subject-grouped, per the CV splitter), scores on that fold's held-out
    validation portion. Returns per-(fold, model) metrics, plus each model's pooled
    out-of-fold (subject_id, y_true, y_prob) predictions across all five folds -
    used for the calibration curve/ECE, since every train_pool subject appears in
    exactly one fold's held-out set."""
    folds = _build_folds(df, y, groups)
    rows: list[dict] = []
    pooled: dict[str, list[tuple]] = {name: [] for name in MODEL_NAMES}

    for fold_index, (train_idx, val_idx) in enumerate(folds):
        x_train = df.iloc[train_idx][selected_features]
        x_val = df.iloc[val_idx][selected_features]
        y_train = y.iloc[train_idx]
        y_val = y.iloc[val_idx].to_numpy()
        subjects_val = df.iloc[val_idx]["subject_id"].to_numpy()

        n_pos = int((y_train == 1).sum())
        n_neg = int((y_train == 0).sum())
        scale_pos_weight = n_neg / n_pos

        for model_name in MODEL_NAMES:
            pipeline = _make_pipeline(model_name, scale_pos_weight)
            pipeline.fit(x_train, y_train)
            probs = pipeline.predict_proba(x_val)[:, 1]

            row = {
                "fold": fold_index,
                "model": model_name,
                "n_val": len(val_idx),
                "roc_auc": roc_auc_score(y_val, probs),
                "pr_auc": average_precision_score(y_val, probs),
                "brier_score": brier_score_loss(y_val, probs),
                "sensitivity_at_fixed_specificity": _sensitivity_at_fixed_specificity(
                    y_val, probs, BASELINE_FIXED_SPECIFICITY_TARGET
                ),
            }
            row.update(_youden_threshold_metrics(y_val, probs))
            rows.append(row)

            for subject_id, true_label, prob in zip(subjects_val, y_val, probs):
                pooled[model_name].append((fold_index, subject_id, int(true_label), float(prob)))

    fold_metrics = pd.DataFrame(rows)
    pooled_frames = {
        name: pd.DataFrame(records, columns=["fold", "subject_id", "y_true", "y_prob"])
        for name, records in pooled.items()
    }
    return fold_metrics, pooled_frames


def aggregate_metrics(fold_metrics: pd.DataFrame) -> pd.DataFrame:
    """Mean/std across the 5 folds, per model, for every metric - sorted by mean
    ROC-AUC descending for reporting convenience only, not a declared winner
    (section 8b)."""
    metric_cols = list(_THRESHOLD_FREE_METRICS) + list(_THRESHOLD_DEPENDENT_METRICS)
    agg = fold_metrics.groupby("model")[metric_cols].agg(["mean", "std"])
    agg.columns = [f"{col}_{stat}" for col, stat in agg.columns]
    agg = agg.reset_index().sort_values("roc_auc_mean", ascending=False).reset_index(drop=True)
    return agg


def pooled_calibration(pooled: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Pooled out-of-fold calibration curve (sklearn's calibration_curve) and
    Expected Calibration Error, one of each per model - see section 8b for why
    pooled rather than per-fold."""
    curve_rows: list[dict] = []
    ece_rows: list[dict] = []

    for model_name, preds in pooled.items():
        y_true = preds["y_true"].to_numpy()
        y_prob = preds["y_prob"].to_numpy()

        prob_true, prob_pred = calibration_curve(y_true, y_prob, n_bins=CALIBRATION_N_BINS, strategy="uniform")
        for bin_true, bin_pred in zip(prob_true, prob_pred):
            curve_rows.append(
                {"model": model_name, "mean_predicted_probability": bin_pred, "fraction_of_positives": bin_true}
            )

        bin_edges = np.linspace(0, 1, CALIBRATION_N_BINS + 1)
        bin_indices = np.digitize(y_prob, bin_edges[1:-1], right=True)
        ece = 0.0
        for bin_index in range(CALIBRATION_N_BINS):
            mask = bin_indices == bin_index
            if not mask.any():
                continue
            bin_confidence = y_prob[mask].mean()
            bin_accuracy = y_true[mask].mean()
            ece += (mask.sum() / len(y_prob)) * abs(bin_accuracy - bin_confidence)
        ece_rows.append(
            {"model": model_name, "expected_calibration_error": ece, "n_pooled_predictions": len(y_prob)}
        )

    return pd.DataFrame(curve_rows), pd.DataFrame(ece_rows)


def _write_summary(
    path: Path,
    df: pd.DataFrame,
    selected_features: list[str],
    aggregated: pd.DataFrame,
    ece: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("# Phase 5 Baseline Models Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_baseline_models.py`.")
    lines.append(
        "Four section-7 candidates (Logistic Regression, Random Forest, SVM, XGBoost), each trained on the "
        f"same fixed {len(selected_features)}-feature Phase 4 subset, under 5-fold subject-aware "
        "(StratifiedGroupKFold) CV over train_pool - the same fold shape Phase 4 used."
    )
    lines.append(f"train_pool: {df['subject_id'].nunique()} subjects, {len(df)} files.")
    lines.append("")

    lines.append("## Threshold-free comparison (primary): ROC-AUC / PR-AUC / Brier score")
    lines.append("")
    lines.append("Mean across 5 folds (std in parentheses). No threshold is involved in any of these three.")
    lines.append("")
    for _, row in aggregated.iterrows():
        lines.append(
            f"- **{row['model']}**: ROC-AUC={row['roc_auc_mean']:.4f} ({row['roc_auc_std']:.4f}), "
            f"PR-AUC={row['pr_auc_mean']:.4f} ({row['pr_auc_std']:.4f}), "
            f"Brier={row['brier_score_mean']:.4f} ({row['brier_score_std']:.4f})"
        )
    lines.append("")
    lines.append(
        "No winner is declared here - see ml-development-spec.md section 8b. Sorted by mean ROC-AUC "
        "descending for reporting convenience only."
    )
    lines.append("")

    lines.append("## Threshold-dependent secondary metrics (provisional - read this caveat first)")
    lines.append("")
    lines.append(
        "Per section 8b: each fold's Youden's-J threshold is chosen from that same fold's held-out "
        "predictions, then that same fold is scored at it. These numbers are an **optimistic upper bound** "
        "on what a single fixed threshold would achieve, not a fair estimate of one. ROC-AUC/PR-AUC/Brier "
        "above are not subject to this."
    )
    lines.append("")
    for _, row in aggregated.iterrows():
        lines.append(
            f"- **{row['model']}**: sensitivity(Youden)={row['sensitivity_youden_mean']:.4f} "
            f"({row['sensitivity_youden_std']:.4f}), specificity(Youden)={row['specificity_youden_mean']:.4f} "
            f"({row['specificity_youden_std']:.4f}), F1(Youden)={row['f1_youden_mean']:.4f} "
            f"({row['f1_youden_std']:.4f}), balanced accuracy(Youden)={row['balanced_accuracy_youden_mean']:.4f} "
            f"({row['balanced_accuracy_youden_std']:.4f})"
        )
    lines.append("")
    lines.append(
        f"## Sensitivity at fixed {int(BASELINE_FIXED_SPECIFICITY_TARGET * 100)}% specificity "
        "(secondary, screening-relevant operating region)"
    )
    lines.append("")
    lines.append(
        "Read directly off each fold's ROC curve - no threshold optimization, no additional circularity "
        "beyond Youden's J above. NaN means no point on that fold's ROC curve reached the target specificity."
    )
    lines.append("")
    for _, row in aggregated.iterrows():
        lines.append(
            f"- **{row['model']}**: {row['sensitivity_at_fixed_specificity_mean']:.4f} "
            f"({row['sensitivity_at_fixed_specificity_std']:.4f})"
        )
    lines.append("")
    lines.append(
        "This project has not settled whether the eventual locked threshold should prioritize sensitivity "
        "over precision (see section 8b) - this readout doesn't presuppose an answer, it's reported "
        "alongside Youden's J so that decision has more to work with when it's made."
    )
    lines.append("")

    lines.append("## Calibration (pooled out-of-fold predictions across all 5 folds)")
    lines.append("")
    lines.append("Expected Calibration Error (lower is better-calibrated):")
    for _, row in ece.iterrows():
        lines.append(
            f"  {row['model']}: ECE={row['expected_calibration_error']:.4f} "
            f"({int(row['n_pooled_predictions'])} pooled predictions)."
        )
    lines.append("")
    lines.append("Full reliability-diagram points (per-bin mean predicted probability vs. fraction of positives) "
                  "in `calibration_curve.csv`.")
    lines.append("")

    lines.append("## Selected feature subset used (unchanged from Phase 4)")
    lines.append("")
    lines.append(", ".join(selected_features))
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def run() -> dict:
    BASELINE_MODELS_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    df = _load_train_pool_features()
    selected_features = _load_selected_features()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    fold_metrics, pooled = evaluate_folds(df, y, groups, selected_features)
    aggregated = aggregate_metrics(fold_metrics)
    calibration_curve_df, ece_df = pooled_calibration(pooled)

    fold_metrics.to_csv(BASELINE_MODELS_RESULTS_DIR / "fold_metrics.csv", index=False)
    aggregated.to_csv(BASELINE_MODELS_RESULTS_DIR / "aggregated_metrics.csv", index=False)
    calibration_curve_df.to_csv(BASELINE_MODELS_RESULTS_DIR / "calibration_curve.csv", index=False)
    ece_df.to_csv(BASELINE_MODELS_RESULTS_DIR / "calibration_ece.csv", index=False)
    for model_name, preds in pooled.items():
        preds.to_csv(BASELINE_MODELS_RESULTS_DIR / f"pooled_predictions_{model_name}.csv", index=False)

    _write_summary(
        BASELINE_MODELS_RESULTS_DIR / "baseline_models_summary.md",
        df=df,
        selected_features=selected_features,
        aggregated=aggregated,
        ece=ece_df,
    )

    return {"aggregated": aggregated.to_dict(orient="records")}
