"""Shared, declarative configuration for the acoustic-model pipeline.

Kept free of logic so every later phase (preprocessing, feature
engineering, training, ...) can import these constants without pulling
in behavior it doesn't need.
"""

from pathlib import Path

# acoustic-model/ (two levels up from this file: src/acoustic_model/config.py)
PROJECT_ROOT = Path(__file__).resolve().parents[2]

DATA_ROOT = PROJECT_ROOT / "data" / "extracted_audio_dataset"
# Preprocessed (trimmed, resampled) audio written by preprocessing.py. Lives under
# data/, so it inherits data/'s existing git-ignore - processed audio is exactly as
# sensitive as the raw audio it's derived from and must never be committed either.
PROCESSED_DATA_ROOT = PROJECT_ROOT / "data" / "processed"
RESULTS_DIR = PROJECT_ROOT / "results"
AUDIT_RESULTS_DIR = RESULTS_DIR / "audit"
PREPROCESSING_RESULTS_DIR = RESULTS_DIR / "preprocessing"
SPLITS_RESULTS_DIR = RESULTS_DIR / "splits"
FEATURES_RESULTS_DIR = RESULTS_DIR / "features"
FEATURE_SELECTION_RESULTS_DIR = RESULTS_DIR / "feature_selection"

# Raw on-disk class folders and the label each merges into.
#
# nodementia and nodementia2 are merged into a single "no_dementia"
# negative class per the project owner's decision: the two folders
# were populated at different times but represent the same DementiaNet
# no-dementia cohort, and 16 subject names are known to overlap between
# them, so treating them as separate classes would both misrepresent
# the label space and risk the same subject appearing under two
# different "classes."
RAW_CLASS_DIRS = ("dementia", "nodementia", "nodementia2")
CLASS_LABEL_MAP = {
    "dementia": "dementia",
    "nodementia": "no_dementia",
    "nodementia2": "no_dementia",
}

# Used only for stable, reproducible ordering (e.g. subject_id
# assignment) - the audit itself makes no random draws, but later
# phases (splitting, CV, model fitting) import this same seed so the
# whole pipeline is reproducible from one place.
RANDOM_SEED = 42

# Expected raw audio format, per the manual format inspection carried
# out during dataset exploration (all sampled files were genuine
# RIFF/WAVE PCM). Any file that doesn't match is flagged by the audit,
# not silently accepted.
EXPECTED_SAMPLE_WIDTH_BYTES = 2  # 16-bit PCM
EXPECTED_CHANNELS = 2  # stereo
EXPECTED_SAMPLE_RATE_HZ = 44100

# Phase 2 preprocessing defaults. Each is a reasonable, documented engineering
# default rather than a re-litigated product decision - easy to revisit by changing
# one constant and rerunning scripts/run_preprocessing.py, not baked in irreversibly.

# 16kHz mono is standard practice for speech-processing pipelines (matches the
# discarded prior attempt's own choice, and Kaldi/wav2vec/Whisper-family norms).
# It is comfortably above the Nyquist rate needed for F0-based jitter/shimmer
# (fundamental frequency for adult speech is well under 500Hz) and keeps enough of
# the harmonic structure HNR estimation needs, while normalizing away the raw
# dataset's inconsistent source rates/channel counts.
TARGET_SAMPLE_RATE_HZ = 16000
TARGET_CHANNELS = 1

# Threshold (dB below peak) for librosa.effects.trim's leading/trailing
# silence removal. 30dB is a moderate setting: aggressive enough to strip
# clear silence/near-silence padding, conservative enough not to clip quiet
# speech onsets/offsets that still carry usable signal.
SILENCE_TRIM_TOP_DB = 30

# Minimum post-trim duration for a file to be usable. Voice-quality measures
# (jitter, shimmer, F0-based HNR) need multiple pitch periods of sustained,
# reasonably stable voicing to estimate reliably; a handful of seconds is the
# common floor in the voice-science literature for automatic (non-sustained-vowel)
# extraction from continuous speech. This is the criterion that resolves
# subj_063_f01 (and any other short file) - decided from measured post-trim
# duration, not from format alone. Revisit if Phase 3 feature extraction turns
# out to need more (or can tolerate less).
MIN_USABLE_DURATION_SECONDS = 3.0

# Fraction of subjects held out as the final, locked test set (Phase 2), leaving
# the remainder as the train pool that later phases cross-validate over (subject-
# aware/grouped CV substitutes for a separate fixed validation split - see the
# 12-phase list in acoustic-model-dev-log.md). 20% is a standard default for a
# dataset this size (~215 subjects): large enough for a meaningful locked
# evaluation (~43 subjects), small enough to leave a usable CV pool.
TEST_SET_FRACTION = 0.2

