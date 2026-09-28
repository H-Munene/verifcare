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

# PROPOSED mapping from top-level folder to class label (1 = cognitive decline).
# Pending the developer's confirmation at Checkpoint 1 (PLAN.md Stage 1 step 2).
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

# ---------------------------------------------------------------- Stage 2: data processing

TARGET_SAMPLE_RATE = 16_000  # standard for speech; eGeMAPS is validated at 16 kHz

# Pre-registered 2026-09-28, before any durations were measured.
# At typical spontaneous-speech rates, 30 s of speech gives roughly 10 or more pauses longer than
# 180 ms, enough for a usable median pause duration. It is also a deployment requirement:
# the app must capture at least 30 s of speech after trimming (PLAN.md Stage 2 step 3).
MIN_DURATION_SECONDS = 30.0

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

# ---------------------------------------------------------------- degradation (Stage 3.3 and 5.1)

# Phone-like microphone band.
BANDPASS_LOW_HZ = 100.0
BANDPASS_HIGH_HZ = 7000.0
BANDPASS_ORDER = 4
NOISE_TYPES = ("white", "pink")
TARGET_SNRS_DB = (20.0, 10.0)
