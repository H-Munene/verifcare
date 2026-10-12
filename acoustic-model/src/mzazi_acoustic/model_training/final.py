"""Final fit on the whole training portion, saving and loading (PLAN.md 4.2 steps 6-7).

The final model is refit with the same inner grouped search and calibration as in CV. Its own
search score is a selection score only, never reported as performance.
"""

import json
from datetime import date
from importlib import metadata as package_metadata

import joblib

from mzazi_acoustic.common import config
from mzazi_acoustic.model_training.cv import fit_calibrated

PACKAGES = ["numpy", "scipy", "scikit-learn", "xgboost", "pandas", "opensmile", "soundfile", "soxr", "joblib"]
# config values the saved model depends on: features are only comparable if extracted identically.
EXTRACTION_PREFIXES = ("TARGET_SAMPLE_RATE", "MIN_DURATION", "MAX_DURATION", "TRIM_", "FRAME_", "HOP_",
                       "SPEECH_LEVEL", "SILENCE_", "NOISE_LEVEL", "NOISE_MARGIN", "MIN_PAUSE", "MIN_SPEECH",
                       "LONG_PAUSE")


def fit_final(training, feature_cols, name):
    model, log = fit_calibrated(name, "tuned", training[feature_cols], training["label"], training["subject_id"],
                                config.SEED)
    return model, log


def build_metadata(model_name, feature_cols, model):
    extraction = {k: getattr(config, k) for k in dir(config) if k.startswith(EXTRACTION_PREFIXES)}
    return {
        "model": model_name,
        "features": list(feature_cols),
        "best_params": {k: str(v) for k, v in model.pipeline.named_steps["model"].get_params().items()},
        "calibration": {"slope": model.slope, "intercept": model.intercept},
        "extraction_parameters": extraction,
        "cv_design": {"folds": config.CV_FOLDS, "repeats": config.CV_REPEATS, "inner_folds": config.INNER_CV_FOLDS,
                      "search_configs_per_model": config.SEARCH_CONFIGS_PER_MODEL},
        "seed": config.SEED,
        "trained_on": date.today().isoformat(),
        "package_versions": {p: package_metadata.version(p) for p in PACKAGES},
    }


def save(model, meta, directory=config.MODELS_DIR):
    directory.mkdir(parents=True, exist_ok=True)
    joblib.dump(model, directory / "acoustic_model.joblib")
    (directory / "metadata.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")


def load(directory=config.MODELS_DIR):
    model = joblib.load(directory / "acoustic_model.joblib")
    meta = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
    return model, meta
