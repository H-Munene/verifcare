"""Every path, seed and tunable constant for the acoustic model, each with its reason.

Constants that PLAN.md says must be fixed before looking at class labels
(minimum duration, pause-detector settings) are marked "pre-registered".
Changing one of those later needs a dated entry in docs/ml-dev-log.md.
"""

from pathlib import Path

# ---------------------------------------------------------------- paths

PROJECT_ROOT = Path(__file__).resolve().parents[3]  # .../acoustic-model
DATA_DIR = PROJECT_ROOT / "data"  # git-ignored
RAW_DIR = DATA_DIR / "raw"  # original audio, never modified
DATASET_DIR = RAW_DIR / "extracted_audio_dataset"  # DementiaNet, as downloaded
PROCESSED_DIR = DATA_DIR / "processed"
LISTENING_AUDIT_DIR = DATA_DIR / "listening_audit"  # blinded copies for the human audit

# Local-only because the paths contain real names. Lives under data/ so it can never be committed.
RAW_FREEZE_FILE = DATA_DIR / "raw_data_freeze.csv"
# Secret salt for subject IDs. Without it, an ID could be reversed by hashing a list of public names.
SUBJECT_ID_SALT_FILE = DATA_DIR / "subject_id_salt.txt"

RESULTS_DIR = PROJECT_ROOT / "results"
COLLECTION_RESULTS = RESULTS_DIR / "01_data_collection"
PROCESSING_RESULTS = RESULTS_DIR / "02_data_processing"
FEATURE_RESULTS = RESULTS_DIR / "03_feature_engineering"
TRAINING_RESULTS = RESULTS_DIR / "04_model_training"
EVALUATION_RESULTS = RESULTS_DIR / "05_model_evaluation"
MODELS_DIR = PROJECT_ROOT / "models"

# ---------------------------------------------------------------- reproducibility

SEED = 42  # one global seed; every random step derives from it

# ---------------------------------------------------------------- Stage 1: data collection

# Mapping from top-level folder to class label (1 = cognitive decline).
FOLDER_TO_LABEL = {
    "dementia": 1,
    "nodementia": 0,
    "nodementia2": 0,
}
LABEL_NAMES = {1: "dementia", 0: "no_dementia"}

# Two normalised names at least this similar (difflib ratio) are flagged for manual review,
# never merged automatically. 0.85 catches one or two typos in a typical full name
# ("jimmycalderwood" vs "jimycalderwood" = 0.97) without flagging unrelated names.
NEAR_DUPLICATE_NAME_RATIO = 0.85

# Channel-quality proxies. 25 ms frames match the pause detector's frame length.
PROXY_FRAME_SECONDS = 0.025
# The quietest 10 % of frames stand in for "no speech". Documented circularity: in speech,
# the quietest frames are mostly pauses, so these proxies are coupled to pausing (PLAN.md 3.3).
PROXY_QUIET_PERCENTILE = 10
# Bandwidth = frequency below which this share of long-term spectral energy lies.
# 99 % picks up codec low-pass cut-offs (e.g. 4 kHz for 8 kHz telephone audio).
PROXY_BANDWIDTH_ENERGY_SHARE = 0.99

# Listening audit: about 20 recordings, stratified by class (PLAN.md Stage 1 step 10).
LISTENING_AUDIT_PER_CLASS = 10

# Confirmed by the developer at Checkpoint 1 (2026-09-28): the mapping above is correct.

# DementiaNet metadata sheet (linked from the upstream README), one tab per class. Downloaded to
# data/ because it holds real names; used for age at recording (decision D6).
METADATA_SHEET_ID = "1ih3FjEsiKDctS2oFhZKXah-OrzEridgUDHKu2awXSx8"
METADATA_TABS = {"dementia": "628190327", "no_dementia": "1338555640"}
METADATA_FILES = {name: DATA_DIR / f"dementianet_metadata_{name}.csv" for name in METADATA_TABS}

# ---------------------------------------------------------------- Stage 2: data processing

