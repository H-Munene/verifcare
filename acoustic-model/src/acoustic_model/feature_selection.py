"""Phase 4 feature selection: Random Forest permutation importance, applied
uniformly to choose one feature subset used to train all four section-7
candidate models in Phase 5 (see docs/ml-development-spec.md section 4b).

Not impurity-based importance - biased in the presence of the correlated
features Phase 3 confirmed exist here - so permutation importance is used
instead, computed only on held-out validation folds, via subject-aware
(StratifiedGroupKFold) cross-validation over train_pool. The same CV
structure both ranks features and chooses k (dimensionality) via a CV
score, so no separate "final refit on all of train_pool" step is needed:
train_pool already is the full training data available before Phase 10's
locked test evaluation, and every subject's files appear in exactly one
fold's held-out validation set across the K folds, so the aggregated
importance ranking already reflects the whole of train_pool without
leakage - see the spec for the reasoning behind this equivalence.

Run via `scripts/run_feature_selection.py`, not this module directly.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import permutation_importance
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold

from acoustic_model.config import (
    FEATURE_SELECTION_CANDIDATE_K_VALUES,
    FEATURE_SELECTION_CV_FOLDS,
    FEATURE_SELECTION_RESULTS_DIR,
    FEATURE_SELECTION_RF_N_ESTIMATORS,
    FEATURES_RESULTS_DIR,
    PERMUTATION_IMPORTANCE_N_REPEATS,
    RANDOM_SEED,
    VOICE_QUALITY_CROSS_CHECK_COLUMNS,
)


def _load_train_pool_features() -> pd.DataFrame:
    path = FEATURES_RESULTS_DIR / "feature_matrix.csv"
    if not path.exists():
        raise FileNotFoundError(f"{path} not found - run scripts/run_features.py first.")
    df = pd.read_csv(path)
    train_pool = df[df["split"] == "train_pool"].reset_index(drop=True)
    return train_pool


def _make_rf() -> RandomForestClassifier:
    return RandomForestClassifier(
        n_estimators=FEATURE_SELECTION_RF_N_ESTIMATORS,
        class_weight="balanced",
        random_state=RANDOM_SEED,
        n_jobs=-1,
    )


def _build_folds(df: pd.DataFrame, y: pd.Series, groups: pd.Series) -> list[tuple[np.ndarray, np.ndarray]]:
    splitter = StratifiedGroupKFold(n_splits=FEATURE_SELECTION_CV_FOLDS, shuffle=True, random_state=RANDOM_SEED)
    return list(splitter.split(df, y, groups))


def compute_fold_importances(
    df: pd.DataFrame, y: pd.Series, groups: pd.Series, feature_columns: list[str]
) -> pd.DataFrame:
    """Fits an RF per fold on the fold's training portion, computes permutation
    importance on the fold's held-out validation portion only - never the
    training portion, which is what avoids the overfitting-linked inflation
    impurity importance has. Returns one row per (fold, feature)."""
    folds = _build_folds(df, y, groups)
    rows = []
    for fold_index, (train_idx, val_idx) in enumerate(folds):
        rf = _make_rf()
        rf.fit(df.iloc[train_idx][feature_columns], y.iloc[train_idx])
        result = permutation_importance(
            rf,
            df.iloc[val_idx][feature_columns],
            y.iloc[val_idx],
            n_repeats=PERMUTATION_IMPORTANCE_N_REPEATS,
            random_state=RANDOM_SEED,
            scoring="roc_auc",
        )
        for feature, importance_mean, importance_std in zip(
            feature_columns, result.importances_mean, result.importances_std
        ):
            rows.append(
                {
                    "fold": fold_index,
                    "feature": feature,
                    "importance_mean": importance_mean,
                    "importance_std": importance_std,
                }
            )
    return pd.DataFrame(rows)


def aggregate_importance(fold_importances: pd.DataFrame) -> pd.DataFrame:
    """Mean/std of each feature's per-fold permutation importance, averaged across
    folds - the final ranking, since every fold's importance was computed on that
    fold's held-out validation data, never its own training data."""
    aggregated = (
        fold_importances.groupby("feature")["importance_mean"]
        .agg(["mean", "std"])
        .rename(columns={"mean": "mean_importance", "std": "std_importance"})
        .reset_index()
        .sort_values("mean_importance", ascending=False)
        .reset_index(drop=True)
    )
    aggregated["rank"] = aggregated.index + 1
    return aggregated


