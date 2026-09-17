"""Phase 8 interpretability: permutation importance only, never SHAP (see
docs/ml-development-spec.md section 9d for why the locked SVM candidate's
hardcoded RBF kernel rules SHAP out for a fair cross-model comparison).

Computed per outer fold (Phase 4/5/6/7's exact same 5 folds) on Phase 6's
three surviving, Phase 7-calibrated candidates (XGBoost, Random Forest, SVM),
to produce `confound_reliance_share`: each candidate's share of total
permutation-importance drop attributable to `jitterLocal_sma3nz_stddevNorm` -
the one Phase-4-selected feature related to the Phase 1/3 channel-confound
triangle, tracked as a due-diligence relative of the confirmed shimmer
confound, not a confirmed confound itself (section 9d's correction - not
"shimmer/jitter"; shimmer was never selected into the 20 features).

Serves as Phase 8's tie-break for Phase 7's inconclusive calibrated-Brier
three-way comparison (section 9c): the surviving candidate whose
confound_reliance_share is significantly lower than both other candidates'
wins outright; if inconclusive, Phase 7's already-computed ECE breaks the tie
(lower wins); if that's also inconclusive, measured deployment cost is the
last resort, explicitly left for a documented decision when actually reached
rather than resolved by an unstated formula (section 9d).

Run via `scripts/run_interpretability.py`, not this module directly.
"""

from __future__ import annotations

import time
from io import BytesIO
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.inspection import permutation_importance

from acoustic_model.calibration import (
    CalibratedModel,
    _build_outer_folds,
    _load_locked_hyperparameters,
    _load_selected_features,
    _load_train_pool_features,
    determine_winner,
    final_calibration_lock_in,
    fit_calibrated_model,
    pairwise_metric_comparison,
)
from acoustic_model.config import (
    CALIBRATION_RESULTS_DIR,
    CONFOUND_FEATURE,
    INTERPRETABILITY_COMPARISON_FAMILY_SIZE,
    INTERPRETABILITY_PERMUTATION_N_REPEATS,
    INTERPRETABILITY_RESULTS_DIR,
    RANDOM_SEED,
)


class _CalibratedProbaAdapter(ClassifierMixin, BaseEstimator):
    """Thin adapter exposing sklearn's standard `predict_proba(X) -> (n, 2)`
    shape around `calibration.CalibratedModel` (which exposes
    `predict_proba_calibrated`, not `predict_proba`) - a mechanical
    requirement, not a design choice (section 9d): sklearn's built-in
    `"roc_auc"` scorer, used internally by `permutation_importance`, calls
    `estimator.predict_proba(X)` and needs `estimator.classes_` to pick the
    positive-class column.

    `ClassifierMixin` must come before `BaseEstimator` in the inheritance
    list - verified directly against the installed scikit-learn==1.9.1: with
    `BaseEstimator` first, `ClassifierMixin.__sklearn_tags__`'s
    `estimator_type="classifier"` override never actually runs (MRO resolves
    `__sklearn_tags__` to `BaseEstimator`'s own untagged version instead), so
    `sklearn.base.is_classifier()` silently returns False and the scorer skips
    positive-class column selection entirely, feeding `roc_auc_score` a raw
    (n, 2) array instead of a (n,) score column."""

    def __init__(self, calibrated_model: CalibratedModel):
        self.calibrated_model = calibrated_model
        self.classes_ = np.array([0, 1])

    def fit(self, x: pd.DataFrame, y: pd.Series | None = None) -> "_CalibratedProbaAdapter":
        # permutation_importance's own parameter validation requires a `fit`
        # method to exist (HasMethods(["fit"])) but never calls it - the
        # wrapped CalibratedModel is already fitted on this fold's training
        # portion by fit_calibrated_model().
        return self

    def predict_proba(self, x: pd.DataFrame) -> np.ndarray:
        p1 = self.calibrated_model.predict_proba_calibrated(x)
        return np.column_stack([1 - p1, p1])