TARGET_SAMPLE_RATE = 16_000  # standard for speech; eGeMAPS is validated at 16 kHz

# Pre-registered 2026-09-28, before any durations were measured.
# At typical spontaneous-speech rates, 30 s of speech gives roughly 10 or more pauses longer than
# 180 ms, enough for a usable median pause duration. It is also a deployment requirement:
# the app must capture at least 30 s of speech after trimming (PLAN.md Stage 2 step 3).
MIN_DURATION_SECONDS = 30.0

# Edge trimming (PLAN.md Stage 2 step 2). Frozen 2026-09-28 and NEVER adjusted, deliberately
# independent of the pause detector: the detector may be tuned against the developer's annotations,
# and that must not move the 30 s minimum or the split. Rule: keep from the first to the last frame
# whose RMS level is within TRIM_DB_BELOW_REFERENCE of the file's 99th-percentile level.
# 30 dB is 5 dB wider than the detector's 25 dB silence rule, so trimming is the more conservative
# of the two: it keeps weak speech onsets (often 20-25 dB below vowel peaks) and only removes clearly
# silent edges. In noisy files nothing may fall below it, and then nothing is trimmed, which never
# cuts speech.
TRIM_FRAME_SECONDS = 0.025
TRIM_HOP_SECONDS = 0.010
TRIM_REFERENCE_PERCENTILE = 99
TRIM_DB_BELOW_REFERENCE = 30.0

# Pre-registered 2026-09-28 (Checkpoint 1), before any feature extraction: keep only the first 90 s
# after trimming, in both classes. DementiaNet clips are capped at 90 s, a cap only dementia clips
# exceed, so without this, maximum length would differ by class (PLAN.md Stage 2 step 3).
MAX_DURATION_SECONDS = 90.0

# ---------------------------------------------------------------- Stage 3: pause detector
# All pre-registered 2026-09-28, before any class labels were looked at.
# They may be changed only against the manual pause annotations (PLAN.md 3.2), never against labels.

FRAME_SECONDS = 0.025  # 25 ms analysis window (PLAN.md 3.2)
HOP_SECONDS = 0.010  # 10 ms hop, so pause durations are resolved to 10 ms

# Speech level = this percentile of the file's frame intensity (dB). The 0.99 quantile is the
# reference in the 2010 update of De Jong & Wempe's syllable-nuclei script (it ignores rare
# non-speech bursts). A percentile of the file's own intensity makes the result gain-independent.
SPEECH_LEVEL_PERCENTILE = 99
# Frames more than this far below the speech level count as silent. 25 dB is the same script's
# value and Praat's standard setting for detecting silences.
SILENCE_DB_BELOW_SPEECH = 25.0

# Noise guard. In noisy recordings (speech less than ~31 dB above the noise), "25 dB below speech"
# lands under the noise floor, so no pause is ever detected and pause features end up measuring the
# noise. The threshold is therefore raised to at least this many dB above the noise level.
# In clean recordings this guard is inactive and the rule above applies unchanged.
NOISE_LEVEL_PERCENTILE = 5  # low enough to fall inside pauses even in dense speech
NOISE_MARGIN_DB = 6.0  # factor of 2 in amplitude, above typical frame-to-frame noise fluctuation

MIN_PAUSE_SECONDS = 0.080  # lower edge of He et al.'s short-pause band
# Sounding stretches shorter than this are treated as silence, so a click can't split one pause
# into two. 25 ms is the minimum speech duration of the SPA detector used by He et al. (2025).
MIN_SPEECH_SECONDS = 0.025

# Pause bands from He et al. (2025): short = 80-180 ms, long > 180 ms. The 180 ms edge was fitted
# on English picture-description data, so it is a literature constant, not a universal one.
# Fixed, never tuned.
LONG_PAUSE_SECONDS = 0.180

