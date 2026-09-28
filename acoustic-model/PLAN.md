# Mzazi Care — Acoustic Cognitive-Risk Model
## Development Plan: Language-Independent Acoustic Markers

**Status:** Plan for building the model from scratch. Scoping review done 2026-09-28: the feature list in 3.1 is frozen, and the decisions from that review are recorded in place and in `docs/ml-dev-log.md` (local).
**Audience:** the developer and the coding agent. The agent treats this file as the source of truth. If something in it turns out to be wrong once real data is inspected, the agent stops, says so, and proposes a change. It never silently deviates.

---

## 0. Goal and principles

### Goal

Build a model that takes one short speech recording and returns a calibrated probability in [0, 1] that the recording shows acoustic signs associated with cognitive decline. The output is a non-diagnostic screening signal, trended over repeated visits, not a diagnosis.

### Why "language-independent"

The system is intended for Kenyan households, where visits may be conducted in English, Swahili, or local languages such as Kikuyu or Dholuo. The training data is likely to be in a different language from deployment. So the model should rely on features that:

1. can be measured from the audio signal alone, without knowing the language or transcribing it, and
2. have published evidence of transferring across languages.

Published cross-language studies point mainly to **pausing and timing** features, with **voice-stability** features as a weaker secondary family. Features that encode the sounds of a particular language (MFCCs, formants), that depend heavily on the microphone (spectral balance, absolute loudness), or whose meaning changes in tonal languages (pitch) are excluded. Sources are listed at the end.

### Principles

