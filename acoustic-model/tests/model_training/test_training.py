"""Stage 4 on synthetic data: weights, routing, grouping, fold hygiene, the t-test, selection, saving."""

import runpy
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from scipy import stats
from sklearn.base import BaseEstimator, ClassifierMixin
from sklearn.metrics import make_scorer, roc_auc_score
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.preprocessing import StandardScaler

from mzazi_acoustic.common import config
from mzazi_acoustic.data_processing import splits
from mzazi_acoustic.model_training import calibration, candidates, compare, cv, final, weights

FEATURES = ["row_id", "signal", "noise"]


def synthetic(n_subjects=40, seed=0):
    """Clips from people with 1-3 clips each; 'signal' separates the classes, 'row_id' is unique."""
    rng = np.random.default_rng(seed)
    rows = []
    for s in range(n_subjects):
        label = int(s % 3 == 0)
        for c in range(rng.integers(1, 4)):
            rows.append({"file_id": f"S{s:02d}_f{c}", "subject_id": f"S{s:02d}", "label": label,
                         "signal": label + rng.normal(0, 0.8), "noise": rng.normal()})
    table = pd.DataFrame(rows)
    table["row_id"] = np.arange(len(table), dtype=float) * 1000  # far from other values, never imputed
    return table


@pytest.fixture(autouse=True)
def small_budget(monkeypatch):
    monkeypatch.setattr(config, "SEARCH_CONFIGS_PER_MODEL", 2)
    monkeypatch.setattr(config, "N_TREES", 10)


# spies

class Record:
    model_weights, scaler_weights, scorer_weights, sigmoid_weights, split_groups, fitted_rows = [], [], [], [], [], []

    @classmethod
    def clear(cls):
        for name in ["model_weights", "scaler_weights", "scorer_weights", "sigmoid_weights", "split_groups", "fitted_rows"]:
            setattr(cls, name, [])


class SpyClassifier(ClassifierMixin, BaseEstimator):
    def __init__(self, C=1.0):
        self.C = C

    def fit(self, X, y, sample_weight=None):
        Record.model_weights.append(sample_weight)
        self.classes_ = np.array([0, 1])
        return self

    def decision_function(self, X):
        return np.asarray(X)[:, 1]

    def predict(self, X):
        return (self.decision_function(X) > 0).astype(int)


class SpyScaler(StandardScaler):
    def fit(self, X, y=None, sample_weight=None):
        Record.scaler_weights.append(sample_weight)
        Record.fitted_rows.append(set(np.asarray(X)[:, 0]))
        return super().fit(X, y)


class SpySplitter(StratifiedGroupKFold):
    def split(self, X, y=None, groups=None):
        Record.split_groups.append(groups)
        for train_idx, test_idx in super().split(X, y, groups):
            assert not set(np.asarray(groups)[train_idx]) & set(np.asarray(groups)[test_idx])
            yield train_idx, test_idx


def spy_scorer():
    def auc(y, score, sample_weight=None):
        Record.scorer_weights.append(sample_weight)
        return roc_auc_score(y, score, sample_weight=sample_weight)
    return make_scorer(auc, response_method="decision_function").set_score_request(sample_weight=True)


@pytest.fixture
def spies(monkeypatch):
    Record.clear()
    real_fit_sigmoid = calibration.fit_sigmoid

    def recording_fit_sigmoid(scores, y, sample_weight):
        Record.sigmoid_weights.append(sample_weight)
        return real_fit_sigmoid(scores, y, sample_weight)

    monkeypatch.setattr(candidates, "SEARCH_N_JOBS", 1)  # worker processes' records wouldn't reach the test
    monkeypatch.setattr(candidates, "new_model", lambda name, seed: SpyClassifier())
    monkeypatch.setattr(candidates, "StandardScaler", SpyScaler)
    monkeypatch.setattr(candidates, "person_weighted_auc", spy_scorer)
    monkeypatch.setattr(candidates, "inner_splitter",
                        lambda seed: SpySplitter(n_splits=config.INNER_CV_FOLDS, shuffle=True, random_state=seed))
    monkeypatch.setattr(calibration, "fit_sigmoid", recording_fit_sigmoid)
    return Record