# Phase 3 feature extraction. eGeMAPSv02 (Eyben et al. 2016), extracted via
# opensmile - a peer-reviewed, purpose-built minimal feature set for
# paralinguistic/health speech classification, chosen over hand-picking
# individual Praat measures so Phase 4 (feature selection) does the pruning
# from an already-validated set rather than an arbitrarily assembled one.
# Confirmed with the user 2026-09-15.
EGEMAPS_FEATURE_COUNT = 88  # sanity-checked against a real extraction, not assumed

# The three eGeMAPS functionals most directly comparable to the jitter/shimmer/HNR
# measures named in the spec, used for the channel-quality cross-check (mitigation
# 2 in ml-development-spec.md section 10): are these voice-quality features
# themselves correlated with the Phase 1 channel-quality proxies below?
VOICE_QUALITY_CROSS_CHECK_COLUMNS = (
    "jitterLocal_sma3nz_amean",
    "shimmerLocaldB_sma3nz_amean",
    "HNRdBACF_sma3nz_amean",
)
# Per-file channel-quality proxies computed in Phase 1 (audit.py/channel_quality.py),
# stored in results/audit/file_manifest.csv and joined in by file_id for the
# cross-check - not recomputed, so the comparison is against the exact values that
# produced Phase 1's original confound finding.
CHANNEL_QUALITY_PROXY_COLUMNS = ("noise_floor_db", "spectral_bandwidth_hz", "spectral_flatness")

# Threshold for flagging a pair of eGeMAPS features as "highly correlated" in the
# multicollinearity check that closes out Phase 3's EDA-absorption scope. 0.9 is a
# common, conservative convention for "these two features are near-redundant" (vs.
# 0.7-0.8, which is common but much more permissive) - deliberately conservative so
# the flagged list is a small, high-confidence set worth Phase 4/8's attention, not
# a large list diluted by moderate, unremarkable correlations.
HIGH_CORRELATION_THRESHOLD = 0.9

# Phase 4 feature selection (ml-development-spec.md section 4b): Random Forest
# permutation importance, applied uniformly to select one feature subset used to
# train all four section-7 candidates in Phase 5 - not a per-model selection.

# Number of subject-aware (StratifiedGroupKFold) CV folds used both to rank
# features by permutation importance and to choose k via CV score. 5 is a standard
# default; with 172 train_pool subjects this gives ~34 subjects per fold, small but
# workable given the class split (67 dementia / 105 no_dementia).
FEATURE_SELECTION_CV_FOLDS = 5

# Candidate feature-subset sizes evaluated for the CV-tuned stopping rule (a fixed
# k the student would otherwise have to defend as a guess is avoided - see the
# spec). 88 (all features) is included as the upper-bound comparison point.
FEATURE_SELECTION_CANDIDATE_K_VALUES = (5, 10, 15, 20, 30, 45, 60, 88)

# Random Forest hyperparameters used for the selector itself (not the Phase 5
# candidate model of the same name, though the two may end up similar).
# class_weight="balanced" accounts for the train_pool's 67/105 class imbalance.
# n_estimators=500 is large enough for stable permutation-importance estimates.
FEATURE_SELECTION_RF_N_ESTIMATORS = 500

# Permutation-importance repeats per fold - averaged to reduce the noise inherent
# in randomly shuffling a column and remeasuring performance once.
PERMUTATION_IMPORTANCE_N_REPEATS = 10

# Phase 5 baseline models (ml-development-spec.md section 7 candidates, section 8b
# evaluation methodology): Logistic Regression, Random Forest, SVM, XGBoost, trained
# on the fixed 20-feature subset selected in Phase 4.

BASELINE_MODELS_RESULTS_DIR = RESULTS_DIR / "baseline_models"

# Reuses the exact same subject-aware CV shape Phase 4 used (n_splits, shuffle,
# random_state, applied to train_pool in the same row order) rather than a separately
# declared constant of the same value - this is deliberate, not just economy: it
# means each numbered fold in Phase 5 holds out the same subjects Phase 4's
# same-numbered fold did, so the fixed 20-feature subset (whose out-of-fold
# permutation importance was computed on exactly those held-out subjects) is being
# evaluated on data structured the same way it was selected on.
BASELINE_MODEL_CV_FOLDS = FEATURE_SELECTION_CV_FOLDS

