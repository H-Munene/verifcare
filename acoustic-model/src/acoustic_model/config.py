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