# tests

def test_training_weights_count_each_person_once_then_balance_classes():
    subjects = ["a", "a", "b", "c", "c", "c"]
    labels = [1, 1, 1, 0, 0, 0]
    assert np.allclose(weights.person_weights(subjects), [0.5, 0.5, 1, 1 / 3, 1 / 3, 1 / 3])
    w = weights.training_weights(subjects, labels)
    assert np.isclose(w[:3].sum(), w[3:].sum())
    assert np.isclose(w[0] / w[2], 0.5)  # within a class, still per person


def test_weights_reach_model_scorer_and_calibration_but_not_the_scaler(spies):
    data = synthetic()
    cv.fit_calibrated("logistic_regression", "tuned", data[FEATURES], data["label"], data["subject_id"], seed=1)
    assert spies.model_weights and all(w is not None for w in spies.model_weights)
    assert spies.scorer_weights and all(w is not None for w in spies.scorer_weights)
    assert spies.scaler_weights and all(w is None for w in spies.scaler_weights)
    # Calibration uses per-person weights only, not the class-balanced training weights.
    assert np.allclose(spies.sigmoid_weights[-1], weights.person_weights(data["subject_id"]))


def test_search_and_calibration_splitters_receive_subject_groups(spies):
    data = synthetic()
    cv.fit_calibrated("logistic_regression", "tuned", data[FEATURES], data["label"], data["subject_id"], seed=1)
    # One call from the search, one from calibration's out-of-fold scores; the spy also asserts
    # that no subject was on both sides of any inner split.
    assert len(spies.split_groups) >= 2 and all(g is not None for g in spies.split_groups)


def test_learned_steps_never_see_validation_rows(spies):
    data = synthetic()
    folds = splits.make_folds(data, n_folds=4, n_repeats=1)
    val_ids = set(folds[folds.fold == 0].file_id)
    train, val = data[~data.file_id.isin(val_ids)], data[data.file_id.isin(val_ids)]
    cv.run_fold(train, val, FEATURES, "logistic_regression", "tuned", seed=1)
    seen = set().union(*spies.fitted_rows)
    assert seen and not seen & set(val["row_id"])


def test_corrected_repeated_t_matches_a_hand_computation():
    d = [1.0, 2.0, 3.0, 4.0]  # k = 2 folds x r = 2 repeats, n_test / n_train = 1
    t, p = compare.corrected_repeated_t(d, n_train=50, n_test=50, k=2, r=2)
    expected_t = 2.5 / np.sqrt((1 / 4 + 1) * np.var(d, ddof=1))
    assert t == pytest.approx(expected_t)
    assert p == pytest.approx(2 * stats.t.sf(expected_t, df=3))


def fold_table(auc, brier, ece, seed=0):
    rng = np.random.default_rng(seed)
    rows = []
    for model in config.CANDIDATES:
        for repeat in range(5):
            for fold in range(5):
                rows.append({"model": model, "repeat": repeat, "fold": fold,
                             "roc_auc_person": auc[model] + rng.normal(0, 0.01),
                             "brier_person": brier[model] + rng.normal(0, 0.005), "ece_person": ece[model]})
    return pd.DataFrame(rows)


SAME = {m: 0.7 for m in config.CANDIDATES}


def test_selection_clear_winner_on_auc():
    table = fold_table({**SAME, "xgboost": 0.9}, {m: 0.2 for m in config.CANDIDATES}, {m: 0.05 for m in config.CANDIDATES})
    chosen, record, _ = compare.select(table, n_train=200, n_test=50)
    assert chosen == "xgboost" and "roc_auc_person" in record[0]


