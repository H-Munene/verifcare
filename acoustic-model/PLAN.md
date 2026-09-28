# Mzazi Care — Acoustic Cognitive-Risk Model
## Development Plan: Language-Independent Acoustic Markers

**Status:** Plan for building the model from scratch. Scoping review done 2026-09-28: the feature list in 3.1 is frozen, and the decisions from that review are recorded in place and in `docs/ml-dev-log.md` (local). Checkpoint 1 review 2026-09-28: 90 s truncation, D2, D6 opened, and the within-subject tolerance, all recorded in place.
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
- **Checkpoints:** each stage is scoped, approved, built, run, reviewed, then committed. (Changed 2026-09-28 at the developer's instruction: the agent commits each finished step itself, with no co-author lines, so no step starts on top of uncommitted work. This file itself is tracked in git; it was briefly git-ignored on 2026-09-28, then restored.)
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

11. **Age at recording (added 2026-09-28, decision D6).** DementiaNet's no-dementia group was selected for age, reaching 85–90+ without dementia, and the README describes the control clips' timing two inconsistent ways. Determine age at recording by class from the metadata sheet linked in the README, and how the clip-name suffix maps to it. Where ages can't be determined, record it as a limitation. Propose options and stop for the developer's decision.
    - **Found 2026-09-28** (`age_summary.md`): there are no recording dates, only buckets. Dementia `_0/_5/_10/_15` = after onset, and 0–5, 5–10, 10–15 years before onset. Control `_1/_2/_3` = under 55, 55–70, over 70, established by matching each control's URL columns against the files on disk (55 of 61 exact). Controls: 98 clips under 55, 100 at 55–70, 126 over 70. Dementia: only 8 clips wholly under 55; the median age-range midpoint is 72.
    - **D6 decided 2026-09-28: option A.** The primary dataset keeps clips **wholly aged 55 or over**, in both classes. A dementia clip is kept only if the lower end of its age range is at least 55. So the band-crossing clips whose range crosses 55 are dropped, those crossing 70 are kept (they are wholly 55+), and clips with an unknown age are dropped, because they can't be shown to qualify. Control `_1` (under 55) clips are dropped. Rule in `data_processing/eligibility.py`.
      - (The counts first given for option A used an age-range midpoint rule; the developer's stricter "wholly 55+" rule costs 4 more dementia clips from 2 people before the 30 s minimum, and 3 clips from 1 person after it.)
    - **Option B (both classes wholly over 70) is pre-registered as a sensitivity analysis only** (5.2): the same frozen model, evaluated on that subset, reported whatever it shows. It is not a separate model and is not used for selection. No reweighting (option D is rejected).

### Outputs (`results/01_data_collection/`)

`file_manifest.csv`, `subject_manifest.csv`, `subject_id_lookup.local.csv` (git-ignored), `channel_confound.csv`, `listening_audit.csv`, `summary.md`, `age_at_recording.csv`, `control_suffix_order_evidence.csv`, `age_summary.md`, plus a README section on provenance, licence and label source.

### Tests

Name normalisation and duplicate flagging; `subject_id` stable across repeated runs; no real names in any committed output.

**Checkpoint 1:** folder-to-class mapping confirmed; counts and balance reviewed; listening audit reviewed; D1 and D6 decided. (Mapping confirmed and counts reviewed by the developer 2026-09-28; the listening audit, D1 and D6 are pending.)

---

## Stage 2 — Data Processing

**Goal:** uniform audio, and one fixed, leakage-safe split and fold structure that every later stage reads from file.

### Steps

1. **Standardise:** resample to 16 kHz and convert to mono. Record the original format of each file.
2. **Trim only the start and end.** Remove leading and trailing silence. **Never remove silences inside the recording** — internal pauses are the signal this model depends on.
   - **Trimming rule (changed 2026-09-28 at the Stage 2 review; frozen, never adjusted):** a simple energy rule of its own, independent of the pause detector. On the 16 kHz mono audio, compute frame RMS (25 ms window, 10 ms hop) and keep everything from the first to the last frame within **30 dB of the file's 99th-percentile level** (`config.TRIM_*`).
     - Reason: the pause detector will be tuned against the developer's annotations, and trimming must not move when it is. Otherwise the 30 s minimum, and therefore the split, could change after the split exists.
     - 30 dB is 5 dB wider than the detector's silence rule, so trimming is the more conservative of the two: it keeps weak speech onsets and removes only clearly silent edges. In a noisy file it may trim nothing, which never cuts speech.
     - Consequence (noted in the dev log): the pause features describe the detector's span, from first to last detected speech, which can be slightly narrower than the trimmed audio.
     - (The first rule, used for one run, cut at the detector's own speech boundaries. It was replaced before any split or feature existed. Rerunning with the new rule changed exactly one clip: a control clip went from 29.92 s to 30.00 s and joined the pool. Whole-person losses were unchanged.)
3. **Minimum usable duration.** Pause statistics are unreliable on very short recordings. Pick a minimum duration after trimming, justify it (for example, the length needed to observe a reasonable number of pauses), write it in `config.py` *before* looking at which files it excludes, then report how many files **and subjects** per class it removes. If exclusions are lopsided between classes, or leave a class too small, stop and report before continuing.
   - **Decided 2026-09-28: 30 s after trimming**, pre-registered before any duration was measured. At typical spontaneous-speech rates, 30 s gives roughly 10 or more pauses longer than 180 ms, enough for a usable median pause duration.
   - **This is also a deployment requirement:** the app must capture at least 30 s of speech after trimming, and the service rejects anything shorter.
   - Stage 2's report gives the files **and** subjects this excludes, per class (developer instruction at Checkpoint 1).
   - **Measured 2026-09-28** (`results/02_data_processing/summary.md`): at clip level the minimum is even (22 % of clips in each class). At subject level it isn't: 9 of 84 dementia people (10.7 %) lose every clip, against 5 of 131 controls (3.8 %), because dementia people have fewer clips each. This was reported to the developer under the stop rule above.
   - **Developer's decision (Stage 2 review): the 30 s minimum stays unchanged,** as pre-registered. A descriptive comparison of the 9 lost dementia people with the 75 kept ones is in `results/02_data_processing/summary.md` (`excluded_vs_kept_dementia.csv`). The lost people's clips are short throughout (median 17.5 s; their longest clip has a median of 17.8 s), so these aren't people who narrowly missed the cut on a single clip. They have slightly fewer clips (1.22 vs 1.6 per person), and their clips come from after onset less often (9 % vs 22 % of clips, though only 11 clips). Limitation 12 records that results apply only to speakers able to produce at least 30 s of speech.
   - **Maximum duration (pre-registered 2026-09-28, before any feature extraction): every recording is truncated to its first 90 s after trimming, in both classes.** Reason: Stage 1 found that DementiaNet clips are capped at 90 s, a cap only dementia clips exceed (7 clips, up to 162 s). A class-dependent maximum length could let duration, or any feature that drifts with duration, stand in for the label. Truncating both classes the same way removes that difference. The |r| > 0.2 duration check in 3.3 stays. The 60 s pause-annotation segment (10–70 s after the trimmed start) lies inside the kept 90 s. Order: trim, then apply the 30 s minimum, then truncate.
4. **Speaker isolation**, only if D1 requires it (see decisions table).
5. **Age restriction (D6 = option A) and label timing (D7 = c):** keep only clips wholly aged 55 or over (Stage 1 step 11). Of the dementia clips, only those from onset to 10 years before go to the training pool; the 10–15-year clips are set aside for the Stage 5 trajectory analysis. Exclusions apply in the order: 30 s minimum, age, timing. They are reported per class and per timing/age band (`results/02_data_processing/summary.md`).
   - **Run 2026-09-28** (`scripts/02_process.py`, no split yet). Training pool: dementia 72 clips / 54 people, controls 178 / 118 (31.4 % dementia by person, 28.8 % by clip); 14 trajectory-only clips.
   - Whole people lost: to the 30 s minimum, 9 of 84 dementia vs 5 of 131 controls; to the age rule, 7 of 84 dementia vs 1 of 131 controls. The age rule removes controls' clips but rarely whole controls, because each control also has 55+ clips.
   - **Expected test set** (about 20 % of people): about 11 dementia and 24 control people. Confidence intervals on the test result will therefore be wide (limitation 11).
   - **Descriptive check (developer, D7):** channel-quality proxies across the dementia timing buckets, testing the era/equipment concern instead of assuming it (`results/01_data_collection/channel_by_timing.md`). Result: **no evidence of a difference** in any proxy across the buckets after correction, across all clips or within the 18 people who have both an early (10–15 y) and a late (0–5 y) clip. With 18 people, that is an absence of evidence, not evidence that recording conditions were the same.
6. **Train/test split.** Not created until D1 and D6 are decided, because excluding recordings (D1 option c, or an age restriction) can remove whole subjects and would change the split. Create a subject-level split, stratified by class, about 80 % train / 20 % test, with a fixed seed. Check and report class proportions in both parts. Save it to `splits.csv`.
7. **Cross-validation folds.** On the training portion only, create 5 folds with `StratifiedGroupKFold` (grouped by subject, fixed seed) and save them to `cv_folds.csv`. Every later stage reads folds from this file instead of regenerating them, so all comparisons use identical folds.
8. **Class balance decision.** Using the recording-level balance measured in Stage 1, decide how imbalance is handled: class weights, or oversampling (SMOTE) applied inside each training fold only. Record the choice and the reason (decision D2).
   - **Decided 2026-09-28 (D2): class weights, not SMOTE.** Each recording is weighted by 1 ÷ (the number of that subject's recordings), so every person counts equally however many clips they have. The weights are then scaled so the two classes have equal total weight. The counts are those after every exclusion (30 s minimum, D1, D6), and the weights are computed inside each training fold, since a subject's clips all sit in the same fold. Reason: the classes differ more in clips per person (1.56 vs 2.47) than in people, so plain class weights would still let multi-clip controls count more than single-clip people. SMOTE would also invent synthetic recordings by interpolating between different people's feature vectors. This deviates from the ML specification's §6; see `docs/ml-dev-log.md`.

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
  - **Order (developer, 2026-09-28):** listening audit → D1 → split and folds → draw the 10 blinded annotation clips from the training portion → developer annotates → score agreement per band and under added noise → adjust settings **only against the annotations** → freeze permanently → extract features at scale. The detector is deliberately not frozen before the annotations exist: they must be able to fix real detector errors while no class result exists yet. Freezing first would leave only "report a known-bad detector" or "fix it after seeing results".
  - **Noisy clips in the sample (developer, 2026-09-28):** the 10 clips deliberately include clips with noisy backgrounds, e.g. ones where the noise guard is active (speech-to-noise dynamic range under 31 dB) or with low estimated SNR. The guard was already active on a real clip, and it's the part of the detector most likely to fail. How many noisy clips were included is recorded.
  - **Record** the final settings, the agreement figures, and every adjustment made, each with its reason, here and in `docs/ml-dev-log.md`.

### 3.3 Checks before any modelling (training portion only)

1. **Completeness:** missing or infinite values per feature; list any recording where a feature couldn't be computed and how it is handled.
2. **Redundancy:** correlation matrix across the feature set. Pre-stated rule: for any pair with |r| ≥ 0.9, keep the one listed first in 3.1 and drop the other. Record what was dropped.
   - **Multi-feature dependencies (added 2026-09-28):** the pairwise rule can't see a dependency spread across three or more features. After the pairwise step, compute the numerical rank of the standardised training matrix (singular values below 1e-8 × the largest count as zero) and each feature's variance inflation factor (VIF). Pre-stated rule: if the matrix is rank-deficient, the **later-listed** feature in each exact dependency is dropped, with the same "listed first wins" logic. Features with VIF > 10 are reported but not removed, because the non-linear redundancy among pause statistics is expected (3.1) and the candidate models tolerate it.
3. **Channel confound:** each feature against each channel proxy, aggregated per subject, Bonferroni-corrected across all pairs. Apply the removal rule from 3.1 to **family B only**. Report family A's correlations descriptively, with the circularity from 3.1 explained next to them.
4. **Family A robustness under controlled degradation (added 2026-09-28; non-circular check).** Re-extract the family A features from training-portion audio under the same conditions as 5.1: phone bandpass alone (100–7000 Hz), and bandpass plus white and pink noise at 20 and 10 dB SNR. The SNR is measured after filtering and the noise gain set so the measured value matches the target. For each feature and condition, report the per-recording relative change from clean, (degraded − clean) ÷ |clean|, as a median and interquartile range. Recordings whose clean value is 0 are left out of that feature's figure and counted.
   - **Flag rule (pre-registered):** a family A feature whose median relative change under the **mildest condition (bandpass alone)** exceeds the tolerance is **flagged and tracked into the 5.1 interpretation, not removed**.
   - **Tolerance = the feature's own within-subject variation (decided 2026-09-28, replacing the 10 % first proposed).** Reason: a fixed percentage is arbitrary, whereas "does the microphone move this feature more than a person's own recordings already differ?" is anchored in the data. Computed on clean, training-portion audio, after all exclusions:
     - For each subject with 2 or more recordings, take every pair of their recordings and compute the relative difference |x_i − x_j| ÷ ((|x_i| + |x_j|) ÷ 2). The symmetric denominator is used because neither clip is the reference; pairs where both values are 0 are skipped. The subject's value is the median over their pairs.
     - The feature's benchmark is the median of those subject values.
     - Flag the feature if |median relative change| under bandpass alone exceeds its benchmark **or 10 %**, whichever is smaller (developer, Stage 2 review 2026-09-28). A feature that shifts by more than a person's own clips already differ is suspect, and so is one shifting by more than 10 %, even if people's clips differ a lot (the within-person benchmark is lenient, see the caveat below). **Flagging only; nothing is removed.**
   - **Same age band where possible (developer, D6 review 2026-09-28).** Pairs are drawn in this order, using the first level with at least 20 training subjects:
     1. pairs of clips in the same age band (55–70 or over 70);
     2. otherwise, all of a subject's pairs (under D6 option A, only 55–70 against over-70, since under-55 clips are gone);
     3. otherwise, the 10 % fallback below.
     Measured before the split: only 14 people (all dementia) have a same-band pair after the 30 s minimum, about 11 in the training portion. Controls can never have one, because DementiaNet samples each control once per band. So level 2 is expected, and the report states which level was used.
   - **Fallback: 10 %**, used only if fewer than 20 training subjects have 2 or more recordings. A median over fewer people is itself too unstable to serve as a benchmark. The 10 % reasoning stands for that case: a 100–7000 Hz band keeps essentially all the speech energy an intensity-based detector uses, so a larger shift points to the microphone.
   - Caveat, to state next to the result: a person's own clips can be decades apart (control clips span under-55 to over-70), so the benchmark includes ageing and changing recording conditions. That makes it a lenient benchmark: a flag means the shift is large, and no flag doesn't prove the feature is robust.
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

The project report (Chapter 3.2.3) names **Random Forest, Support Vector Machine and XGBoost.** These are the candidates. Adding an L2-regularised logistic regression as a simple baseline is recommended, because with a small, meaningful feature set a linear model may perform as well, and it answers "is the extra complexity worth it?" This is decision D3. **Decided 2026-09-28: L2 logistic regression is added**, making four candidates. This deviates from ML spec §7 (three candidates); the reason is recorded in `docs/ml-dev-log.md`.

### 4.2 Procedure

1. **Pipeline:** each candidate is wrapped in one pipeline (scaling, imbalance handling per D2, model), so every learned step is fit inside the training fold only.
2. **Baselines:** default settings, evaluated on the saved folds. Per fold: ROC-AUC, PR-AUC, F1, Brier score. Threshold-dependent metrics use a threshold chosen within each fold (Youden's J) and are labelled as optimistic; also report sensitivity at a fixed specificity (for example 90 %).
3. **Tuning:** nested cross-validation. The outer folds (from file) estimate performance; an inner 3-fold subject-grouped search picks settings. Equal search budget per candidate, modest search spaces, fixed seed. Record every configuration tried.
4. **Calibration:** sigmoid (Platt) calibration fit on out-of-fold predictions, grouped by subject. Add a test that confirms the subject groups actually reach the splitter used for calibration. If a library tool can't pass groups through, calibrate manually using grouped out-of-fold predictions.
5. **Selection rule (pre-registered, written before any results):**
   - Primary: ROC-AUC, compared with fold-paired t-tests (df = 4), Bonferroni-corrected across model pairs.
     - **Changed 2026-09-28:** the plain fold-paired t-test is replaced by the **Nadeau-Bengio corrected resampled t-test**, because CV training portions overlap, which makes the plain test anti-conservative. The Bonferroni family is the **6 pairwise comparisons** among the 4 candidates, so each is tested at α = 0.05 ÷ 6.
     - **Decided 2026-09-28 (Stage 2 review): 5 repeats × 5 folds** of subject-grouped, class-stratified CV (`StratifiedGroupKFold`), each repeat with its own seed derived from the global seed, all 25 fold assignments stored in `cv_folds.csv`. Model comparisons use the **corrected repeated k-fold t-test** (Bouckaert & Frank 2004): t = mean(d) ÷ √((1/(k·r) + n_test/n_train) · var(d)), with df = k·r − 1 = 24. The Bonferroni family is the 6 pairwise comparisons. Reason: with a single 5-fold run the corrected test would almost always call a tie. The estimated cost is about 18 min in total.
     - **Search budget: 20 configurations per candidate**, equal for all four, inner 3-fold subject-grouped search. The search spaces are written in `config.py` before any run.
     - **The tuning score is person-weighted** (ROC-AUC with each clip weighted 1 ÷ its person's clips), matching the training weights. In scikit-learn 1.9, weights reach each step only with metadata routing enabled and every step's request declared explicitly. So a **test confirms the weights reach every step** (model fit, the tuning scorer, calibration), and that the scaler deliberately receives none.
     - **Pre-registered reporting rule:** person-weighted metrics (each person counts equally) are **primary**, and unweighted (per-clip) metrics are reported alongside, everywhere: CV, 5.1 and the 5.2 test set.
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
6. **Pre-registered sensitivity analysis (D6 option B, 2026-09-28):** the same frozen model, evaluated on the test clips **wholly over 70** in both classes (`eligibility.over_70_sensitivity`). Same metrics and subject-bootstrap CIs, reported next to the main result whatever it shows. Not a separate model; not used for selection or the threshold. It will have few test subjects (about 33 dementia people are over 70 after the 30 s minimum, so roughly 7 in the test set), so its CIs will be wide, and that is stated.
7. **Pre-symptomatic score trajectory (descriptive only; proposed 2026-09-28 with D7, never used for training, selection or the threshold):** does the model's score rise as symptom onset approaches?
   - Each dementia clip in buckets 15, 10, 5 and 0 is scored by a model that **never saw that person**: out-of-fold models from Stage 4's CV for training-portion subjects, the final model for test subjects. Under D7 = (c), the 10–15-year clips never enter training at all. A 10–15-year clip belonging to someone in the training portion is scored by the out-of-fold model for that person's fold; one belonging to a test person is scored by the final model.
   - D7 status: decided 2026-09-28 (option c), so this analysis is pre-registered as written.
   - Report, per bucket: clip and subject counts, and the median calibrated score with a 95 % subject-bootstrap CI, drawn against the controls' out-of-fold score distribution as a reference.
   - One trend statistic: Spearman's ρ between years before onset (−15, −10, −5, 0) and score, clip level, with a subject-bootstrap CI.
   - One within-person view: for people with clips in 2 or more buckets, the share whose nearer-to-onset clip scores higher.
   - No significance-driven conclusions. Caveat, stated with the result: earlier buckets are also older recordings (older equipment, a different recording era) and younger ages, so a trend can't be attributed to cognition alone. The Stage 2 channel-by-timing check found no evidence of a difference in recording-quality proxies across buckets (18 people in the within-person comparison), which doesn't rule out the equipment explanation.
8. **Pre-registered sensitivity analysis (D7, 2026-09-28):** the same frozen model, evaluated on the test set with dementia cases restricted to clips from onset to 5 years before (`eligibility.near_onset_only`); controls unchanged. Reported next to the main result whatever it shows; never used for model selection or the threshold.

### 5.3 Final report

`results/05_model_evaluation/final_report.md` with figures: dataset makeup, pause-detector validation, per-feature class differences, model comparison, calibration curves, robustness curve, language-shift plot (if done), test confusion matrix and ROC curve. Every number cited to a file.

### Tests

Test-set guard: only the final-evaluation module can load test data.

**Checkpoint 5:** results reviewed; limitations written.

---

## Decisions needed from the developer

| ID | Decision | Needed by |
|---|---|---|
| D1 | If the listening audit finds other voices in many recordings: (a) accept and state it as a limitation, (b) add speaker separation, or (c) keep only recordings judged single-speaker. Deployment audio (caregiver visits) will also contain two speakers, so this affects the live system too. Note (developer, 2026-09-28): option (b) changes the audio the features are extracted from, not only the split, so it would affect Stage 3 onward too; the split, folds, annotation sample and feature extraction all wait for D1. | Checkpoint 1 |
| D2 | Imbalance handling: class weights or in-fold SMOTE, based on Stage 1's measured balance. **Decided 2026-09-28:** class weights, with each recording weighted 1 ÷ its subject's clip count, then classes balanced (Stage 2 step 8). | Stage 2 |
| D3 | Add logistic regression as a baseline alongside RF, SVM and XGBoost | Stage 4 scoping |
| D4 | Whether to use Kenyan-language corpora for the language-shift check (check licences first) | Before 5.1 |
| D5 | Operating threshold: favour catching more cases or fewer false alarms. Needs supervisor input. | Before 5.2 |
| D6 | Age at recording differs by class: controls were deliberately sampled below 55, at 55–70 and over 70, while dementia clips are mostly over 55 (Stage 1 step 11). **Decided 2026-09-28:** option A, both classes wholly 55+ (primary); option B, over 70, as a 5.2 sensitivity analysis only; no reweighting. | Checkpoint 1 (before the split) |
| D7 | Label timing: dementia clips from 5–15 years before symptom onset may carry no signs yet. (a) Keep all option-A clips (after the 30 s minimum: dementia 86 clips / 64 people, controls 178 / 118), or (b) keep only dementia clips after onset or 0–5 years before (dementia 49 / 40, controls unchanged). Counts were computed with the first trimming rule (commit `ac3b382`); the current run is in `results/02_data_processing/summary.md`; the Stage 5 trajectory analysis (5.2 step 7) is descriptive either way. **Decided 2026-09-28: (c), dementia clips from onset to 10 years before** (72 clips / 54 people). The 10–15-year clips go only to the Stage 5 trajectory analysis, never to training or selection. The onset–5-year restriction is a pre-registered 5.2 sensitivity analysis (step 8). | Before the split |

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
8. **Demographics (added 2026-09-28, corrected the same day):** the metadata sheet gives birth year and gender, but there are no recording dates. So age at recording is known only as a bucket or range (Stage 1 step 11). D6 restricts both classes to 55+, but **residual age confounding within the bands remains**: the classes can still differ in age inside 55–70 and over 70, and exact ages are unknown. Both age and sex affect voice and timing features.
9. **Filename-only control ages (added 2026-09-28):** 70 of 131 controls are missing from the metadata sheet, so their age band rests only on the file-name suffix convention. That convention was checked on the 61 controls in the sheet: 55 match exactly and 6 don't. 5 of those 6 are only missing a clip the sheet lists, and 1 genuinely conflicts. So a small share of filename-only bands may be wrong.
10. **Calibrated probabilities reflect this dataset, not the real world (added 2026-09-28):** calibration is fit on this dataset's class balance (31 % dementia by person in the training pool, after D6 and D7). Real-world prevalence among caregiver-visited dependants will differ, so the probability is a relative screening score, not a real-world risk. A prior-shift adjustment would need a known deployment prevalence.
11. **Small test set (added 2026-09-28):** after D6 and D7, the held-out test set is expected to hold about 11 dementia and 24 control people. Test-set confidence intervals (subject bootstrap) will be wide, and the two sensitivity subsets smaller still.
12. **Speakers able to produce 30 s of speech (added 2026-09-28):** results apply only to speakers able to produce at least 30 s of speech after trimming. The minimum removed 9 of 84 dementia people entirely, all of whose clips were short (median 17.5 s). No explanation is offered for why their clips are short: the Stage 2 descriptive comparison doesn't support a "more impaired" explanation (their clips come from after onset less often, 9 % vs 22 %, only 11 clips).

---

## Review notes carried to later stages (2026-09-28)

Raised in the scoping review and deliberately not acted on yet. Each is decided at the named stage's scoping:

- **Stage 4, selection rule:** fold-paired t-tests on CV scores are anti-conservative, because the training portions of different folds overlap. The Nadeau-Bengio corrected resampled t-test is the standard correction and is recommended in place of the plain t-test.
- **Stage 3.2, annotation eligibility:** requiring 70 s of trimmed audio favours longer recordings. Report the sampled recordings' durations next to the dataset's, so any bias is visible.
- **Stage 4, calibration with D2's weights, decided 2026-09-28:** class-balanced training weights shift a model's raw probabilities towards 50 %. So the calibrator is fit with the **per-person weights only** (1 ÷ that subject's clips), without class balancing. Every person counts equally, and the calibrated output reflects the dataset's own class balance rather than a forced 50 % prior.

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
