"""The four candidate pipelines and their tuning search (PLAN.md 4.1-4.2).

Every candidate is StandardScaler + model in one Pipeline, so scaling is learned inside each
training fold only. Weights are routed with scikit-learn metadata routing: the model and the
tuning scorer request sample_weight, the scaler explicitly does not (an unweighted scaler is the
plain, pre-registered choice; weighting it would change nothing the model can't absorb).
Routing is switched on only inside `routing()`, so the setting never leaks into other code.
"""

import sklearn
from scipy import stats
from sklearn.ensemble import RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import get_scorer
from sklearn.model_selection import RandomizedSearchCV, StratifiedGroupKFold
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC
from xgboost import XGBClassifier

from mzazi_acoustic.common import config


SEARCH_N_JOBS = -1  # all cores for the inner search; tests set 1 so spies see every fit and score


def routing():
    """Context manager: metadata routing on, for building and fitting anything in this package."""
    return sklearn.config_context(enable_metadata_routing=True)


def new_model(name, seed):
    if name == "logistic_regression":
        return LogisticRegression(max_iter=5000)  # L2 is the default penalty
    if name == "random_forest":
        return RandomForestClassifier(n_estimators=config.N_TREES, random_state=seed, n_jobs=-1)
    if name == "svm":
        return SVC(kernel="rbf")  # probability=False: scores come from decision_function
    if name == "xgboost":
        return XGBClassifier(n_estimators=config.N_TREES, tree_method="hist", random_state=seed, n_jobs=-1,
                             eval_metric="logloss")
    raise ValueError(f"unknown candidate {name}")


def make_pipeline(name, seed):
    """Call inside routing().

    Median imputation comes first: some features are undefined for some clips (e.g. median pause
    length with no pauses), and imputation is a learned step, so it must be fit inside the fold.
    PLAN.md 3.3 step 1 may replace this choice once the real missingness is known.
    """
    return Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler().set_fit_request(sample_weight=False)),
        ("model", new_model(name, seed).set_fit_request(sample_weight=True)),
    ])


def search_space(name):
    """config.SEARCH_SPACES turned into scipy distributions, keyed for the Pipeline's model step."""
    space = {}
    for param, spec in config.SEARCH_SPACES[name].items():
        if isinstance(spec, list):
            space[f"model__{param}"] = spec
        elif spec[0] == "log":
            space[f"model__{param}"] = stats.loguniform(spec[1], spec[2])
        elif spec[0] == "int":
            space[f"model__{param}"] = stats.randint(spec[1], spec[2] + 1)
        elif spec[0] == "uniform":
            space[f"model__{param}"] = stats.uniform(spec[1], spec[2] - spec[1])
    return space


def person_weighted_auc():
    """ROC-AUC with sample weights. The training weights also balance the classes, but ROC-AUC is
    unchanged by scaling one class's weights, so this equals the person-weighted ROC-AUC."""
    return get_scorer("roc_auc").set_score_request(sample_weight=True)


def inner_splitter(seed):
    return StratifiedGroupKFold(n_splits=config.INNER_CV_FOLDS, shuffle=True, random_state=seed)


def make_search(name, seed):
    """Call inside routing(). Fit with .fit(X, y, sample_weight=..., groups=...)."""
    return RandomizedSearchCV(make_pipeline(name, seed), search_space(name), n_iter=config.SEARCH_CONFIGS_PER_MODEL,
                              scoring=person_weighted_auc(), cv=inner_splitter(seed), random_state=seed,
                              n_jobs=SEARCH_N_JOBS, refit=True)


def scores(pipeline, X):
    """Uncalibrated scores: decision_function where the model has one (LR, SVM), else P(class 1)."""
    if hasattr(pipeline, "decision_function"):  # Pipeline only exposes it if the model has it
        return pipeline.decision_function(X)
    return pipeline.predict_proba(X)[:, 1]