def test_selection_auc_tie_resolved_by_brier():
    table = fold_table(SAME, {**{m: 0.2 for m in config.CANDIDATES}, "svm": 0.1}, {m: 0.05 for m in config.CANDIDATES})
    chosen, record, _ = compare.select(table, n_train=200, n_test=50)
    assert chosen == "svm" and record[1].startswith("brier_person")


def test_selection_full_tie_goes_to_the_simplest_model():
    table = fold_table(SAME, {m: 0.2 for m in config.CANDIDATES}, {m: 0.05 for m in config.CANDIDATES})
    chosen, record, _ = compare.select(table, n_train=200, n_test=50)
    assert chosen == "logistic_regression" and "simplicity level reached" in record[-1]


def test_simplicity_level_uses_measured_dependencies_and_size_not_just_the_order():
    table = fold_table(SAME, {m: 0.2 for m in config.CANDIDATES}, {m: 0.05 for m in config.CANDIDATES})
    # Measured sizes overturn the expected order among the scikit-learn-only models;
    # xgboost is smallest but needs an extra dependency, so it still loses.
    sizes = {"logistic_regression": 9000, "svm": 3000, "random_forest": 50000, "xgboost": 1000}
    table["artifact_bytes"] = table["model"].map(sizes)
    chosen, record, _ = compare.select(table, n_train=200, n_test=50)
    assert chosen == "svm"
    assert "deps=['scikit-learn', 'xgboost']" in record[-1] and "3000 B" in record[-1]


def test_all_four_real_candidates_run_end_to_end():
    data = synthetic(n_subjects=45)
    folds = splits.make_folds(data, n_folds=3, n_repeats=1)
    results = cv.run_cv(data, folds, FEATURES, progress=lambda *_: None)
    fm = results["fold_metrics"]
    assert set(fm.model) == set(config.CANDIDATES) and set(fm.variant) == {"baseline", "tuned"}
    assert fm["roc_auc_person"].between(0, 1).all()
    assert len(results["oof_predictions"]) == len(data) * len(config.CANDIDATES) * 2


def test_saved_model_reloads_with_identical_predictions(tmp_path):
    data = synthetic()
    model, _ = final.fit_final(data, FEATURES, "logistic_regression")
    final.save(model, final.build_metadata("logistic_regression", FEATURES, model), tmp_path)
    reloaded, meta = final.load(tmp_path)
    X = np.asarray(data[FEATURES], float)
    assert np.array_equal(model.predict_proba(X), reloaded.predict_proba(X))
    assert meta["features"] == FEATURES and meta["model"] == "logistic_regression"


def test_script_exits_while_its_inputs_are_missing(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "FEATURE_RESULTS", tmp_path)
    script = Path(__file__).resolve().parents[2] / "scripts" / "04_train.py"
    with pytest.raises(SystemExit, match="can't run yet"):
        runpy.run_path(str(script), run_name="__main__")


def test_training_uses_only_the_features_the_checks_kept():
    script = Path(__file__).resolve().parents[2] / "scripts" / "04_train.py"
    kept_features = runpy.run_path(str(script))["kept_features"]
    final_list = pd.DataFrame({"feature": ["a", "b", "c"], "kept": [True, False, True],
                               "reason": ["", "redundant with a", ""]})
    assert kept_features(final_list) == ["a", "c"]


def test_calibration_never_reverses_the_ranking():
    from mzazi_acoustic.model_training import calibration as cal
    rng = np.random.default_rng(0)
    y = rng.integers(0, 2, 300)
    w = np.ones(300)
    # Scores that run against the labels: an unconstrained fit would give a negative slope.
    slope, intercept = cal.fit_sigmoid(-(y + rng.normal(0, 0.5, 300)), y, w)
    assert slope == 0.0
    assert 1 / (1 + np.exp(-intercept)) == pytest.approx(y.mean())  # base rate
    # Scores that agree with the labels keep their positive slope.
    slope, _ = cal.fit_sigmoid(y + rng.normal(0, 0.5, 300), y, w)
    assert slope > 0