# Detector validation (PLAN.md 3.2). A detected pause matches an annotated one when both its
# start and end are within this tolerance. 40 ms covers about 20 ms of detector boundary
# uncertainty (25 ms window, 10 ms hop) plus about 20 ms of human boundary placement in a
# waveform editor.
BOUNDARY_TOLERANCE_SECONDS = 0.040
ANNOTATION_FILES = 10
ANNOTATION_SEGMENT_SECONDS = 60.0
ANNOTATION_SEGMENT_OFFSET_SECONDS = 10.0  # the segment starts 10 s after the trimmed start
# The segment must fit inside the kept (<= 90 s) audio: 10 s offset + 60 s = 70 s of trimmed audio.
ANNOTATION_MIN_TRIMMED_SECONDS = ANNOTATION_SEGMENT_OFFSET_SECONDS + ANNOTATION_SEGMENT_SECONDS
# Developer, 2026-09-28: the sample deliberately includes noisy-background clips, because the noise
# guard is the part of the detector most likely to fail. Of the 5 clips per class, this many are
# drawn from clips where the noise guard is active (speech-to-noise dynamic range under
# SILENCE_DB_BELOW_SPEECH + NOISE_MARGIN_DB = 31 dB), when enough such clips exist.
ANNOTATION_NOISY_PER_CLASS = 2
NOISE_GUARD_ACTIVE_BELOW_DB = SILENCE_DB_BELOW_SPEECH + NOISE_MARGIN_DB

# ---------------------------------------------------------------- gates (developer decisions)
# Code that depends on a pending human decision refuses to run until it is recorded here.
D1_DECISION = None  # "a" limitation / "b" speaker separation / "c" single-speaker only (HEZ-95)
DETECTOR_SIGNED_OFF = False  # set True only after the developer signs off the annotation agreement

# ---------------------------------------------------------------- Stage 3: frozen feature set
# PLAN.md 3.1, frozen 2026-09-28. Order matters: the redundancy and dependency rules in 3.3 keep the
# feature listed FIRST, so this order is the plan's order and must not be rearranged.
FAMILY_A_FEATURES = [
    "pause_rate_per_min", "mean_pause_s", "median_pause_s", "long_pause_rate_per_min",
    "long_pause_time_share", "phonation_time_ratio", "mean_speech_segment_s",
    "voiced_segments_per_s", "mean_voiced_segment_s", "sd_voiced_segment_s",
    "mean_unvoiced_segment_s", "sd_unvoiced_segment_s", "articulation_rate_proxy",
]
FAMILY_B_FEATURES = ["jitter_mean", "jitter_cv", "shimmer_db_mean", "shimmer_db_cv", "hnr_db_mean", "hnr_db_cv"]
MODEL_FEATURES = FAMILY_A_FEATURES + FAMILY_B_FEATURES
# eGeMAPSv02 functional (openSMILE) -> our name. loudnessPeaksPerSec is converted to the
# articulation-rate proxy (peaks per second of speech) in feature_engineering, not used raw.
EGEMAPS_COLUMNS = {
    "VoicedSegmentsPerSec": "voiced_segments_per_s",
    "MeanVoicedSegmentLengthSec": "mean_voiced_segment_s",
    "StddevVoicedSegmentLengthSec": "sd_voiced_segment_s",
    "MeanUnvoicedSegmentLength": "mean_unvoiced_segment_s",
    "StddevUnvoicedSegmentLength": "sd_unvoiced_segment_s",
    "loudnessPeaksPerSec": "loudness_peaks_per_s",
    "jitterLocal_sma3nz_amean": "jitter_mean",
    "jitterLocal_sma3nz_stddevNorm": "jitter_cv",
    "shimmerLocaldB_sma3nz_amean": "shimmer_db_mean",
    "shimmerLocaldB_sma3nz_stddevNorm": "shimmer_db_cv",
    "HNRdBACF_sma3nz_amean": "hnr_db_mean",
    "HNRdBACF_sma3nz_stddevNorm": "hnr_db_cv",
}