def compute_fold_importances(
    df: pd.DataFrame,
    y: pd.Series,
    groups: pd.Series,
    selected_features: list[str],
    locked_hyperparameters: dict[str, dict],
    outer_folds: list[tuple[np.ndarray, np.ndarray]],
) -> pd.DataFrame:
    """For each outer fold, for each surviving candidate: fit + calibrate
    (`calibration.fit_calibrated_model()`, reused directly - not
    reimplemented) on the fold's training portion, then run
    `sklearn.inspection.permutation_importance` on that fold's **held-out**
    portion only, scored via the wrapped calibrated `predict_proba`'s
    `"roc_auc"` - rank-based, so unaffected by any candidate's calibration
    quality (calibration quality is not a confound in this specific
    comparison). `n_repeats=30`, seeded with `RANDOM_SEED` per this project's
    standing determinism rule. Returns one row per (fold, model, feature)."""
    rows: list[dict] = []
    for fold_index, (train_idx, val_idx) in enumerate(outer_folds):
        x_train = df.iloc[train_idx][selected_features]
        x_val = df.iloc[val_idx][selected_features]
        y_train = y.iloc[train_idx]
        y_val = y.iloc[val_idx]
        groups_train = groups.iloc[train_idx]

        for model_name, best_params in locked_hyperparameters.items():
            calibrated = fit_calibrated_model(model_name, best_params, x_train, y_train, groups_train)
            adapter = _CalibratedProbaAdapter(calibrated)
            result = permutation_importance(
                adapter,
                x_val,
                y_val,
                n_repeats=INTERPRETABILITY_PERMUTATION_N_REPEATS,
                random_state=RANDOM_SEED,
                scoring="roc_auc",
            )
            for feature, importance_drop in zip(selected_features, result.importances_mean):
                rows.append(
                    {
                        "fold": fold_index,
                        "model": model_name,
                        "feature": feature,
                        "importance_drop": float(importance_drop),
                    }
                )
    return pd.DataFrame(rows)


def compute_confound_reliance_share(fold_importances: pd.DataFrame) -> pd.DataFrame:
    """`confound_reliance_share = clipped-importance-drop(CONFOUND_FEATURE) /
    sum(clipped-importance-drop(all selected features))`, per (model, fold).
    Negative drops are clipped to 0 before summing, in both numerator and
    denominator (section 9d: permutation importance can be genuinely negative
    by chance; an unclipped or near-zero denominator makes the ratio
    ill-behaved). If every feature clips to 0 for a given (model, fold) - the
    denominator - the share is `NaN` via an explicit guarded division, never a
    bare `numerator/denominator`."""
    rows: list[dict] = []
    clipped = fold_importances.copy()
    clipped["clipped_drop"] = clipped["importance_drop"].clip(lower=0.0)

    for (fold, model), group in clipped.groupby(["fold", "model"]):
        denominator = float(group["clipped_drop"].sum())
        confound_rows = group[group["feature"] == CONFOUND_FEATURE]
        numerator = float(confound_rows["clipped_drop"].iloc[0])
        share = numerator / denominator if denominator > 0 else float("nan")
        rows.append(
            {
                "fold": fold,
                "model": model,
                "confound_importance_drop": numerator,
                "total_clipped_importance_drop": denominator,
                "confound_reliance_share": share,
            }
        )
    return pd.DataFrame(rows)


def aggregate_confound_reliance(fold_shares: pd.DataFrame) -> pd.DataFrame:
    """Mean/std of `confound_reliance_share` across folds, per model - `NaN`
    folds (the guarded-division edge case) are skipped by pandas' `mean`/`std`
    automatically; `n_folds_valid` reports how many folds actually contributed,
    so a reduced-n mean is visible, not silent. Sorted ascending - lower is
    what "leans least on the confound" means here."""
    agg = (
        fold_shares.groupby("model")["confound_reliance_share"]
        .agg(["mean", "std", "count"])
        .rename(
            columns={
                "mean": "confound_reliance_share_mean",
                "std": "confound_reliance_share_std",
                "count": "n_folds_valid",
            }
        )
        .reset_index()
        .sort_values("confound_reliance_share_mean", ascending=True)
        .reset_index(drop=True)
    )
    return agg


def _ece_tiebreak_winner(ece: pd.DataFrame, model_names: list[str]) -> str | None:
    """Section 9d's step 2: if the primary `confound_reliance_share` test
    (step 1) doesn't resolve, Phase 7's already-computed ECE breaks the tie -
    lower wins outright, not folded into a combined score. Returns None (falls
    through to step 3) only on an exact tie for the lowest ECE, which floating-
    point ECE values are not expected to produce in practice."""
    candidates = ece[ece["model"].isin(model_names)].sort_values("expected_calibration_error").reset_index(drop=True)
    if len(candidates) < 2:
        return None
    if candidates.loc[0, "expected_calibration_error"] == candidates.loc[1, "expected_calibration_error"]:
        return None
    return str(candidates.loc[0, "model"])


