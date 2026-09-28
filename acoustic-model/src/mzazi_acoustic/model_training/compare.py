"""Model comparison and the pre-registered selection rule (PLAN.md 4.2 step 5).

Test: the corrected repeated k-fold t-test (Bouckaert & Frank 2004). CV training portions overlap,
so the plain paired t-test understates the variance; the correction adds n_test / n_train.
Every pairwise p-value is Bonferroni-adjusted over the pre-registered family of 6 comparisons,
at every level of the cascade (the family was fixed in advance, so it isn't shrunk as models drop).

Selection cascade, one level at a time, starting with all candidates:
  1. person-weighted ROC-AUC (higher is better), corrected t-test
  2. person-weighted calibrated Brier score (lower is better), same test
  3. lowest mean person-weighted ECE (no test)
  4. simplest model, in SIMPLICITY_ORDER
At a test level, the leader is the candidate with the best mean. If it is significantly better than
every other remaining candidate, it wins. Otherwise every candidate NOT significantly worse than
the leader is "tied" and moves on to the next level. (Interpretation written down here because
the plan says only "if tied".)
"""

import itertools

import numpy as np
import pandas as pd
from scipy import stats

from mzazi_acoustic.common import config
from mzazi_acoustic.common.stats import bonferroni

# Expected simplicity order (fewest dependencies, smallest saved model): a linear model is a few
# numbers, SVM keeps support vectors, forests keep 300 trees. Only used to order ties inside the
# cascade and as a last-resort tiebreak; the simplicity level itself ranks by what is measured.
SIMPLICITY_ORDER = ["logistic_regression", "svm", "random_forest", "xgboost"]
# Third-party packages each candidate needs at inference, beyond numpy/scipy.
DEPENDENCIES = {"logistic_regression": ["scikit-learn"], "svm": ["scikit-learn"],
                "random_forest": ["scikit-learn"], "xgboost": ["scikit-learn", "xgboost"]}
LEVELS = [("roc_auc_person", True), ("brier_person", False)]


def corrected_repeated_t(differences, n_train, n_test, k, r):
    """Returns (t, two-sided p). differences: one per fold, k folds x r repeats."""
    d = np.asarray(differences, float)
    mean, var = d.mean(), d.var(ddof=1)
    if var == 0:
        return (0.0, 1.0) if mean == 0 else (np.sign(mean) * np.inf, 0.0)
    t = mean / np.sqrt((1 / (k * r) + n_test / n_train) * var)
    return float(t), float(2 * stats.t.sf(abs(t), df=k * r - 1))


def pairwise(fold_metrics, metric, models, n_train, n_test, k=config.CV_FOLDS, r=config.CV_REPEATS):
    """One row per pair (a, b): mean of a - b over matched folds, t, p and Bonferroni p (family of 6)."""
    wide = fold_metrics.pivot_table(index=["repeat", "fold"], columns="model", values=metric)
    rows = []
    for a, b in itertools.combinations(models, 2):
        t, p = corrected_repeated_t(wide[a] - wide[b], n_train, n_test, k, r)
        rows.append({"metric": metric, "model_a": a, "model_b": b, "mean_difference": (wide[a] - wide[b]).mean(),
                     "t": t, "p": p})
    table = pd.DataFrame(rows)
    table["p_bonferroni"] = bonferroni(table["p"], family_size=config.N_PAIRWISE_COMPARISONS)
    return table


def _significantly_better(table, winner, other, higher_is_better):
    row = table[((table.model_a == winner) & (table.model_b == other)) | ((table.model_a == other) & (table.model_b == winner))].iloc[0]
    diff = row.mean_difference if row.model_a == winner else -row.mean_difference
    better = diff > 0 if higher_is_better else diff < 0
    return better and row.p_bonferroni < config.ALPHA


def select(fold_metrics, n_train, n_test, k=config.CV_FOLDS, r=config.CV_REPEATS):
    """Returns (chosen model, list of decision records, all pairwise tables)."""
    remaining = sorted(fold_metrics["model"].unique(), key=SIMPLICITY_ORDER.index)
    record, tables = [], []
    for metric, higher_is_better in LEVELS:
        if len(remaining) == 1:
            break
        table = pairwise(fold_metrics, metric, remaining, n_train, n_test, k, r)
        tables.append(table)
        means = fold_metrics[fold_metrics.model.isin(remaining)].groupby("model")[metric].mean()
        leader = means.idxmax() if higher_is_better else means.idxmin()
        others = [m for m in remaining if m != leader]
        if all(_significantly_better(table, leader, o, higher_is_better) for o in others):
            record.append(f"{metric}: {leader} significantly better than all remaining; chosen")
            return leader, record, tables
        tied = [leader] + [o for o in others if not _significantly_better(table, leader, o, higher_is_better)]
        remaining = sorted(tied, key=SIMPLICITY_ORDER.index)
        record.append(f"{metric}: no clear winner; tied set {remaining}")
    if len(remaining) == 1:
        return remaining[0], record, tables
    ece = fold_metrics[fold_metrics.model.isin(remaining)].groupby("model")["ece_person"].mean()
    best = ece[ece == ece.min()].index.tolist()
    if len(best) == 1:
        record.append(f"ece_person: lowest mean is {best[0]}; chosen")
        return best[0], record, tables
    chosen, simplicity = simplest(fold_metrics, best)
    record.append(f"ece_person: exact tie {best}; simplicity level reached; {simplicity}; chosen {chosen}")
    return chosen, record, tables


def simplest(fold_metrics, tied):
    """Simplicity level: fewest dependencies, then smallest mean saved size (measured per fold).

    Returns (chosen, a record of every tied model's dependencies and size). Falls back to
    SIMPLICITY_ORDER for anything still equal, or when sizes weren't measured.
    """
    sizes = {}
    if "artifact_bytes" in fold_metrics:
        sizes = fold_metrics[fold_metrics.model.isin(tied)].groupby("model")["artifact_bytes"].mean().to_dict()

    def key(model):
        return (len(DEPENDENCIES[model]), sizes.get(model, np.inf), SIMPLICITY_ORDER.index(model))

    chosen = min(tied, key=key)
    details = ", ".join(f"{m}: deps={DEPENDENCIES[m]}, mean size={sizes.get(m, float('nan')):.0f} B" for m in tied)
    return chosen, details