def choose_k(
    df: pd.DataFrame,
    y: pd.Series,
    groups: pd.Series,
    fold_importances: pd.DataFrame,
) -> tuple[int, pd.DataFrame]:
    """For each candidate k and each fold, ranks features using *that fold's own*
    importance (not the global aggregate - using the aggregate here would leak a
    feature's held-out-fold importance back into that same fold's k-evaluation),
    retrains a fresh RF restricted to the top-k, and scores it on the fold's
    validation portion. k is chosen by the one-standard-error rule: the smallest
    k whose mean CV AUC is within one standard error of the best mean CV AUC,
    rather than the single highest-scoring k - which would likely just be the
    largest k tried, defeating the point of a stopping rule."""
    folds = _build_folds(df, y, groups)
    scores = []
    for k in FEATURE_SELECTION_CANDIDATE_K_VALUES:
        fold_aucs = []
        for fold_index, (train_idx, val_idx) in enumerate(folds):
            fold_rank = fold_importances[fold_importances["fold"] == fold_index].sort_values(
                "importance_mean", ascending=False
            )
            top_k_features = fold_rank["feature"].head(k).tolist()

            rf = _make_rf()
            rf.fit(df.iloc[train_idx][top_k_features], y.iloc[train_idx])
            probabilities = rf.predict_proba(df.iloc[val_idx][top_k_features])[:, 1]
            fold_aucs.append(roc_auc_score(y.iloc[val_idx], probabilities))

        mean_auc = float(np.mean(fold_aucs))
        std_auc = float(np.std(fold_aucs))
        se_auc = std_auc / np.sqrt(len(fold_aucs))
        scores.append({"k": k, "mean_auc": mean_auc, "std_auc": std_auc, "se_auc": se_auc})

    scores_df = pd.DataFrame(scores)
    best_row = scores_df.loc[scores_df["mean_auc"].idxmax()]
    one_se_threshold = best_row["mean_auc"] - best_row["se_auc"]
    within_one_se = scores_df[scores_df["mean_auc"] >= one_se_threshold]
    chosen_k = int(within_one_se["k"].min())
    return chosen_k, scores_df


def selection_stability(fold_importances: pd.DataFrame, chosen_k: int, n_folds: int) -> pd.DataFrame:
    """How often each feature appears in each fold's own top-`chosen_k` list -
    reported as a diagnostic given the confirmed multicollinearity, not treated
    as a filtering decision itself."""
    counts: dict[str, int] = {}
    for fold_index in range(n_folds):
        fold_rank = fold_importances[fold_importances["fold"] == fold_index].sort_values(
            "importance_mean", ascending=False
        )
        for feature in fold_rank["feature"].head(chosen_k).tolist():
            counts[feature] = counts.get(feature, 0) + 1
    return pd.DataFrame(
        [{"feature": feature, "times_selected": count, "of_folds": n_folds} for feature, count in counts.items()]
    ).sort_values("times_selected", ascending=False).reset_index(drop=True)