# Random Forest candidate hyperparameters. Independently declared from the Phase 4
# selector RF of the same name (the config module docstring in feature_selection.py
# notes they may end up similar, not that they're shared) - class_weight="balanced"
# and n_estimators=500 for the same reasons as the selector: accounts for
# train_pool's 67/105 imbalance, large enough for stable predictions.
BASELINE_RF_N_ESTIMATORS = 500

# XGBoost candidate hyperparameters. XGBoost has no "balanced" class-weight option,
# so scale_pos_weight is computed per CV fold from that fold's own training-portion
# class counts (negative/positive) rather than fixed here, mirroring what
# class_weight="balanced" does for the other three candidates.
BASELINE_XGB_N_ESTIMATORS = 300

# Fixed specificity operating point for the sensitivity-at-fixed-specificity
# secondary metric (Phase 5 design decision, 2026-09-16- see ml-development-spec.md
# section 8b): read directly off each fold's ROC curve, no threshold optimization
# involved. 90% is a conventional screening-context reference point, not a settled
# product decision - this project has not yet decided whether the eventual locked
# threshold should prioritize sensitivity over precision (see section 8b) - it is
# simply a fixed, reproducible point reported alongside Youden's J for whoever makes
# that decision later.
BASELINE_FIXED_SPECIFICITY_TARGET = 0.90

# Bin count for the pooled out-of-fold calibration curve and Expected Calibration
# Error. 10 matches sklearn's calibration_curve default and is the standard
# convention for this diagnostic.
CALIBRATION_N_BINS = 10

# Phase 6 hyperparameter tuning (ml-development-spec.md section 9b): two-stage
# nested CV, reusing Phase 4/5's exact outer folds. Justified by Varma & Simon
# (2006, BMC Bioinformatics 7:91) - single-level CV for model selection is
# optimistically biased; nested CV corrects it. See section 9b for the full
# reasoning and the verification performed on that citation.

TUNING_RESULTS_DIR = RESULTS_DIR / "hyperparameter_tuning"

# Outer CV: identical to Phase 4/5's fold structure (not a separately-valued
# constant) - every numbered fold across Phases 4/5/6 holds out the same subjects.
TUNING_OUTER_CV_FOLDS = FEATURE_SELECTION_CV_FOLDS

# Inner CV: 3-fold, not 5 - an explicitly-decided choice (section 9b), not a
# default. Outer-training folds are already only ~137-138 subjects; a 5-fold
# inner split would leave ~27-28 subjects per inner-validation fold, too small
# and noisy to trust for picking a hyperparameter configuration.
TUNING_INNER_CV_FOLDS = 3

# RandomizedSearchCV budget per stage - small, fixed, and identical across all
# four candidates (the "same budget, no model favored" design decision). Stage 2
# is deeper than Stage 1, consistent with Stage 1 being a coarse screening pass.
TUNING_STAGE1_N_ITER = 15
TUNING_STAGE2_N_ITER = 40

# The final full-train_pool lock-in step (section 9b) reuses whichever stage's
# budget a model last went through - no separate constant needed for it.

# Phase 7 calibration (ml-development-spec.md section 9c): manual cross_val_predict
# + _SigmoidCalibration calibrator (CalibratedClassifierCV(ensemble=False) doesn't
# actually route subject groups in scikit-learn==1.9.1 - verified, see section 9c),
# applied uniformly to Phase 6's surviving candidates on their locked hyperparameters.

CALIBRATION_RESULTS_DIR = RESULTS_DIR / "calibration"

# Outer CV: identical to Phase 4/5/6's fold structure - every numbered fold across
# every phase holds out the same subjects.
CALIBRATION_OUTER_CV_FOLDS = FEATURE_SELECTION_CV_FOLDS

# Inner CV for the calibration-fitting step: 5-fold, not Phase 6's 3-fold - Phase 7
# has no repeated hyperparameter search driving compute cost (one calibration fit
# per outer fold per model, not hundreds), so a more stable 5-fold out-of-fold
# score estimate is affordable.
CALIBRATION_INNER_CV_FOLDS = 5

# Family size for the Bonferroni correction across the 3 pairwise Brier
# comparisons among Phase 6's surviving candidates (flat/naive, matching the
# convention already used in Phases 1 and 3 - never Holm-Bonferroni).
CALIBRATION_BRIER_COMPARISON_FAMILY_SIZE = 3

# Phase 8 interpretability (ml-development-spec.md section 9d): permutation
# importance only, never SHAP - the locked SVM candidate is a hardcoded
# SVC(kernel="rbf", ...) (baseline_models.py's _make_pipeline(), never tuned to
# linear), so it has no exact/fast SHAP path, only slow/approximate KernelSHAP;
# using SHAP here would confound genuine model behavior with unequal
# explanation quality across model types in a comparison whose whole point is
# judging relative reliance. Computed on Phase 6/7's three surviving,
# calibrated candidates to produce confound_reliance_share - Phase 8's
# tie-break for Phase 7's inconclusive calibrated-Brier three-way comparison.