def measure_deployment_cost(final_models: dict[str, CalibratedModel], x_sample: pd.DataFrame) -> pd.DataFrame:
    """Section 9d's step-3 last resort, measured (not assumed): joblib-
    serialized artifact size, inference latency on a representative sample
    under identical conditions, and whether the model pulls in a dependency
    the pure-scikit-learn stack (Random Forest, SVM) doesn't (XGBoost's own
    `xgboost` package). Deliberately does not pick a winner from these numbers
    - section 9d sets no fixed priority order across the three axes and says
    this branch is "resolved... decided and documented explicitly at that
    time," not by a formula assumed in advance."""
    rows: list[dict] = []
    for model_name, calibrated in final_models.items():
        buffer = BytesIO()
        joblib.dump(calibrated, buffer)
        artifact_size_bytes = buffer.tell()

        start = time.perf_counter()
        calibrated.predict_proba_calibrated(x_sample)
        elapsed_seconds = time.perf_counter() - start

        rows.append(
            {
                "model": model_name,
                "artifact_size_bytes": artifact_size_bytes,
                "inference_latency_seconds_for_sample": elapsed_seconds,
                "n_sample": len(x_sample),
                "extra_container_dependency": model_name == "xgboost",
            }
        )
    return pd.DataFrame(rows)