# ---------------------------------------------------------------- Stage 3.3: pre-stated check rules
REDUNDANCY_ABS_R = 0.9  # pairwise |r| >= this: keep the feature listed first
RANK_RELATIVE_TOLERANCE = 1e-8  # singular values below this x the largest count as zero
VIF_REPORT_THRESHOLD = 10.0  # reported only, never removed
DURATION_DEPENDENCE_ABS_R = 0.2  # per-subject |r| with trimmed duration above this is flagged
# Literature-expected direction with cognitive decline (PLAN.md 3.3 step 7), for the direction check.
EXPECTED_DIRECTION = {
    "pause_rate_per_min": "higher", "mean_pause_s": "higher", "median_pause_s": "higher",
    "long_pause_rate_per_min": "higher", "long_pause_time_share": "higher", "phonation_time_ratio": "lower",
}

# ---------------------------------------------------------------- degradation (Stage 3.3 and 5.1)

# Phone-like microphone band.
BANDPASS_LOW_HZ = 100.0
BANDPASS_HIGH_HZ = 7000.0
BANDPASS_ORDER = 4
NOISE_TYPES = ("white", "pink")
TARGET_SNRS_DB = (20.0, 10.0)

# Family A degradation flag rule (PLAN.md 3.3 step 4, decided 2026-09-28). A feature is flagged when
# its median shift under bandpass alone exceeds its own within-subject variation (the typical
# relative difference between one person's recordings). The benchmark needs enough multi-clip
# subjects to be stable; below this many, the fixed fallback tolerance is used instead.
MIN_SUBJECTS_FOR_WITHIN_SUBJECT_BENCHMARK = 20
# Updated at the Stage 2 review: the flag fires if the shift exceeds the benchmark OR this value,
# whichever is smaller, so 10 % is always a cap, not only the fallback. Flagging only.
FALLBACK_SHIFT_TOLERANCE = 0.10

# ---------------------------------------------------------------- Stage 4: model training
# Decided 2026-09-28 (Stage 2 review). Repeated CV, because a single 5-fold run with the corrected
# t-test would almost always call a tie; estimated ~18 min in total at this budget.
CV_FOLDS = 5
CV_REPEATS = 5  # each repeat uses seed SEED + repeat index
INNER_CV_FOLDS = 3
SEARCH_CONFIGS_PER_MODEL = 20  # equal budget for all four candidates
N_PAIRWISE_COMPARISONS = 6  # Bonferroni family: 4 candidates, all pairs
TEST_SUBJECT_SHARE = 0.20  # ~80/20 subject-level split, stratified by class (PLAN.md Stage 2)
CANDIDATES = ["logistic_regression", "random_forest", "svm", "xgboost"]
# Modest search spaces, written before any run (PLAN.md 4.2). ("log", low, high) = log-uniform,
# ("int", low, high) = integers inclusive, ("uniform", low, high), or a list = pick one.
# The same spaces were timed in the runtime benchmark (~18 min for 5 x 5 at 20 configs).
SEARCH_SPACES = {
    "logistic_regression": {"C": ("log", 1e-3, 1e2)},
    "random_forest": {"max_depth": [None, 3, 5, 8], "min_samples_leaf": ("int", 1, 9),
                      "max_features": ["sqrt", 0.5, 1.0]},
    "svm": {"C": ("log", 1e-2, 1e2), "gamma": ("log", 1e-3, 1.0)},
    "xgboost": {"max_depth": ("int", 2, 5), "learning_rate": ("log", 0.01, 0.3), "subsample": ("uniform", 0.6, 1.0),
                "colsample_bytree": ("uniform", 0.6, 1.0), "min_child_weight": ("int", 1, 9)},
}
N_TREES = 300  # random forest and xgboost; fixed, not searched
# Threshold-dependent metrics (PLAN.md 4.2): Youden's J per fold (labelled optimistic), and
# sensitivity at this fixed specificity.
FIXED_SPECIFICITY = 0.90
CALIBRATION_BINS = 10  # expected calibration error
