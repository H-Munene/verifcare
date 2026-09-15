"""Shared statistical helpers for the confound-style checks used across
phases: a continuous variable's association with a binary label
(point-biserial + Mann-Whitney, with a rank-biserial effect size), and
two continuous variables' association with each other (Pearson +
Spearman).

Both report a **flat/naive Bonferroni**-adjusted p-value (adjusted_p =
min(raw_p * n, 1.0), never Holm-Bonferroni or another step-down
procedure) at two levels, matching the dual reporting Phase 1
established for its confound check. Both levels are computed from the
same raw p-value independently, never chained on top of each other:
- "family": n = the tests of the same statistical type run in the
  same battery (e.g. all point-biserial tests, or all Pearson tests)
  - the more lenient view.
- "strict": n = every p-value computed in the whole battery,
  regardless of type - the more conservative view. A result that only
  survives at the family level, not the strict level, is reported as
  "borderline," not "robust."
"""

from __future__ import annotations

from dataclasses import dataclass

import pandas as pd
from scipy import stats


@dataclass
class LabelCorrelationResult:
    n: int
    point_biserial_r: float | None
    point_biserial_p: float | None
    point_biserial_p_bonferroni_family: float | None
    point_biserial_p_bonferroni_strict: float | None
    mannwhitney_p: float | None
    mannwhitney_p_bonferroni_family: float | None
    mannwhitney_p_bonferroni_strict: float | None
    mannwhitney_rank_biserial: float | None


def label_correlation(
    label_binary: pd.Series, values: pd.Series, n_family: int, n_strict: int
) -> LabelCorrelationResult:
    """Point-biserial correlation + Mann-Whitney U between a binary label (1/0)
    and a continuous variable, both Bonferroni-adjusted at the family and strict
    levels described above."""
    valid = values.notna() & label_binary.notna()
    if valid.sum() < 3 or label_binary[valid].nunique() < 2:
        return LabelCorrelationResult(int(valid.sum()), None, None, None, None, None, None, None, None)

    r, p = stats.pointbiserialr(label_binary[valid], values[valid])
    positive = values[valid & (label_binary == 1)]
    negative = values[valid & (label_binary == 0)]
    mw = stats.mannwhitneyu(positive, negative, alternative="two-sided")
    n1, n2 = len(positive), len(negative)
    rank_biserial = 1 - (2 * mw.statistic) / (n1 * n2)

    return LabelCorrelationResult(
        n=int(valid.sum()),
        point_biserial_r=float(r),
        point_biserial_p=float(p),
        point_biserial_p_bonferroni_family=float(min(p * n_family, 1.0)),
        point_biserial_p_bonferroni_strict=float(min(p * n_strict, 1.0)),
        mannwhitney_p=float(mw.pvalue),
        mannwhitney_p_bonferroni_family=float(min(mw.pvalue * n_family, 1.0)),
        mannwhitney_p_bonferroni_strict=float(min(mw.pvalue * n_strict, 1.0)),
        mannwhitney_rank_biserial=float(rank_biserial),
    )


@dataclass
class ContinuousCorrelationResult:
    n: int
    pearson_r: float | None
    pearson_p_bonferroni_family: float | None
    pearson_p_bonferroni_strict: float | None
    spearman_rho: float | None
    spearman_p_bonferroni_family: float | None
    spearman_p_bonferroni_strict: float | None


def continuous_correlation(x: pd.Series, y: pd.Series, n_family: int, n_strict: int) -> ContinuousCorrelationResult:
    """Pearson + Spearman correlation between two continuous variables, both
    Bonferroni-adjusted at the family and strict levels described above."""
    valid = pd.DataFrame({"x": x, "y": y}).dropna()
    if len(valid) < 3:
        return ContinuousCorrelationResult(len(valid), None, None, None, None, None, None)

    pearson_r, pearson_p = stats.pearsonr(valid["x"], valid["y"])
    spearman_rho, spearman_p = stats.spearmanr(valid["x"], valid["y"])

    return ContinuousCorrelationResult(
        n=len(valid),
        pearson_r=float(pearson_r),
        pearson_p_bonferroni_family=float(min(pearson_p * n_family, 1.0)),
        pearson_p_bonferroni_strict=float(min(pearson_p * n_strict, 1.0)),
        spearman_rho=float(spearman_rho),
        spearman_p_bonferroni_family=float(min(spearman_p * n_family, 1.0)),
        spearman_p_bonferroni_strict=float(min(spearman_p * n_strict, 1.0)),
    )