def _write_summary(
    path: Path,
    df: pd.DataFrame,
    model_names: list[str],
    aggregated: pd.DataFrame,
    pairwise: pd.DataFrame,
    primary_winner: str | None,
    secondary_winner: str | None,
    ece: pd.DataFrame,
    deployment_cost: pd.DataFrame | None,
) -> None:
    lines: list[str] = []
    lines.append("# Phase 8 Interpretability Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_interpretability.py`.")
    lines.append(
        "Permutation importance only (not SHAP - see ml-development-spec.md section 9d), computed per outer "
        f"fold on Phase 6/7's {len(model_names)} surviving, calibrated candidates ({', '.join(model_names)}), "
        f"to produce `confound_reliance_share` for `{CONFOUND_FEATURE}` - the one Phase-4-selected feature "
        "related to the Phase 1/3 channel-confound triangle, tracked as a due-diligence relative, not a "
        "confirmed confound (section 9d's correction - not \"shimmer/jitter\")."
    )
    lines.append(f"train_pool: {df['subject_id'].nunique()} subjects, {len(df)} files.")
    lines.append("")

    lines.append("## confound_reliance_share (mean across valid folds, SD in parentheses)")
    lines.append("")
    lines.append(
        "Lower is better here: a lower share means the candidate leans less on this one feature relative to "
        "its total predictive signal. Sorted ascending."
    )
    lines.append("")
    for _, row in aggregated.iterrows():
        lines.append(
            f"- **{row['model']}**: {row['confound_reliance_share_mean']:.4f} "
            f"({row['confound_reliance_share_std']:.4f}), {int(row['n_folds_valid'])} valid folds"
        )
    lines.append("")

    lines.append(
        "## Pairwise confound_reliance_share comparison (paired t-test, Bonferroni-corrected across the 3 pairs)"
    )
    lines.append("")
    for _, row in pairwise.iterrows():
        sig = " **significant**" if row["significant_at_0.05"] else " not significant"
        dropped = f", dropped folds: {row['dropped_folds']}" if row["dropped_folds"] else ""
        lines.append(
            f"- {row['model_a']} vs {row['model_b']}: mean diff (a-b)={row['mean_diff_a_minus_b']:+.4f}, "
            f"t={row['t_stat']:+.3f}, p_raw={row['p_raw']:.4f}, p_bonferroni={row['p_bonferroni']:.4f} "
            f"({row['n_family']} comparisons, n_folds_used={row['n_folds_used']}{dropped}) -{sig}."
        )
    lines.append("")

    lines.append("## Decision chain (section 9d)")
    lines.append("")
    if primary_winner is not None:
        lines.append(
            f"**Step 1 resolves it: {primary_winner}** has a significantly lower `confound_reliance_share` "
            "than every other surviving candidate - this is the final model selection."
        )
    else:
        lines.append(
            "**Step 1 (primary) does not resolve it**: no candidate has a Bonferroni-corrected significantly "
            "lower `confound_reliance_share` than every other one."
        )
        lines.append("")
        lines.append("Expected Calibration Error (Phase 7, descriptive, lower wins as the step-2 tiebreaker):")
        for _, row in ece.iterrows():
            lines.append(f"  {row['model']}: ECE={row['expected_calibration_error']:.4f}")
        if secondary_winner is not None:
            lines.append("")
            lines.append(f"**Step 2 resolves it: {secondary_winner}** has the lowest ECE - this is the final model selection.")
        else:
            lines.append("")
            lines.append(
                "**Step 2 also does not resolve it** (an exact ECE tie). Step 3 (measured deployment cost) "
                "is reached - see the table below. Per section 9d, this branch has no fixed priority order "
                "across its three axes and is resolved by whichever axis shows the largest relative gap, "
                "**decided and documented explicitly at that time** - not by a formula assumed in advance. "
                "Left open here for that explicit decision."
            )
            if deployment_cost is not None:
                lines.append("")
                for _, row in deployment_cost.iterrows():
                    lines.append(
                        f"  {row['model']}: artifact={int(row['artifact_size_bytes'])} bytes, "
                        f"inference latency for {int(row['n_sample'])} files="
                        f"{row['inference_latency_seconds_for_sample']:.4f}s, "
                        f"extra container dependency={row['extra_container_dependency']}"
                    )
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def run() -> dict:
    INTERPRETABILITY_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    df = _load_train_pool_features()
    selected_features = _load_selected_features()
    locked_hyperparameters = _load_locked_hyperparameters()
    model_names = list(locked_hyperparameters.keys())
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    outer_folds = _build_outer_folds(df, y, groups)

    fold_importances = compute_fold_importances(
        df, y, groups, selected_features, locked_hyperparameters, outer_folds
    )
    fold_shares = compute_confound_reliance_share(fold_importances)
    aggregated = aggregate_confound_reliance(fold_shares)

    pairwise = pairwise_metric_comparison(
        fold_shares, model_names, "confound_reliance_share", INTERPRETABILITY_COMPARISON_FAMILY_SIZE
    )
    # determine_winner() is reused unchanged, not inverted: its "lower value on
    # this metric wins" arithmetic already matches what confound_reliance_share
    # needs (leans-least-on-the-confound wins) - the same direction as Phase
    # 7's lower-Brier-wins, despite section 9d's own "win direction is inverted
    # from Phase 7" phrasing. Verified by reasoning through both comparisons
    # directly rather than taken at face value; no inversion flag was needed.
    primary_winner = determine_winner(pairwise, model_names)

    ece_path = CALIBRATION_RESULTS_DIR / "calibration_ece.csv"
    if not ece_path.exists():
        raise FileNotFoundError(f"{ece_path} not found - run scripts/run_calibration.py first.")
    ece = pd.read_csv(ece_path)

    secondary_winner = None
    deployment_cost = None
    final_winner = primary_winner
    if final_winner is None:
        secondary_winner = _ece_tiebreak_winner(ece, model_names)
        final_winner = secondary_winner
    if final_winner is None:
        final_models = {
            model_name: final_calibration_lock_in(df, y, groups, selected_features, model_name, best_params)
            for model_name, best_params in locked_hyperparameters.items()
        }
        deployment_cost = measure_deployment_cost(final_models, df[selected_features])

    fold_importances.to_csv(INTERPRETABILITY_RESULTS_DIR / "fold_importances.csv", index=False)
    fold_shares.to_csv(INTERPRETABILITY_RESULTS_DIR / "confound_reliance_share.csv", index=False)
    aggregated.to_csv(INTERPRETABILITY_RESULTS_DIR / "aggregated_confound_reliance.csv", index=False)
    pairwise.to_csv(INTERPRETABILITY_RESULTS_DIR / "pairwise_confound_reliance_comparison.csv", index=False)
    if deployment_cost is not None:
        deployment_cost.to_csv(INTERPRETABILITY_RESULTS_DIR / "deployment_cost.csv", index=False)

    _write_summary(
        INTERPRETABILITY_RESULTS_DIR / "interpretability_summary.md",
        df=df,
        model_names=model_names,
        aggregated=aggregated,
        pairwise=pairwise,
        primary_winner=primary_winner,
        secondary_winner=secondary_winner,
        ece=ece,
        deployment_cost=deployment_cost,
    )

    return {
        "model_names": model_names,
        "primary_winner": primary_winner,
        "secondary_winner": secondary_winner,
        "final_winner": final_winner,
        "aggregated": aggregated.to_dict(orient="records"),
    }