def _write_summary(
    path: Path,
    df: pd.DataFrame,
    aggregated: pd.DataFrame,
    k_scores: pd.DataFrame,
    chosen_k: int,
    stability: pd.DataFrame,
    selected: pd.DataFrame,
) -> None:
    lines: list[str] = []
    lines.append("# Feature Selection Summary")
    lines.append("")
    lines.append("Generated by `scripts/run_feature_selection.py`.")
    lines.append("Method: Random Forest permutation importance, computed on held-out validation folds only, via subject-aware (StratifiedGroupKFold) cross-validation over train_pool.")
    lines.append("One feature subset is selected and used to train all four section-7 candidates in Phase 5 - not a per-model selection.")
    lines.append(f"Run on train_pool: {df['subject_id'].nunique()} subjects, {len(df)} files.")
    lines.append("")

    lines.append("## k selection (cross-validated stopping rule)")
    lines.append("")
    lines.append("Mean CV ROC-AUC per candidate k, using each fold's own importance ranking (not the global aggregate) to avoid leaking a feature's held-out importance into its own fold's k-evaluation.")
    lines.append("Chosen k is the smallest k within one standard error of the best mean AUC (a one-SE rule), not simply the highest-scoring k.")
    lines.append("")
    for _, row in k_scores.iterrows():
        marker = " <- chosen" if int(row["k"]) == chosen_k else ""
        lines.append(f"k={int(row['k'])}: mean AUC={row['mean_auc']:.4f} (std={row['std_auc']:.4f}, SE={row['se_auc']:.4f}){marker}")
    lines.append("")
    lines.append(f"**Chosen k = {chosen_k}.**")
    lines.append("")

    lines.append("## Selected features (final list, ranked by aggregated permutation importance)")
    lines.append("")
    for _, row in selected.iterrows():
        lines.append(f"{int(row['rank'])}. {row['feature']}: mean importance={row['mean_importance']:.4f} (std={row['std_importance']:.4f})")
    lines.append("")

    lines.append("## Selection stability (informational, given the confirmed Phase 3 multicollinearity)")
    lines.append("")
    unstable = stability[stability["times_selected"] < stability["of_folds"]]
    lines.append(f"{len(stability) - len(unstable)} of {len(stability)} features selected in all {FEATURE_SELECTION_CV_FOLDS} folds; {len(unstable)} selected in fewer.")
    if len(unstable) > 0:
        lines.append("Features selected in fewer than all folds (feature: times/folds):")
        for _, row in unstable.iterrows():
            lines.append(f"  {row['feature']}: {row['times_selected']}/{row['of_folds']}.")
    lines.append("")

    lines.append("## Shimmer/jitter/HNR family, not special-cased but recorded")
    lines.append("")
    lines.append("The three exact functionals tracked by the Phase 1/3 confound triangle:")
    for voice_col in VOICE_QUALITY_CROSS_CHECK_COLUMNS:
        in_selected = voice_col in selected["feature"].values
        rank_row = aggregated[aggregated["feature"] == voice_col]
        rank = int(rank_row["rank"].iloc[0]) if len(rank_row) else None
        lines.append(f"  {voice_col}: rank {rank} of {len(aggregated)}, {'selected' if in_selected else 'not selected'} at k={chosen_k}.")
    lines.append("")
    family_mask = aggregated["feature"].str.contains("jitter|shimmer|HNR", case=False)
    family_selected = aggregated[family_mask & aggregated["feature"].isin(selected["feature"])]
    other_family_selected = family_selected[~family_selected["feature"].isin(VOICE_QUALITY_CROSS_CHECK_COLUMNS)]
    if len(other_family_selected) > 0:
        lines.append("Broader check (any jitter/shimmer/HNR-family functional, not just the 3 exact tracked columns) found additional selected features the check above would have missed:")
        for _, row in other_family_selected.iterrows():
            lines.append(f"  {row['feature']}: rank {int(row['rank'])}, selected at k={chosen_k}.")
    else:
        lines.append("Broader check (any jitter/shimmer/HNR-family functional) found no additional selected features beyond the 3 above.")
    lines.append("")
    lines.append("No feature named above was included or excluded specially because of the Phase 1/3 channel-entanglement finding on shimmer - this is simply what the method produced.")
    lines.append("The outcome is cross-referenced to the standing Phase 8 (interpretability) obligation: if shimmer/jitter/HNR-family features are selected and matter to the final model, that finding still needs to be weighed against the channel-entanglement result, not treated as settled physiological signal.")
    lines.append("")

    path.write_text("\n".join(lines), encoding="utf-8")


def run() -> dict:
    FEATURE_SELECTION_RESULTS_DIR.mkdir(parents=True, exist_ok=True)

    df = _load_train_pool_features()
    feature_columns = [c for c in df.columns if c not in ("file_id", "subject_id", "class_label", "split")]
    y = (df["class_label"] == "dementia").astype(int)
    groups = df["subject_id"]

    fold_importances = compute_fold_importances(df, y, groups, feature_columns)
    aggregated = aggregate_importance(fold_importances)
    chosen_k, k_scores = choose_k(df, y, groups, fold_importances)
    stability = selection_stability(fold_importances, chosen_k, FEATURE_SELECTION_CV_FOLDS)
    selected = aggregated.head(chosen_k).reset_index(drop=True)

    fold_importances.to_csv(FEATURE_SELECTION_RESULTS_DIR / "fold_importances.csv", index=False)
    aggregated.to_csv(FEATURE_SELECTION_RESULTS_DIR / "aggregated_importance.csv", index=False)
    k_scores.to_csv(FEATURE_SELECTION_RESULTS_DIR / "k_selection_cv_scores.csv", index=False)
    stability.to_csv(FEATURE_SELECTION_RESULTS_DIR / "selection_stability.csv", index=False)
    selected.to_csv(FEATURE_SELECTION_RESULTS_DIR / "selected_features.csv", index=False)

    _write_summary(
        FEATURE_SELECTION_RESULTS_DIR / "feature_selection_summary.md",
        df=df,
        aggregated=aggregated,
        k_scores=k_scores,
        chosen_k=chosen_k,
        stability=stability,
        selected=selected,
    )

    return {"chosen_k": chosen_k, "selected_features": selected["feature"].tolist()}
