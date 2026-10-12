"""Statistical helpers shared by every stage's checks."""

import numpy as np
from scipy import stats


def bonferroni(p_values, family_size=None):
    """Bonferroni-adjusted p-values (p * m, capped at 1).

    m = family_size if given (a pre-registered family, even when only some of its tests are run),
    otherwise the number of p-values passed in.
    """
    p = np.asarray(p_values, dtype=float)
    return np.minimum(p * (family_size or len(p)), 1.0)


def mann_whitney(positive, negative):
    """Two-sided Mann-Whitney U with rank-biserial effect size.

    Returns (U, p, rank_biserial). U is the statistic for the positive group. The effect size is
    +1 when every positive value is above every negative value, -1 for the reverse, 0 for no shift.
    """
    positive = np.asarray(positive, dtype=float)
    negative = np.asarray(negative, dtype=float)
    u, p = stats.mannwhitneyu(positive, negative, alternative="two-sided")
    rank_biserial = 2 * u / (len(positive) * len(negative)) - 1
    return float(u), float(p), float(rank_biserial)


def point_biserial(values, labels):
    """Pearson correlation between a continuous value and a 0/1 label. Returns (r, p)."""
    r, p = stats.pointbiserialr(np.asarray(labels), np.asarray(values, dtype=float))
    return float(r), float(p)
