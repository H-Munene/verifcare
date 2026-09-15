import numpy as np
import pandas as pd
import pytest

from acoustic_model.stats_utils import continuous_correlation, label_correlation


def test_strict_bonferroni_is_never_looser_than_family_bonferroni():
    rng = np.random.default_rng(0)
    label = pd.Series([1] * 30 + [0] * 30)
    values = pd.Series(rng.normal(size=60))

    result = label_correlation(label, values, n_family=3, n_strict=6)

    assert result.point_biserial_p_bonferroni_strict >= result.point_biserial_p_bonferroni_family
    assert result.mannwhitney_p_bonferroni_strict >= result.mannwhitney_p_bonferroni_family


def test_label_correlation_detects_a_real_group_difference():
    label = pd.Series([1] * 40 + [0] * 40)
    values = pd.Series([5.0] * 40 + [1.0] * 40)  # perfectly separated groups

    result = label_correlation(label, values, n_family=1, n_strict=1)

    assert result.point_biserial_r > 0.9
    assert result.point_biserial_p_bonferroni_family < 0.001
    # rank_biserial = 1 - 2U/(n1*n2): every positive value exceeding every negative
    # value pushes U to its maximum, giving -1.0 under this formula's sign
    # convention (the same one Phase 1's audit.py confound check already uses).
    assert result.mannwhitney_rank_biserial == pytest.approx(-1.0)


def test_label_correlation_handles_insufficient_data():
    result = label_correlation(pd.Series([1, 1]), pd.Series([1.0, 2.0]), n_family=1, n_strict=1)
    assert result.point_biserial_r is None


def test_continuous_correlation_strict_never_looser_than_family():
    rng = np.random.default_rng(1)
    x = pd.Series(rng.normal(size=50))
    y = pd.Series(rng.normal(size=50))

    result = continuous_correlation(x, y, n_family=9, n_strict=18)

    assert result.pearson_p_bonferroni_strict >= result.pearson_p_bonferroni_family
    assert result.spearman_p_bonferroni_strict >= result.spearman_p_bonferroni_family


def test_continuous_correlation_detects_a_real_linear_relationship():
    x = pd.Series(np.arange(50, dtype=float))
    y = pd.Series(np.arange(50, dtype=float) * 2 + 1)

    result = continuous_correlation(x, y, n_family=1, n_strict=1)

    assert result.pearson_r == pytest.approx(1.0)
    assert result.spearman_rho == pytest.approx(1.0)
