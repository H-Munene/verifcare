import numpy as np

from mzazi_acoustic.model_evaluation import validation


class UsesFirstFeatureOnly:
    def predict_proba(self, X):
        p = 1 / (1 + np.exp(-X[:, 0]))
        return np.column_stack([1 - p, p])


def test_permutation_importance_finds_the_feature_the_model_uses():
    rng = np.random.default_rng(0)
    n = 200
    y = rng.integers(0, 2, n)
    X = np.column_stack([y * 2.0 + rng.normal(0, 0.5, n), rng.normal(0, 1, n)])
    subjects = [f"s{i // 2}" for i in range(n)]
    result = validation.permutation_importance(UsesFirstFeatureOnly(), X, y, subjects, ["used", "ignored"],
                                               n_repeats=5, rng=np.random.default_rng(1)).set_index("feature")
    assert result.loc["used", "importance_mean"] > 0.3
    assert result.loc["ignored", "importance_mean"] == 0.0
