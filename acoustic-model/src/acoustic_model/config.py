"""Shared, declarative configuration for the acoustic-model pipeline.

Kept free of logic so every later phase (preprocessing, feature
engineering, training, ...) can import these constants without pulling
in behavior it doesn't need.
"""

from pathlib import Path

# acoustic-model/ (two levels up from this file: src/acoustic_model/config.py)
PROJECT_ROOT = Path(__file__).resolve().parents[2]

DATA_ROOT = PROJECT_ROOT / "data" / "extracted_audio_dataset"
RESULTS_DIR = PROJECT_ROOT / "results"
AUDIT_RESULTS_DIR = RESULTS_DIR / "audit"

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
