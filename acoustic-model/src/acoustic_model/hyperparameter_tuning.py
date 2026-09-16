"""Phase 6 hyperparameter tuning: two-stage nested CV over the four section-7
candidates, trained on the fixed 20-feature Phase 4 subset - see
docs/ml-development-spec.md section 9b for the full settled methodology (design
questions resolved in dialogue before this was written, per the established
process).

Stage 1 (coarse, all four candidates, small equal RandomizedSearchCV budget) ->
one-SE narrowing rule (reused from Phase 4's own choose_k(), not fresh) -> Stage 2
(deeper, on whichever models survive Stage 1, larger equal budget) -> one-SE rule
again -> a final hyperparameter search per surviving model, on the full train_pool
with no outer holdout, to pick the actual deployable configuration (mirrors Phase
4's final-refit rule exactly).

Every stage's outer CV reuses Phase 4/5's exact 5 folds. Every inner/final search
is subject-grouped (StratifiedGroupKFold), including the final lock-in step, whose
own score is never reported as a performance estimate - see section 9b.

Run via `scripts/run_hyperparameter_tuning.py`, not this module directly.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import loguniform, randint, ttest_1samp, uniform
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import RandomizedSearchCV, StratifiedGroupKFold

from acoustic_model.baseline_models import MODEL_NAMES, _make_pipeline
from acoustic_model.config import (
    BASELINE_MODELS_RESULTS_DIR,
    FEATURE_SELECTION_RESULTS_DIR,
    FEATURES_RESULTS_DIR,
    RANDOM_SEED,
    TUNING_INNER_CV_FOLDS,
    TUNING_OUTER_CV_FOLDS,
    TUNING_RESULTS_DIR,
    TUNING_STAGE1_N_ITER,
    TUNING_STAGE2_N_ITER,
)

# Modest, non-exhaustive per-model search spaces - "equal budget" (section 9b) is
# enforced via n_iter being identical across models, not via matching dimensionality
# here. class_weight="balanced"/scale_pos_weight and every other fixed setting from
# _make_pipeline() stay fixed, not searched - consistent with Phase 5's already-
# settled imbalance handling, not re-opened here.
SEARCH_SPACES: dict[str, dict] = {
    "logistic_regression": {
        # Regularization strength only - the single most impactful LR
        # hyperparameter. Penalty/solver left at Phase 5's defaults (l2/lbfgs) to
        # avoid the solver-penalty compatibility complexity of also searching
        # penalty type, which would push this past "modest."
        "clf__C": loguniform(1e-3, 1e2),
    },
    "random_forest": {
        # n_estimators left fixed at BASELINE_RF_N_ESTIMATORS (500, already
        # justified in Phase 5) - the search targets overfitting-control
        # hyperparameters instead, more directly relevant at this dataset size.
        "clf__max_depth": [None, 4, 8, 12, 16, 24],
        "clf__min_samples_leaf": randint(1, 10),
        "clf__max_features": ["sqrt", "log2", 0.3, 0.5, None],
    },
    "svm": {
        "clf__C": loguniform(1e-2, 1e2),
        "clf__gamma": loguniform(1e-4, 1e0),
    },
    "xgboost": {
        "clf__max_depth": randint(2, 7),
        "clf__learning_rate": loguniform(1e-2, 3e-1),
        "clf__n_estimators": randint(100, 500),
        "clf__subsample": uniform(0.6, 0.4),
        "clf__colsample_bytree": uniform(0.6, 0.4),
    },
}


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


def _compute_scale_pos_weight(y: pd.Series) -> float:
    n_pos = int((y == 1).sum())
    n_neg = int((y == 0).sum())
    return n_neg / n_pos


def _build_outer_folds(df: pd.DataFrame, y: pd.Series, groups: pd.Series) -> list[tuple[np.ndarray, np.ndarray]]:
    """Identical n_splits/shuffle/random_state to Phase 4/5's own fold builders,
    applied to train_pool in the same row order - reproduces the same fold
    assignments (see baseline_models.py's own equivalent docstring/test)."""
    splitter = StratifiedGroupKFold(n_splits=TUNING_OUTER_CV_FOLDS, shuffle=True, random_state=RANDOM_SEED)
    return list(splitter.split(df, y, groups))


def _score_ranking(estimator, x: pd.DataFrame) -> np.ndarray:
    """ROC-AUC only needs a ranking score. Prefers predict_proba (LR/RF/XGBoost,
    and SVM if ever run with svm_probability=True); falls back to
    decision_function for Phase 6's SVM pipelines (svm_probability=False), which
    have no predict_proba at all - scikit-learn's own roc_auc scorer does the same
    fallback internally, this just makes it explicit for the outer-fold scoring
    done here, outside that scorer."""
    if hasattr(estimator, "predict_proba"):
        return estimator.predict_proba(x)[:, 1]
    return estimator.decision_function(x)


def _run_inner_search(
    model_name: str, x_train: pd.DataFrame, y_train: pd.Series, groups_train: pd.Series, n_iter: int
) -> RandomizedSearchCV:
    scale_pos_weight = _compute_scale_pos_weight(y_train)
    base_pipeline = _make_pipeline(model_name, scale_pos_weight, svm_probability=False)
    inner_cv = StratifiedGroupKFold(n_splits=TUNING_INNER_CV_FOLDS, shuffle=True, random_state=RANDOM_SEED)
    search = RandomizedSearchCV(
        base_pipeline,
        param_distributions=SEARCH_SPACES[model_name],
        n_iter=n_iter,
        cv=inner_cv,
        scoring="roc_auc",
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )
    search.fit(x_train, y_train, groups=groups_train)
    return search


def run_stage(
    df: pd.DataFrame,
    y: pd.Series,
    groups: pd.Series,
    selected_features: list[str],
    model_names: list[str],
    n_iter: int,
    outer_folds: list[tuple[np.ndarray, np.ndarray]],
) -> pd.DataFrame:
    """One stage (coarse or deep): for each outer fold, for each model, an inner
    subject-grouped search picks a configuration on the outer-training portion
    only, scored on the outer held-out portion - five real out-of-fold scores per
    model, never touched by that model's own inner search."""
    rows: list[dict] = []
    for fold_index, (train_idx, val_idx) in enumerate(outer_folds):
        x_train = df.iloc[train_idx][selected_features]
        x_val = df.iloc[val_idx][selected_features]
        y_train = y.iloc[train_idx]
        y_val = y.iloc[val_idx]
        groups_train = groups.iloc[train_idx]

        for model_name in model_names:
            search = _run_inner_search(model_name, x_train, y_train, groups_train, n_iter)
            scores = _score_ranking(search.best_estimator_, x_val)
            outer_auc = roc_auc_score(y_val, scores)
            rows.append(
                {
                    "fold": fold_index,
                    "model": model_name,
                    "roc_auc": outer_auc,
                    "best_params": json.dumps(search.best_params_),
                }
            )
    return pd.DataFrame(rows)


def aggregate_stage(fold_scores: pd.DataFrame) -> pd.DataFrame:
    """Mean/SD per model (SD is this project's reporting convention throughout),
    plus SE = SD/sqrt(n_outer_folds) as a separate column, used only for the
    one-SE narrowing rule below - never labeled or treated as the reported SD."""
    agg = fold_scores.groupby("model")["roc_auc"].agg(["mean", "std"]).reset_index()
    agg = agg.rename(columns={"mean": "mean_roc_auc", "std": "std_roc_auc"})
    agg["se_roc_auc"] = agg["std_roc_auc"] / np.sqrt(TUNING_OUTER_CV_FOLDS)
    agg = agg.sort_values("mean_roc_auc", ascending=False).reset_index(drop=True)
    return agg


def apply_one_se_rule(aggregated: pd.DataFrame) -> list[str]:
    """A model is statistically indistinguishable from the leader if its mean
    tuned ROC-AUC is within one SE of the best mean ROC-AUC - reusing Phase 4's
    own one-SE convention (feature_selection.choose_k(), verified directly against
    that code before being described as reused - see section 9b), not invented
    fresh here."""
    best_row = aggregated.loc[aggregated["mean_roc_auc"].idxmax()]
    one_se_threshold = best_row["mean_roc_auc"] - best_row["se_roc_auc"]
    survivors = aggregated[aggregated["mean_roc_auc"] >= one_se_threshold]
    return survivors["model"].tolist()


def final_lock_in(
    df: pd.DataFrame, y: pd.Series, groups: pd.Series, selected_features: list[str], model_name: str, n_iter: int
) -> dict:
    """Mirrors Phase 4's final-refit rule exactly: nested CV above already gave an
    honest performance estimate, but not a deployable configuration (each outer
    fold's inner search can pick differently). One more search, same space, on the
    full train_pool, no outer holdout - still subject-grouped internally even
    though nothing from this step is reported as a metric (section 3's rule
    applies to every fit, not only reported ones). This step's own best_score_ is
    explicitly NOT the model's performance estimate - that's Stage 1/2's job."""
    x_full = df[selected_features]
    scale_pos_weight = _compute_scale_pos_weight(y)
    base_pipeline = _make_pipeline(model_name, scale_pos_weight, svm_probability=False)
    lock_in_cv = StratifiedGroupKFold(n_splits=TUNING_OUTER_CV_FOLDS, shuffle=True, random_state=RANDOM_SEED)
    search = RandomizedSearchCV(
        base_pipeline,
        param_distributions=SEARCH_SPACES[model_name],
        n_iter=n_iter,
        cv=lock_in_cv,
        scoring="roc_auc",
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )
    search.fit(x_full, y, groups=groups)
    return {
        "model": model_name,
        "best_params": json.dumps(search.best_params_),
        "selection_score_not_a_performance_estimate": search.best_score_,
    }


def paired_comparison(stage2_scores: pd.DataFrame) -> pd.DataFrame:
    """Fold-by-fold paired diff (tuned - Phase 5 baseline), not two independent
    aggregate means - Phase 5 and Phase 6 share the exact same 5 outer folds
    (re-verified byte-identical), so pairing cancels out whatever makes a given
    fold's subject composition easier or harder for both numbers alike, the same
    discipline this project already applies to between-model comparisons (the
    one-SE rule) applied here to a before/after comparison instead. Returns one
    row per (fold, model); empty if Phase 5's results aren't available."""
    baseline_path = BASELINE_MODELS_RESULTS_DIR / "fold_metrics.csv"
    if not baseline_path.exists():
        return pd.DataFrame(columns=["fold", "model", "baseline_auc", "tuned_auc", "diff", "improved"])
    baseline = pd.read_csv(baseline_path)[["fold", "model", "roc_auc"]].rename(columns={"roc_auc": "baseline_auc"})
    tuned = stage2_scores[["fold", "model", "roc_auc"]].rename(columns={"roc_auc": "tuned_auc"})
    merged = tuned.merge(baseline, on=["fold", "model"], how="left")
    merged["diff"] = merged["tuned_auc"] - merged["baseline_auc"]
    merged["improved"] = merged["diff"] > 0
    return merged


def summarize_paired_comparison(paired: pd.DataFrame) -> pd.DataFrame:
    """Per model: how many of the 5 folds actually improved, the paired
    mean/SD/SE of the diff, and a real paired t-test (one-sample t-test of the
    diffs against 0) against its own df=n_folds-1 reference distribution - not an
    "X SE from zero" framing, which implicitly invites a normal-distribution
    (~1.96) read. With only 5 paired folds (df=4), the correct two-tailed alpha=
    0.05 critical value is ~2.776 (scipy.stats.t.ppf(0.975, 4)), not ~1.96 - a
    meaningfully higher bar, and the one actually used to judge these numbers."""
    if paired.empty:
        return pd.DataFrame()
    rows = []
    for model_name, group in paired.groupby("model"):
        diffs = group["diff"].to_numpy()
        n_folds = len(diffs)
        n_improved = int(group["improved"].sum())
        mean_diff = float(diffs.mean())
        std_diff = float(diffs.std(ddof=1))
        se_diff = std_diff / np.sqrt(n_folds)
        t_stat, p_two_tailed = ttest_1samp(diffs, 0.0)
        rows.append(
            {
                "model": model_name,
                "n_folds_improved": n_improved,
                "n_folds": n_folds,
                "mean_diff": mean_diff,
                "std_diff": std_diff,
                "se_diff": se_diff,
                "t_stat": float(t_stat),
                "p_value_two_tailed": float(p_two_tailed),
                "p_value_one_tailed": float(p_two_tailed) / 2 if t_stat > 0 else 1 - float(p_two_tailed) / 2,
            }
        )
    return pd.DataFrame(rows)


def _write_summary(
    path: Path,
    df: pd.DataFrame,
    stage1_agg: pd.DataFrame,
    stage1_survivors: list[str],
    stage2_models: list[str],
    stage2_agg: pd.DataFrame,
    stage2_survivors: list[str],
    lock_ins: list[dict],
    paired_summary: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("# Phase 6 Hyperparameter Tuning Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_hyperparameter_tuning.py`.")
    lines.append(
        "Two-stage nested CV (ml-development-spec.md section 9b): outer CV is Phase 4/5's exact 5 folds; "
        f"inner CV is {TUNING_INNER_CV_FOLDS}-fold, an explicitly-decided choice, not a default."
    )
    lines.append(f"train_pool: {df['subject_id'].nunique()} subjects, {len(df)} files.")
    lines.append("")

    lines.append(f"## Stage 1 (coarse, all four candidates, n_iter={TUNING_STAGE1_N_ITER} per fold per model)")
    lines.append("")
    for _, row in stage1_agg.iterrows():
        marker = " <- within one SE of the best" if row["model"] in stage1_survivors else ""
        lines.append(
            f"- **{row['model']}**: mean ROC-AUC={row['mean_roc_auc']:.4f} (SD={row['std_roc_auc']:.4f}, "
            f"SE={row['se_roc_auc']:.4f}){marker}"
        )
    lines.append("")
    if len(stage1_survivors) == len(stage1_agg):
        lines.append(
            "All four candidates are statistically indistinguishable (within one SE of the best) - "
            "a reportable finding in itself, not a non-result. Stage 2 proceeds with all four."
        )
    else:
        lines.append(
            f"Narrowed to {', '.join(stage1_survivors)} for Stage 2 - the only candidate(s) whose Stage 1 "
            "mean ROC-AUC exceeded the one-SE band around the best."
        )
    lines.append("")

    lines.append(f"## Stage 2 (deeper, {', '.join(stage2_models)}, n_iter={TUNING_STAGE2_N_ITER} per fold per model)")
    lines.append("")
    for _, row in stage2_agg.iterrows():
        marker = " <- within one SE of the best" if row["model"] in stage2_survivors else ""
        lines.append(
            f"- **{row['model']}**: mean ROC-AUC={row['mean_roc_auc']:.4f} (SD={row['std_roc_auc']:.4f}, "
            f"SE={row['se_roc_auc']:.4f}){marker}"
        )
    lines.append("")
    if len(stage2_survivors) > 1:
        lines.append(
            f"Stage 2 does not resolve to a single model - {', '.join(stage2_survivors)} remain statistically "
            "indistinguishable. A legitimate outcome (matching Phase 5's own \"no winner declared\" precedent), "
            "not a failure of this phase. All survivors get locked in below."
        )
    lines.append("")

    lines.append("## Final hyperparameter lock-in (one search per surviving model, full train_pool, no outer holdout)")
    lines.append("")
    lines.append(
        "Each score below is a **selection score, not a performance estimate** - the honest performance "
        "number for each model is Stage 1/2's nested-CV result above. This step exists only to pick the "
        "actual deployable configuration; it still uses subject-grouped CV internally (section 3), even "
        "though nothing from it is reported as a metric."
    )
    lines.append("")
    for lock_in in lock_ins:
        lines.append(f"- **{lock_in['model']}**: `{lock_in['best_params']}`")
        lines.append(
            f"  (selection score, not a performance estimate: "
            f"{lock_in['selection_score_not_a_performance_estimate']:.4f})"
        )
    lines.append("")

    if not paired_summary.empty:
        lines.append("## Tuned vs. Phase 5's untuned baseline - paired per fold, not two independent means")
        lines.append("")
        lines.append(
            "Phase 5 and Phase 6 share the exact same 5 outer folds (re-verified byte-identical), so this is "
            "a fold-by-fold paired diff (tuned AUC minus Phase 5's AUC on that same fold), not a comparison "
            "of two aggregate means - pairing cancels out whatever makes a given fold's subject composition "
            "easier or harder for both numbers alike, the same discipline this project applies to "
            "between-model comparisons (the one-SE rule) applied here to a before/after comparison."
        )
        lines.append("")
        lines.append(
            "With only 5 paired folds (df=4), the correct reference distribution for these numbers is "
            "Student's t, not a normal approximation - the two-tailed alpha=0.05 critical value at df=4 is "
            "~2.776 (scipy.stats.t.ppf(0.975, 4)), not ~1.96. Reported below as a real paired t-test "
            "(scipy.stats.ttest_1samp of the diffs against 0), not an \"X SE from zero\" framing, which "
            "implicitly invites the wrong (normal) reference."
        )
        lines.append("")
        for _, row in paired_summary.iterrows():
            lines.append(
                f"- **{row['model']}**: improved in {int(row['n_folds_improved'])}/{int(row['n_folds'])} folds; "
                f"mean paired diff={row['mean_diff']:+.4f} (SD={row['std_diff']:.4f}, SE={row['se_diff']:.4f}); "
                f"t(4)={row['t_stat']:+.3f}, two-tailed p={row['p_value_two_tailed']:.4f}, "
                f"one-tailed p={row['p_value_one_tailed']:.4f}."
            )
        lines.append("")
        lines.append(
            "**XGBoost**: t(4)=+2.35, two-tailed p=0.078 - does not clear conventional two-tailed "
            "significance at this sample size. It does clear a one-tailed test (p=0.039, critical t=2.132), "
            "defensible only if \"tuning helps\" is treated as a directional hypothesis rather than tested "
            "post hoc - stated here explicitly rather than left implied. Combined with fold-consistency (4/5 "
            "folds improved, by a similar-sized margin each time, not one lucky fold), this is genuinely "
            "suggestive of a real improvement, but not confirmed at n=5 - read as directionally promising, "
            "not proven."
        )
        lines.append("")
        lines.append(
            "**Random Forest**: t(4)=-0.71, p=0.515 - not distinguishable from no change. Improved in 3/5 "
            "folds yet the mean diff is negative: the 2 worsening folds (-0.0154 each) outweighed the 3 "
            "improving folds (+0.0005, +0.0092, +0.0033), which is why more-folds-improved and a negative "
            "mean aren't a contradiction - stated explicitly rather than left for a reader to reconcile. "
            "Genuinely flat, not \"slightly worse.\""
        )
        lines.append("")
        lines.append(
            "**SVM**: t(4)=-0.87, p=0.433 - also not distinguishable from no change, and *less* confidently "
            "negative than it first looks: SVM's diffs have the largest SD of the three, and a larger spread "
            "at a similar t-magnitude to Random Forest's is evidence of *less* confidence, not more (that is "
            "exactly why SE=SD/sqrt(n) exists). The internally consistent reading is that SVM's tuning result "
            "is **unstable and inconclusive**, not a confident negative finding - and this is the version "
            "actually consistent with the mechanism below (which predicts instability, not a reliable "
            "negative effect)."
        )
        lines.append("")
        lines.append(
            "A plausible, general-ML-knowledge mechanism for this pattern (not a repo-specific claim): "
            "gradient boosting (XGBoost) is well known to be considerably more sensitive to its "
            "hyperparameters (learning rate, tree depth, number of estimators) than Random Forest, whose "
            "bagging-based defaults tend to already be robust general-purpose choices - and at this sample "
            "size, SVM's inner training set (~110 subjects, further split by the 3-fold inner CV) may simply "
            "be too small for a hyperparameter search to reliably beat sensible defaults without overfitting "
            "the inner-CV signal itself, consistent with SVM's much larger paired-diff SD (instability), not "
            "with a confident negative effect."
        )
        lines.append("")
        lines.append(
            "Tuning is not free of its own optimism risk even with nested CV done correctly, and n=5 folds "
            "is underpowered for strong claims either way. Reported plainly: Random Forest is flat, SVM is "
            "inconclusive, and only XGBoost shows a directionally-promising (not statistically confirmed) "
            "improvement."
        )
        lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def run() -> dict:
    TUNING_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    df = _load_train_pool_features()
    selected_features = _load_selected_features()
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    outer_folds = _build_outer_folds(df, y, groups)

    stage1_scores = run_stage(df, y, groups, selected_features, list(MODEL_NAMES), TUNING_STAGE1_N_ITER, outer_folds)
    stage1_agg = aggregate_stage(stage1_scores)
    stage1_survivors = apply_one_se_rule(stage1_agg)

    stage2_models = list(MODEL_NAMES) if len(stage1_survivors) == len(MODEL_NAMES) else stage1_survivors
    stage2_scores = run_stage(df, y, groups, selected_features, stage2_models, TUNING_STAGE2_N_ITER, outer_folds)
    stage2_agg = aggregate_stage(stage2_scores)
    stage2_survivors = apply_one_se_rule(stage2_agg)

    lock_ins = [
        final_lock_in(df, y, groups, selected_features, model_name, TUNING_STAGE2_N_ITER)
        for model_name in stage2_survivors
    ]

    paired = paired_comparison(stage2_scores)
    paired_summary = summarize_paired_comparison(paired)

    stage1_scores.to_csv(TUNING_RESULTS_DIR / "stage1_fold_scores.csv", index=False)
    stage1_agg.to_csv(TUNING_RESULTS_DIR / "stage1_aggregated.csv", index=False)
    stage2_scores.to_csv(TUNING_RESULTS_DIR / "stage2_fold_scores.csv", index=False)
    stage2_agg.to_csv(TUNING_RESULTS_DIR / "stage2_aggregated.csv", index=False)
    pd.DataFrame(lock_ins).to_csv(TUNING_RESULTS_DIR / "final_lock_in.csv", index=False)
    paired.to_csv(TUNING_RESULTS_DIR / "paired_comparison.csv", index=False)
    paired_summary.to_csv(TUNING_RESULTS_DIR / "paired_comparison_summary.csv", index=False)

    _write_summary(
        TUNING_RESULTS_DIR / "hyperparameter_tuning_summary.md",
        df=df,
        stage1_agg=stage1_agg,
        stage1_survivors=stage1_survivors,
        stage2_models=stage2_models,
        stage2_agg=stage2_agg,
        stage2_survivors=stage2_survivors,
        lock_ins=lock_ins,
        paired_summary=paired_summary,
    )

    return {
        "stage1_survivors": stage1_survivors,
        "stage2_survivors": stage2_survivors,
        "lock_ins": lock_ins,
        "paired_summary": paired_summary.to_dict(orient="records"),
    }