- **No assumptions about the data.** Every dataset fact (counts, formats, labels, class balance, duration) is measured in Stage 1 and written to a file before anything depends on it.
- **Subject-level grouping everywhere.** No person's recordings may appear on both sides of any split or fold.
- **Fit only on training data.** Scaling, imputation, oversampling, calibration and any other learned step is fit inside the training portion of whichever split is active.
- **The test set is used exactly once**, at the very end, for one pre-chosen pipeline.
- **Features are chosen in advance** from the literature, not selected from this dataset.
- **Pre-register decisions.** Statistical tests, decision rules and thresholds are written down before the results they judge exist.
- **Report spread, not single numbers:** mean ± SD across folds. Differences between models are tested, not eyeballed.
- **Every number traces to a file.** Anything that can't be traced is marked "unverified".
- **Anonymisation:** committed files use an anonymous `subject_id`. The link to real names stays local and git-ignored.
- **Proportionate testing:** unit tests only for logic that is error-prone or guards against leakage (listed per stage). No tests for thin wrappers.
- **Checkpoints:** each stage is scoped, approved, built, run, reviewed, then committed. (Changed 2026-09-28 at the developer's instruction: the agent commits each finished step itself, with no co-author lines, so no step starts on top of uncommitted work.)
- **Blinding:** whenever a person listens to or annotates recordings (listening audit, pause annotation), the copies get neutral file names and the class labels are kept in a separate local file that stays closed until the work is done.

---

## 1. Repository structure

```
acoustic-model/
├── README.md                        dataset provenance, licence, limitations, how to run
├── PLAN.md                          this file
├── pyproject.toml                   pytest config (pythonpath = ["src"])
├── requirements.txt                 runtime dependencies only (reused for deployment)
├── requirements-dev.txt             test and development dependencies
│
├── src/mzazi_acoustic/
│   ├── common/
│   │   ├── config.py                paths, seed, every tunable constant with a reason
│   │   ├── stats.py                 shared statistical helpers
│   │   └── guards.py                test-set guard (see 1.1)
│   ├── data_collection/             Stage 1
│   ├── data_processing/             Stage 2
│   ├── feature_engineering/         Stage 3
│   ├── model_training/              Stage 4
│   └── model_evaluation/            Stage 5
│
├── scripts/
│   ├── 01_collect.py                one entry point per stage, run in order
│   ├── 02_process.py
│   ├── 03_features.py
│   ├── 04_train.py
│   └── 05_evaluate.py
│
├── tests/                           mirrors the five stage folders
├── results/
│   ├── 01_data_collection/
│   ├── 02_data_processing/
│   ├── 03_feature_engineering/
│   ├── 04_model_training/
│   └── 05_model_evaluation/
├── models/                          final saved pipeline and its metadata
└── data/                            git-ignored
    ├── raw/                         original audio, never modified
    └── processed/                   Stage 2 output
```

### 1.1 Test-set guard

One function in `common/guards.py` loads split-labelled data. It returns training data only, unless called with an explicit flag. That flag is passed in exactly one place: the final evaluation in Stage 5. A unit test checks that no other module passes it. This makes "the test set is used once" a rule enforced by code.

### 1.2 Feature code must work on a single recording

The deployed service will receive one recording at a time. So each feature function takes a waveform and sample rate and returns a dictionary of values. Code that loops over the dataset and builds tables lives separately and calls these functions. The same functions are then reused unchanged at deployment.

---

## Stage 0 — Setup

1. **Repository:** create the folder structure above on a new branch. `data/`, the virtual environment and any local lookup files are git-ignored before any data is added.
2. **Raw data:** place the dataset in `data/raw/` exactly as obtained. Never modify files in `data/raw/`.
3. **Freeze the raw data:** record a SHA-256 hash and size for every file. This becomes the reference for detecting later corruption or accidental changes, and is re-checked at the start of every later stage.
4. **Environment:** fresh virtual environment, record the Python version, pin package versions in `requirements.txt`, and set one global random seed in `config.py`.
5. **Plan location:** keep this file as `acoustic-model/PLAN.md` so it is version-controlled alongside the code.

**Checkpoint 0:** structure created, raw data hashed, environment reproducible.

---

## Stage 1 — Data Collection

**Goal:** a verified, anonymised, documented description of exactly what data exists. Nothing here is assumed; everything is measured.

### Steps

1. **Provenance.** Confirm and document the dataset's source, version or download date, licence, and what the licence actually covers (for example, a licence on a code repository may not cover externally hosted audio). Document how the labels were produced (clinical records, public reporting, self-report) — this affects how results can be interpreted.
2. **Structure discovery.** Walk `data/raw/` and report the folder layout as found. Propose a mapping from folders to class labels and **stop for the developer to confirm it**. If two folders appear to hold the same class, or the same person appears in more than one folder, report it rather than resolving it silently.
3. **Label taxonomy.** Confirm the labels are strictly binary (cognitive decline vs none). If a third category appears (for example mild cognitive impairment), stop and ask.
4. **Subject identity.** Work out which recordings belong to the same person. Normalise names (case, spacing, punctuation), flag likely duplicates or misspellings for manual review (never auto-merge), and assign each person a stable anonymous `subject_id` (deterministic, so re-running gives the same IDs). The ID-to-name lookup is saved locally and git-ignored.
5. **Per-file facts:** format, codec, sample rate, channel count, bit depth, duration, file size, SHA-256, and whether the file opens at all.
6. **Integrity:** missing, unreadable, zero-length, and exact-duplicate files (same hash under different names or subjects).
7. **Counts:** subjects per class, recordings per subject (min/mean/max, overall and per class), and class balance at both subject level and recording level. These two can differ if one class has more recordings per person; report both. Also report the per-class distribution of recording duration.
8. **Channel-quality proxies per file:** estimated noise floor, spectral bandwidth, spectral flatness. These describe recording conditions, not the speaker, and are reused later to check whether any feature is really measuring the microphone.
9. **Confound check:** do recording conditions differ between classes? Aggregate proxies per subject first (so people with more recordings don't count more), then test each proxy against class label (point-biserial correlation and Mann-Whitney U with rank-biserial effect size, Bonferroni-corrected across the proxies). Report the result either way.
10. **Listening audit.** Listen to a random sample of about 20 recordings, stratified by class (one recording per subject, shuffled, blinded as in the principles), and record for each: other voices present (interviewer, audience), overlapping speech, music, laughter, applause, background noise. This matters because pause features measured on a recording containing another speaker partly measure the *conversation*, not the person. The result drives decision D1.

### Outputs (`results/01_data_collection/`)

`file_manifest.csv`, `subject_manifest.csv`, `subject_id_lookup.local.csv` (git-ignored), `channel_confound.csv`, `listening_audit.csv`, `summary.md`, plus a README section on provenance, licence and label source.

### Tests

Name normalisation and duplicate flagging; `subject_id` stable across repeated runs; no real names in any committed output.

**Checkpoint 1:** folder-to-class mapping confirmed; counts and balance reviewed; listening audit reviewed; D1 decided.

---

## Stage 2 — Data Processing

**Goal:** uniform audio, and one fixed, leakage-safe split and fold structure that every later stage reads from file.

### Steps

1. **Standardise:** resample to 16 kHz and convert to mono. Record the original format of each file.
2. **Trim only the start and end.** Remove leading and trailing silence. **Never remove silences inside the recording** — internal pauses are the signal this model depends on.
3. **Minimum usable duration.** Pause statistics are unreliable on very short recordings. Pick a minimum duration after trimming, justify it (for example, the length needed to observe a reasonable number of pauses), write it in `config.py` *before* looking at which files it excludes, then report how many files **and subjects** per class it removes. If exclusions are lopsided between classes, or leave a class too small, stop and report before continuing.
   - **Decided 2026-09-28: 30 s after trimming**, pre-registered before any duration was measured. At typical spontaneous-speech rates, 30 s gives roughly 10 or more pauses longer than 180 ms, enough for a usable median pause duration.
   - **This is also a deployment requirement:** the app must capture at least 30 s of speech after trimming, and the service rejects anything shorter.
4. **Speaker isolation**, only if D1 requires it (see decisions table).
5. **Train/test split.** Not created until D1 is decided, because excluding recordings (D1 option c) can remove whole subjects and would change the split. Create a subject-level split, stratified by class, about 80 % train / 20 % test, with a fixed seed. Check and report class proportions in both parts. Save it to `splits.csv`.
6. **Cross-validation folds.** On the training portion only, create 5 folds with `StratifiedGroupKFold` (grouped by subject, fixed seed) and save them to `cv_folds.csv`. Every later stage reads folds from this file instead of regenerating them, so all comparisons use identical folds.
7. **Class balance decision.** Using the recording-level balance measured in Stage 1, decide how imbalance is handled: class weights, or oversampling (SMOTE) applied inside each training fold only. Record the choice and the reason (decision D2).

### Outputs (`results/02_data_processing/`)

`processing_report.csv` (raw and trimmed duration, inclusion flag and reason), `splits.csv`, `cv_folds.csv`, `summary.md`.

### Tests

No subject appears in both train and test; no subject appears in more than one validation fold; trimming preserves an internal gap (synthetic signal with a known silence in the middle).

**Checkpoint 2:** exclusions justified; split and folds verified.

---

## Stage 3 — Feature Engineering (language-independent)

**Goal:** a small feature set fixed in advance, measurable in any language, and checked before any model sees it.

### 3.1 Candidate feature set

The agent reviews this list during scoping and challenges anything it thinks is wrong. After scoping, the list is frozen.

**Frozen 2026-09-28** after the scoping review. "Analysed time" below means the stretch from the first speech onset to the last speech offset, so leftover edge silence never counts as pausing.

**A. Pausing and timing (primary family)**

| Feature | Source | Why it should transfer across languages | Caveat |
|---|---|---|---|
| Silent pause rate (pauses ≥ 80 ms per minute of analysed time) | Custom intensity-based pause detector (3.2) | Measured from the signal alone; word-retrieval effort rises in cognitive decline regardless of language | Turn-taking pauses contaminate it if another speaker is present (D1) |
| Mean and median pause duration | Pause detector | As above | Pause durations are skewed; report median alongside mean |
| Long-pause rate (pauses > 180 ms per minute of analysed time) | Pause detector | Band edge from He et al. (2025), who measured pauses acoustically | The 180 ms edge was fitted on English picture-description data; fixed from the literature, never tuned |
| Long-pause share of total pause time | Pause detector | As above | Undefined when a recording has no pauses (handled in 3.3 step 1) |
| Phonation-time ratio (speech time ÷ analysed time) | Pause detector | Signal-only | — |
| Mean speech-segment duration | Pause detector | Signal-only | — |
| Voiced segments per second; mean and SD of voiced and unvoiced segment length | eGeMAPS via openSMILE | Signal-only, from a validated extractor | Unvoiced segments include unvoiced consonants as well as pauses |
| Articulation-rate proxy (intensity peaks per second of speech) | eGeMAPS `loudnessPeaksPerSec`, rescaled from per second of total time to per second of speech time | Signal-only | Typical speaking rate differs between languages; per-person trending over visits partly offsets this. openSMILE's normalisation (total vs speech time) is verified on a synthetic signal before use |

**Why the pause set looks like this (decided 2026-09-28).** The original list had exact linear dependencies: total pause rate = short-pause rate + long-pause rate, and short-pause time share + long-pause time share + phonation-time ratio = 1. A pairwise |r| ≥ 0.9 rule can't catch a dependency spread across three features. Such dependencies make a linear model's coefficients unidentifiable, and they split permutation importance arbitrarily between the features involved. The fix keeps total pause rate (listed first in the original plan), long-pause rate, and the long-pause share of pause time. The short band (80–180 ms) is the one left implicit (short = total − long) because intensity-based detection confuses stop-consonant closures with short pauses, so it is the least trustworthy band. **Short-pause rate is still computed and reported descriptively, but it is not a model feature.** Whether the closure concern is real is measured, not assumed: the detector validation in 3.2 reports precision and recall separately per band.

The remaining pause features are still deterministic but *non-linear* functions of each other (for example, mean pause duration = pause time ÷ pause count). That is inherent to pause statistics and accepted. 3.3 step 2 measures it with a variance inflation factor (VIF) check.

**B. Voice stability (secondary family)**

| Feature | Source | Why | Caveat |
|---|---|---|---|
| Jitter (mean and variability) | eGeMAPS | Reflects vocal-fold behaviour, not language | Known to be sensitive to noise and recording quality |
| Shimmer (mean and variability) | eGeMAPS | As above | Same caveat, often stronger than for jitter |
| Harmonics-to-noise ratio (mean and variability) | eGeMAPS | As above | Same caveat |

Every family B feature goes through the channel-confound check in 3.3. The rule for acting on it is written down now: **any feature whose correlation with a channel proxy survives correction is removed from the model and reported.**

**Scope of the removal rule (decided 2026-09-28): family B only.** Family A features are also correlated against the channel proxies, but only reported descriptively, because that check is circular for them. The noise-floor and noise-flatness proxies are measured on each file's quietest frames, and in speech those frames are mostly the pauses. So a person who pauses more changes the proxy, and pause features correlate with it through the measurement itself, whatever the microphone. Removing pause features on that basis would remove signal, not a confound. Family A gets a separate, non-circular check instead: controlled degradation (3.3 step 4).

**C. Excluded, with reasons**

| Family | Reason |
|---|---|
| Pitch level and pitch contour (F0) | In tonal languages such as Kikuyu and Dholuo, pitch carries word meaning, so its relationship to cognition is unlikely to hold across languages |
| MFCCs, formants (F1–F3) | Describe which vowels and consonants are spoken, i.e. the language itself |
| Spectral balance (alpha ratio, Hammarberg index, spectral slopes) | Strongly shaped by the microphone and its frequency response |
| Absolute loudness | Depends on microphone gain and distance from the speaker |
| Anything derived from transcripts | Fails on untranscribed languages |

Frozen size (before the 3.3 removal rules): 19 model features (13 in family A, 6 in family B: jitter, shimmer and HNR, each as mean and variability). Because the set is small and justified in advance, **there is no data-driven feature-selection step.** The only removals are the pre-stated rules in 3.3 (redundancy, exact dependency, family B channel confound).

### 3.2 Pause detector

This is new code and the biggest technical risk, so it is validated against human judgement before use.

- Frame-level intensity; 25 ms window, 10 ms hop.
- Silence threshold **relative to each recording's own speech level**: 25 dB below the 99th percentile of that file's frame intensity (the 2010 update of De Jong & Wempe's syllable-nuclei script; 25 dB is also Praat's standard silence setting). Microphone gain therefore doesn't change the result.
- **Noise guard:** the threshold is raised to at least 6 dB above the file's noise level (5th percentile of frame intensity). Without it, in any recording whose speech is less than ~31 dB above the background noise, "25 dB below speech" falls under the noise, so no pause is ever found, and pause features would measure the noise instead of the speaker. In clean recordings the guard is inactive.
- Minimum pause length 80 ms (the lower edge of the short-pause band). Sounding stretches shorter than 25 ms are treated as silence, so a click can't split one pause into two (the minimum speech duration of the SPA detector used by He et al. 2025).
- Only internal pauses count: silence before the first speech onset or after the last speech offset is neither pause nor speech.
- All parameters are written in `config.py` with a reason **before** class labels are looked at, and are **never tuned to improve model scores.**
- **Validation:** manually mark pauses in about 10 recordings (Praat or Audacity) drawn from both classes. Report the detector's agreement (precision and recall of pause boundaries within a stated tolerance). Parameters may be adjusted only against these annotations, never against labels. Record the final agreement figures.
  - **Sample (decided 2026-09-28):** 10 recordings (5 per class, one per subject) drawn with the global seed from the **training portion only**, once the split exists, so no test audio is heard before Stage 5. Only recordings whose trimmed duration is at least 70 s are eligible. From each, a **fixed 60 s segment starting 10 s after the trimmed start** is annotated, because the first seconds of a clip are often an unrepresentative lead-in. Copies are blinded (neutral names, key in a local file).
  - **Tolerance:** a detected pause matches an annotated one when both its start and its end are within **40 ms**. That covers about 20 ms of detector boundary uncertainty (25 ms window, 10 ms hop) plus about 20 ms of human placement error. The detector runs on the whole trimmed recording, as in deployment. Only pauses lying fully inside the annotated segment are scored, on both sides.
  - **Per band:** precision and recall are reported overall and **separately for short (80–180 ms) and long (> 180 ms) pauses**. A detected pause is banded by its detected duration for precision, and an annotated pause by its annotated duration for recall. This measures the stop-closure concern from 3.1 instead of assuming it.
  - **Under noise:** the same scoring is repeated with the annotated recordings degraded as in 3.3 step 4 (bandpass alone; bandpass + white and pink noise at 20 and 10 dB SNR). It reports how precision and recall change from clean.
  - **Sign-off:** at-scale feature extraction and any per-class feature statistics wait until the developer signs off the detector on these figures. That way, detector settings are never adjusted after seeing class results.

### 3.3 Checks before any modelling (training portion only)

1. **Completeness:** missing or infinite values per feature; list any recording where a feature couldn't be computed and how it is handled.
2. **Redundancy:** correlation matrix across the feature set. Pre-stated rule: for any pair with |r| ≥ 0.9, keep the one listed first in 3.1 and drop the other. Record what was dropped.
   - **Multi-feature dependencies (added 2026-09-28):** the pairwise rule can't see a dependency spread across three or more features. After the pairwise step, compute the numerical rank of the standardised training matrix (singular values below 1e-8 × the largest count as zero) and each feature's variance inflation factor (VIF). Pre-stated rule: if the matrix is rank-deficient, the **later-listed** feature in each exact dependency is dropped, with the same "listed first wins" logic. Features with VIF > 10 are reported but not removed, because the non-linear redundancy among pause statistics is expected (3.1) and the candidate models tolerate it.
3. **Channel confound:** each feature against each channel proxy, aggregated per subject, Bonferroni-corrected across all pairs. Apply the removal rule from 3.1 to **family B only**. Report family A's correlations descriptively, with the circularity from 3.1 explained next to them.
4. **Family A robustness under controlled degradation (added 2026-09-28; non-circular check).** Re-extract the family A features from training-portion audio under the same conditions as 5.1: phone bandpass alone (100–7000 Hz), and bandpass plus white and pink noise at 20 and 10 dB SNR. The SNR is measured after filtering and the noise gain set so the measured value matches the target. For each feature and condition, report the per-recording relative change from clean, (degraded − clean) ÷ |clean|, as a median and interquartile range. Recordings whose clean value is 0 are left out of that feature's figure and counted.
   - **Flag rule (pre-registered):** a family A feature whose median relative change under the **mildest condition (bandpass alone)** exceeds the tolerance is **flagged and tracked into the 5.1 interpretation, not removed**.
   - **Proposed tolerance: 10 %**, awaiting the developer's approval before this check runs. Reason: a 100–7000 Hz band keeps essentially all of the speech energy an intensity-based detector relies on, so a detector that measures the speaker should move by only a few percent. A shift above 10 % means the feature depends on energy outside the phone band, which is a property of the microphone, not the person.
5. **Recording-duration dependence (added 2026-09-28):** correlate each feature with trimmed recording duration at subject level (both averaged per subject). Pre-stated rule: any feature with |r| > 0.2 is flagged and tracked into 5.1, not removed. Reason: timing statistics are estimated more stably, and can drift systematically, as recordings get longer, so a class difference in recording length could otherwise pass for a class difference in speech. The developer's cited precedent: the ADReSS challenge baseline (Luz et al. 2020).
6. **Class differences (descriptive only):** per-class mean, SD and median, plus Mann-Whitney U with effect size, per subject. **Nothing is added or removed based on this.**
7. **Direction check:** the literature expects more and longer pauses and a lower phonation-time ratio with cognitive decline. Report whether the data agrees; don't force it.

### Outputs (`results/03_feature_engineering/`)

`feature_matrix.csv` (one row per recording, with `subject_id`, split and fold), `pause_detector_validation.csv`, `redundancy.csv`, `dependency_check.csv`, `channel_confound.csv`, `degradation_shift.csv`, `duration_dependence.csv`, `class_differences.csv`, `summary.md`.

### Tests

Pause detector on synthetic signals with known pauses returns the exact counts and durations; scaling a signal's volume (for example by 0.1) gives the same pauses; each feature function runs on a single waveform; agreement scoring gives known precision and recall on hand-built cases; degradation hits the target SNR as measured after filtering.

**Checkpoint 3:** detector validated; checks reviewed; final feature list frozen and written to `config.py`.

---

## Stage 4 — Model Training

**Goal:** choose one calibrated model using cross-validation on the training portion only, then save it as a single pipeline.

### 4.1 Candidates

The project report (Chapter 3.2.3) names **Random Forest, Support Vector Machine and XGBoost.** These are the candidates. Adding an L2-regularised logistic regression as a simple baseline is recommended, because with a small, meaningful feature set a linear model may perform as well, and it answers "is the extra complexity worth it?" This is decision D3.

### 4.2 Procedure

1. **Pipeline:** each candidate is wrapped in one pipeline (scaling, imbalance handling per D2, model), so every learned step is fit inside the training fold only.
2. **Baselines:** default settings, evaluated on the saved folds. Per fold: ROC-AUC, PR-AUC, F1, Brier score. Threshold-dependent metrics use a threshold chosen within each fold (Youden's J) and are labelled as optimistic; also report sensitivity at a fixed specificity (for example 90 %).
3. **Tuning:** nested cross-validation. The outer folds (from file) estimate performance; an inner 3-fold subject-grouped search picks settings. Equal search budget per candidate, modest search spaces, fixed seed. Record every configuration tried.
4. **Calibration:** sigmoid (Platt) calibration fit on out-of-fold predictions, grouped by subject. Add a test that confirms the subject groups actually reach the splitter used for calibration. If a library tool can't pass groups through, calibrate manually using grouped out-of-fold predictions.
5. **Selection rule (pre-registered, written before any results):**
   - Primary: ROC-AUC, compared with fold-paired t-tests (df = 4), Bonferroni-corrected across model pairs.
   - If tied: calibrated Brier score, same test.
   - If still tied: expected calibration error.
   - Last resort: the simplest model (fewest dependencies, smallest saved file).
   - With only 5 folds, a tie is a likely outcome and is reported plainly rather than forced.
6. **Final fit:** refit the chosen pipeline (scaling + model + calibration) on the whole training portion, with the same grouped internal search. The score from this refit is never reported as performance.
7. **Save** with joblib to `models/`, with a metadata file: feature list, feature-extractor and pause-detector parameters, package versions, seed, training date.

### Outputs (`results/04_model_training/`)

Per-fold scores for every candidate and step, tuning log, comparison tests, selection record; `models/acoustic_model.joblib` and `models/metadata.json`.

### Tests

Learned steps are fit inside folds only; calibration receives subject groups; the saved model reloads and gives identical predictions to the in-memory one.

**Checkpoint 4:** one model chosen by the pre-stated rule; saved and reloadable.

---

## Stage 5 — Model Evaluation

**Goal:** understand the chosen model, test its robustness, then evaluate it once on the held-out test set.

### 5.1 Before touching the test set (training portion, saved folds)

1. **Interpretability:** permutation importance per fold (ROC-AUC scorer), mean ± SD. Does the model rely mainly on pausing features as intended? Do directions match the literature? Importance shows association, not causation.
2. **Recording-quality robustness:** re-extract features from validation-fold audio under simulated phone conditions: phone-like bandpass (about 100–7000 Hz) alone, and bandpass plus white and pink noise at two severities (for example 20 dB and 10 dB SNR). Measure the actual signal-to-noise ratio of each generated file after filtering, and adjust the noise so the measured value matches the target (filtering removes noise unevenly, especially low-frequency pink noise). Report a degradation curve. Pre-register exactly one formal test: the most severe condition vs clean.
3. **Language-shift check (optional, licence permitting — D4):** extract the same features from unlabelled speech in Kenyan languages (for example AfriVoices-KE or Kencorpus, both smartphone-recorded). Compare each feature's distribution with the healthy group in the training data. This cannot measure accuracy (there are no labels); it shows which features shift with language alone. This data is never used for training.
4. **Threshold (blocker):** the balance between catching more cases (more false alarms) and fewer false alarms (risk of missing cases) is a product and clinical decision (D5). It is frozen before 5.2.

### 5.2 Final evaluation — the only use of the test set

1. Freeze everything: features, model, calibration, threshold.
2. Evaluate once on the test subjects: accuracy, precision, recall (sensitivity), specificity, F1, ROC-AUC, PR-AUC, Brier score, confusion matrix, ROC, PR and calibration curves.
3. **Uncertainty:** there are no folds on a single test set, so report 95 % confidence intervals by bootstrap resampling of subjects (people, not recordings).
4. Afterwards, once and for reporting only: the most severe robustness condition applied to the test set.
5. No changes after seeing the result. A disappointing result is a valid finding.

### 5.3 Final report

`results/05_model_evaluation/final_report.md` with figures: dataset makeup, pause-detector validation, per-feature class differences, model comparison, calibration curves, robustness curve, language-shift plot (if done), test confusion matrix and ROC curve. Every number cited to a file.

### Tests

Test-set guard: only the final-evaluation module can load test data.

**Checkpoint 5:** results reviewed; limitations written.

---

## Decisions needed from the developer

| ID | Decision | Needed by |
|---|---|---|
| D1 | If the listening audit finds other voices in many recordings: (a) accept and state it as a limitation, (b) add speaker separation, or (c) keep only recordings judged single-speaker. Deployment audio (caregiver visits) will also contain two speakers, so this affects the live system too. | Checkpoint 1 |
| D2 | Imbalance handling: class weights or in-fold SMOTE, based on Stage 1's measured balance | Stage 2 |
| D3 | Add logistic regression as a baseline alongside RF, SVM and XGBoost | Stage 4 scoping |
| D4 | Whether to use Kenyan-language corpora for the language-shift check (check licences first) | Before 5.1 |
| D5 | Operating threshold: favour catching more cases or fewer false alarms. Needs supervisor input. | Before 5.2 |

---

## Documents to update to match this plan

The ML development specification and the report currently describe a different feature set (MFCCs, pitch statistics, shimmer as a core feature) and name `CalibratedClassifierCV` and F1 optimisation specifically. Once this plan is approved, update:

- ML spec §5 (features) and §13 (interpretability expectations) to the language-independent set;
- Report Chapter 3.2.2 (feature list) and, if D3 adds logistic regression, 3.2.3;
- Any wording implying the model has been validated for Kenyan languages — it will not have been (see limitations).

---

## Limitations to state in the report

1. **Speech context:** the training recordings may differ in setting and task from caregiver-visit conversations (confirmed or refuted by the Stage 1 provenance and listening audit).
2. **Label source:** results are only as reliable as the labels; state how they were produced (Stage 1).
3. **Recording conditions:** training audio may differ from a phone microphone in a home; measured in 5.1.
4. **Language:** "language-independent" here means measurable without knowing the language and supported by cross-language research. Typical levels (for example speaking rate) may still differ between languages. Without labelled local-language data, accuracy in Kenyan languages is not validated.
5. **Multiple speakers:** pause features assume the target speaker is isolated (D1).
6. **Sample size:** whatever Stage 1 measures; small samples mean large fold-to-fold variation.
7. **Label timing (added 2026-09-28):** labels describe the person, not the recording. A public figure's recordings may pre-date the onset of their dementia, so some "dementia" recordings may carry no signs of it. That is label noise the data can't resolve.
8. **Unmatched demographics (added 2026-09-28):** age and sex are not recorded, so they can't be matched or controlled. Both affect voice and timing features.

---

## Review notes carried to later stages (2026-09-28)

Raised in the scoping review and deliberately not acted on yet. Each is decided at the named stage's scoping:

- **Stage 4, selection rule:** fold-paired t-tests on CV scores are anti-conservative, because the training portions of different folds overlap. The Nadeau-Bengio corrected resampled t-test is the standard correction and is recommended in place of the plain t-test.
- **Stage 3.2, annotation eligibility:** requiring 70 s of trimmed audio favours longer recordings. Report the sampled recordings' durations next to the dataset's, so any bias is visible.

---

## Kickoff prompt for the agent

```
Read acoustic-model/PLAN.md fully. Treat it as the source of truth.
Do Stage 0 only:
1. Create the folder structure and an empty package skeleton, requirements files,
   pyproject.toml, .gitignore entries, and config.py with a global seed. No stage logic.
2. After I place the dataset in data/raw/, record a SHA-256 hash and size for every file.
Do not assume anything about the dataset (counts, formats, labels, structure) —
that is Stage 1's job.
Then stop and report. Also list anything in PLAN.md you think is wrong, risky,
or unclear before we start Stage 1.
```

---

## Sources behind the feature choices

- Luz et al. (2024), overview of the ADReSS-M challenge (models trained on English, tested on Greek): pause and disfluency features judged effective and generalisable across languages. https://talkbank.org/dementia/ADReSS-M/IEEE.pdf
- Gosztolya et al. (2021), mild cognitive impairment detection from temporal speech parameters, English and Hungarian: no performance difference between same-language and cross-language settings. https://www.sciencedirect.com/science/article/abs/pii/S088523082100022X
- He et al. (2025), acoustic pause analysis with the SPA detector (minimum pause 80 ms, minimum speech 25 ms); short (80–180 ms) and long (>180 ms) pauses associated with tau and amyloid. The method needs no transcript, but the study itself is English-only (Cookie Theft picture description), and the 180 ms edge was fitted empirically on its unimpaired participants (checked against the paper 2026-09-28). https://pmc.ncbi.nlm.nih.gov/articles/PMC12397068/
- De Jong & Wempe, Praat script to detect syllable nuclei (Behavior Research Methods 41, 2009). The 2010 update of the script sets its threshold at the 0.99 quantile of intensity minus 25 dB. The 0.99 quantile avoids non-speech bursts, and 25 dB matches Praat's standard silence setting. The 2009 paper itself used median + 2 dB. The 2010 rule is the source of the detector's threshold in 3.2. https://sites.google.com/site/speechrate
- Cross-linguistic generalisability of automated speech markers of Alzheimer's (JMIR, 2025): timing features expected to transfer better than lexical ones. https://doi.org/10.2196/74200
- Acoustic cues in Alzheimer's across language and gender (2026): a Mandarin (tonal) model relied mainly on pause features. https://arxiv.org/html/2607.23977
- Tone status: Kikuyu https://en.wikipedia.org/wiki/Kikuyu_language · Dholuo https://en.wikipedia.org/wiki/Luo_language_(Kenya_and_Tanzania) · Swahili's loss of lexical tone https://www.sciencedirect.com/science/article/abs/pii/S0388000108000478
- Kenyan speech corpora: AfriVoices-KE https://arxiv.org/abs/2604.08448 · Kencorpus https://arxiv.org/pdf/2208.12081
