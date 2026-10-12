import numpy as np

from mzazi_acoustic.common import stats


def test_rank_biserial_sign_follows_the_positive_group():
    _, _, higher = stats.mann_whitney([10, 11, 12], [1, 2, 3])
    _, _, lower = stats.mann_whitney([1, 2, 3], [10, 11, 12])
    assert higher == 1.0 and lower == -1.0


def test_bonferroni_multiplies_by_number_of_tests_and_caps_at_one():
    assert np.allclose(stats.bonferroni([0.01, 0.2, 0.5]), [0.03, 0.6, 1.0])