INTERPRETABILITY_RESULTS_DIR = RESULTS_DIR / "interpretability"

# The one Phase-4-selected feature related to the Phase 1/3 channel-confound
# triangle - NOT "shimmer/jitter" (a corrected characterization, section 9d):
# shimmerLocaldB_sma3nz_amean, the triangle's only *confirmed* channel-entangled
# column, was never selected into the 20 features, so no candidate can be said
# to lean on it. This jitter functional (variability of jitter) is a different
# statistic than jitterLocal_sma3nz_amean, the one Phase 3 actually tested
# against a channel proxy - tracked here as a due-diligence relative of a known
# risk, not a confirmed confound itself.
CONFOUND_FEATURE = "jitterLocal_sma3nz_stddevNorm"

# Outer CV: identical to Phase 4/5/6/7's fold structure - every numbered fold
# across every phase holds out the same subjects.
INTERPRETABILITY_OUTER_CV_FOLDS = FEATURE_SELECTION_CV_FOLDS

# Permutation-importance repeats per fold, computed on that fold's held-out
# portion only (~70-75 files, smaller than Phase 4's held-out folds) - higher
# than Phase 4's PERMUTATION_IMPORTANCE_N_REPEATS (10) since this number feeds
# a paired significance test between three already-close candidates and needs
# its own per-fold noise reduced before it reaches that comparison.
INTERPRETABILITY_PERMUTATION_N_REPEATS = 30

# Family size for the Bonferroni correction across the 3 pairwise
# confound_reliance_share comparisons - the same 3-candidate family (XGBoost/
# Random Forest/SVM) as Phase 7's own Brier comparison, reused rather than
# redeclared with the same value under a different name.
INTERPRETABILITY_COMPARISON_FAMILY_SIZE = CALIBRATION_BRIER_COMPARISON_FAMILY_SIZE

# Phase 9 domain-shift robustness testing (ml-development-spec.md section 9e):
# CV-fold synthetic degradation (bandpass + noise) applied to validation-fold
# audio only, on Phase 8's single selected candidate (XGBoost) - Phase 8 already
# resolved model selection, so this is a robustness check on that one model, not
# a re-opening of model choice.

ROBUSTNESS_RESULTS_DIR = RESULTS_DIR / "domain_shift_robustness"

# The one candidate this phase tests - Phase 8's final model selection.
ROBUSTNESS_MODEL_NAME = "xgboost"

# Outer CV: identical to Phase 4/5/6/7/8's fold structure - every numbered fold
# across every phase holds out the same subjects.
ROBUSTNESS_OUTER_CV_FOLDS = FEATURE_SELECTION_CV_FOLDS

# Bandpass range: smartphone microphone recording bandwidth, not telephone/PSTN
# bandwidth (300-3400Hz) - the deployment scenario (README.md) is a caregiver's
# phone microphone recording directly via an app, not a telephone call, so this
# is the scenario-faithful simulation (section 9e).
ROBUSTNESS_BANDPASS_LOW_HZ = 100
ROBUSTNESS_BANDPASS_HIGH_HZ = 7000

# 4th-order Butterworth is a standard, conservative default for this kind of
# band-limiting simulation - sharp enough to meaningfully restrict the band,
# gentle enough not to introduce its own severe ringing artifacts. A
# well-justified default, not asked as a question, open to objection like
# Phase 7's sigmoid-vs-isotonic choice.
ROBUSTNESS_BANDPASS_FILTER_ORDER = 4

# Both noise types are tested, not one - see section 9e for why (a general
# noise-sensitivity finding vs. one specifically tied to the F0/harmonic
# frequency range this project already has independent reason to worry about).
ROBUSTNESS_NOISE_TYPES = ("white", "pink")

# Both severity levels are tested, not one - moderate (20dB) and severe (10dB).
ROBUSTNESS_SNR_LEVELS_DB = (20, 10)

# The single pre-registered worst-case condition (section 9e) for Phase 9's one
# formal significance test - decided before any condition was run, not picked
# after seeing results: pink noise concentrates energy in the low-to-mid
# frequencies overlapping F0/harmonic structure (where jitter/shimmer/HNR draw
# their signal), and 10dB is the more severe of the two SNR levels tested.
ROBUSTNESS_WORST_CASE_NOISE_TYPE = "pink"
ROBUSTNESS_WORST_CASE_SNR_DB = 10
