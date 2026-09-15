# Acoustic Model

## What this is

This directory holds the machine learning work behind the `acoustic-model` AWS Lambda described in `docs/architecture.md`.
That Lambda is invoked directly (Lambda-to-Lambda, not HTTP) by the `api` Lambda after a caregiver visit's audio is uploaded to S3.
It scores the audio for cognitive risk and returns a calibrated `[0,1]` probability.
`openapi.yaml` in this directory documents the draft request/response shape of that invocation; it is not a real HTTP API.
Nothing here is deployed yet - this is the model-development work that will eventually be packaged into that Lambda's container image.

## Dataset: DementiaNet

The raw dataset lives under `data/extracted_audio_dataset/` and is git-ignored, so it is not vendored in this repository.
It is the **DementiaNet** dataset, published at https://github.com/tuul-ai/dementianet under the MIT license.

Per its own README, DementiaNet contains audio for roughly 100 public figures with a confirmed dementia diagnosis and roughly 100 public figures over 80 (or who died over 90) with no signs of cognitive decline.
The audio was scraped from YouTube and deliberately limited to spontaneous interviews, explicitly excluding speeches, movie scenes, and any rehearsed or read material, to reduce the risk of an actor's performance being mistaken for their own speech patterns.
Dementia-class samples span from shortly after diagnosis back to roughly ten years before symptom onset.
No-dementia-class samples are three clips per person, at roughly five, ten, and fifteen years before death or the person's current age.

DementiaNet's own README does not link an academic paper, and states no explicit disclaimer against clinical or diagnostic use.
Both of those are real gaps in the dataset's documentation, not settled facts about its fitness for this purpose, and are recorded here rather than assumed away.

To obtain the dataset for local development, follow the instructions at the upstream repository linked above; it is not distributed through this repository.

## Local folder layout and filename conventions

On disk, the dataset has three raw class folders: `dementia`, `nodementia`, and `nodementia2`.
For modeling purposes, `nodementia` and `nodementia2` are merged into a single `no_dementia` negative class, because they represent the same DementiaNet no-dementia cohort populated at different times, and 16 subject names are known to overlap between them.
The audit pipeline (`src/acoustic_model/audit.py`) performs this merge and deduplicates subjects that appear in both folders.

Filenames encode a numeric suffix whose meaning differs by class, and the two schemes must never be conflated:

- In `dementia/`, the suffix (observed values: 0, 2, 5, 10, 15) approximates years relative to symptom onset, matching DementiaNet's stated sampling window for that class.
  Some subjects have a second sub-index (for example `_5_1` and `_5_2`) for multiple clips at the same marker.
- In `nodementia/` and `nodementia2/`, the suffix is always 1, 2, or 3: an index into DementiaNet's five/ten/fifteen-years-before-death-or-current-age scheme, not a literal year value.

## Known limitations

These are three distinct risks, each with a different mechanism and a different mitigation.
They are documented separately here deliberately, rather than combined into one generic "watch for bias" note, because conflating them would obscure what actually needs to be checked for each.

**Task-elicitation gap.**
DementiaNet's audio comes from naturalistic, spontaneous interviews.
Much of the published dementia-detection research (for example Mirheidari et al.) instead uses structured clinical elicitation tasks such as picture-description.
A model trained on naturalistic interview speech may pick up on cues specific to that task format that would not transfer to a different elicitation style.

**Archival-provenance sampling confound.**
Dementia-class subjects have fewer recordings available per person than no-dementia subjects, and skew toward older, more archival footage, simply because of how the underlying source material was collected.
A model could learn to associate "older or lower-quality recording" with "dementia" as a shortcut, rather than learning anything about the speaker's voice.

**Channel/signal mismatch.**
This dataset is broadcast- or YouTube-quality interview audio.
The deployed model will score audio captured on a caregiver's phone microphone in an uncontrolled home environment.
Jitter, shimmer, and harmonics-to-noise ratio - voice-quality features this project plans to use - are well documented in voice science as sensitive to recording-channel quality itself, not only to vocal-fold physiology, so this mismatch can produce spurious feature values unrelated to the speaker.
It also compounds the archival-provenance confound above: if the dementia cohort skews toward older, lower-quality footage, a model could learn "sounds like an old broadcast recording" as a shortcut for "dementia," which would not just underperform on deployment audio, it could behave unpredictably on it.

The mitigations for the channel/signal mismatch specifically (not the other two limitations) are: a per-file channel-quality confound check in the dataset audit (see `results/audit/audit_summary.md`); a direct comparison of jitter/shimmer/HNR against the same channel-quality proxies once those features are extracted in the feature-engineering phase; a synthetic-degradation robustness check run against cross-validation validation folds only, later in development; an interpretability check for whether jitter/shimmer/HNR-style features dominate model importance, which would suggest a channel-driven shortcut; and exactly one post-lock sensitivity check against the held-out test set after the final model is frozen, which is never used to adjust the locked model or its decision threshold.

## Preprocessing and subject-level split

Running `scripts/run_preprocessing.py` trims leading/trailing silence and resamples every file to 16kHz mono, writing the result under `data/processed/` (git-ignored, same as the raw dataset).
A file is included only if its post-trim duration clears a documented minimum (`config.MIN_USABLE_DURATION_SECONDS`); this is the criterion that resolves any format or duration outlier found in the audit, not the raw format alone.
Committed, anonymized output: `results/preprocessing/duration_report.csv` and `preprocessing_summary.md`.

Running `scripts/run_splits.py` afterward carves out a locked, subject-level, stratified test set (`config.TEST_SET_FRACTION`) from the subjects with at least one included file, leaving the rest as a train pool for later cross-validation.
No subject's files ever cross the train/test boundary.
Committed, anonymized output: `results/splits/subject_splits.csv` and `splits_summary.md`.

## Audit output and subject privacy

Running `scripts/run_audit.py` produces `results/audit/file_manifest.csv`, `results/audit/subject_manifest.csv`, and `results/audit/audit_summary.md`, all committed to this repository.
Every subject and file in those files is identified only by an anonymized `subject_id` (for example `subj_014`) or `file_id`, never by the person's real name.
The real-name lookup is written to `results/audit/subject_id_lookup.local.csv`, and a list of textually similar subject names flagged for manual review is written to `results/audit/near_duplicate_review.local.csv`.
Both `*.local.csv` files are git-ignored and exist only on disk, to keep the reproducibility of the audit findings (splits, counts, correlations) without committing real names to git history.
