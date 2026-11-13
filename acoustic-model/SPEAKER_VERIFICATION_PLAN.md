# Mzazi Care: Speaker Verification Module

## Development Plan

**Status:** paused on 2026-11-09 by the developer, and not merged into `dev`, so that testing of the other features can go first.
The pipeline code exists and passed a small end-to-end test, but the LibriSpeech run did not happen, so there are no meaningful results or charts.
The plan needs supervisor sign-off before integration, because it would add a module and change the project's objectives and design (see "Documents to update").

**Redesigned 2026-11-12 (developer):** a visit is now **two recordings**, the caregiver's and then the dependant's, each at least 10 seconds.
Each recording is checked against one enrolled voiceprint, so separating two speakers in one recording is no longer needed. AfriVoices-KE access was granted the same day, and the developer accepted its terms.

**Audience:** the developer and the coding agent.
The agent treats this file as the source of truth, stops at the decision gates, and proposes changes instead of silently deviating.

**Relationship to the acoustic model:** a module in the `acoustic-model` folder.
It shares the repository, the stage structure and the ground rules, but not the cognitive model's results, environment or test set.

## Changes from the original

Recorded 2026-11-09, after checking the original draft against the code on `dev`.

| # | Original draft | Why it changed | Now |
|---|---|---|---|
| 1 | Voice added to face liveness, with a face fallback | Face match has been removed from the system | Voice is additional to QR check-in, and a failure falls back to the QR result or a supervisor override |
| 2 | The dependant's segments feed the cognitive model and a risk score is returned | The cognitive model is not part of the system, and `riskScore` was dropped by migration 0017 | Removed |
| 3 | Integrate into the existing `acoustic-model` Lambda | No such Lambda, image or serving code exists | SV6 would be new infrastructure, decided at Gate 4 |
| 4 | Voiceprints stored in the `biometric-enrollments` bucket | That bucket has been removed | SV6 needs a new encrypted store, decided at Gate 4 |
| 5 | The dependant answers for at least 30 seconds | The caregiver app caps the whole recording at 30 seconds | Both speakers fit inside 30 seconds. A longer recording would be a separate product change. **Superseded by 9** |
| 6 | No protection for the cognitive model's locked test set | 35 people are locked in `results/02_data_processing/splits.csv` | They are excluded by a tested guard, and `test_set_used.json` is untouched |
| 7 | Shared environment | `venv` is pinned for the v2 and v3 results | Separate `venv-speaker` and `requirements-speaker.txt` |
| 8 | VoxCeleb1 first for the sanity check | Waiting for dataset access | LibriSpeech is added as development data only, see "Development data" |
| 9 | One 30-second recording with both speakers, split into 1.5-second windows labelled caregiver, dependant or unknown | Developer, 2026-11-12: a fixed order in two separate recordings is realistic and simpler | Two recordings, the caregiver's then the dependant's, at least 10 seconds each. Each is scored on all its speech against one voiceprint. Window labelling, two-speaker mixing and the speech-seconds rules are removed |
| 10 | AfriVoices-KE pending | Access granted and terms accepted by the developer, 2026-11-12 | Unscripted speech from four languages is the main dataset, see "AfriVoices-KE subset". The scripts take `SV_DATASET=afrivoices`, and the steps that score the test set refuse to run on it until Gate 3 |

## 0. Goal and scope

### Goal

From the visit's two recordings, confirm that **the caregiver's is the enrolled caregiver and the dependant's is the enrolled dependant**.
This is **speaker verification**: two yes or no checks against two specific stored voiceprints.
It is not identification ("which of N people is this?").

### In scope

- A pretrained speaker-embedding model, used **frozen**.
- Enrolment: one voiceprint per person from about 30 seconds of speech.
- Checking each of the visit's two recordings against one enrolled voiceprint.
- Thresholds and decision rules, chosen on calibration data and frozen before testing.
- Evaluation of fraud scenarios, including a simple replay test if a pilot exists.
- Integration only if Gate 4 approves it.

### Out of scope

| Excluded | Reason |
|---|---|
| Replacing QR check-in | A recording of the dependant's voice is easy to fake. Voice is an **additional** factor |
| Closed-set identification | It would need retraining whenever someone enrols, and can't reject strangers reliably |
| Training or fine-tuning a speaker model | It needs thousands of speakers, and pretrained models already exist. Only revisited at Gate 3 if the frozen model fails |
| On-device inference | The caregiver controls the phone, so a decision made on the device is easier to tamper with |
| A trained anti-spoofing model | A research project in itself. Replay is tested and reported where possible, and a detector is future work |

## Ground rules

- **Verification framing everywhere.** Metrics, splits and thresholds are per verification trial, not per class.
- **Speaker-disjoint evaluation.** The people used to choose thresholds must not appear in the test set.
- **Session-level leakage rule.** A speaker's enrolment and test audio must come from different recordings, and an automated test fails if any recording is used for both.
- **Pre-register.** Thresholds, decision rules and targets are written down before the results they judge exist. The test set is scored once.
- **Every number traces to a file.** Anything that can't be traced is marked "unverified".
- **Consent and privacy.** Voiceprints are biometric data under the Kenya Data Protection Act. Any recordings of real people need documented consent and, if required by the university, ethics approval. Raw audio and voiceprints are never committed to git.
- **Licences are checked, not assumed.** If terms are unclear about this use (verifying caregivers' presence could be read as monitoring workers), ask the dataset owners or don't use it.
- **Locked test set.** Nobody in the cognitive model's locked test set enters this module's data.
- **Proportionate testing.** Unit tests for leakage, clip slicing and decision logic, not for thin wrappers.
- **Checkpoints.** The agent never commits, and the developer does.

## 1. Where it lives

```
acoustic-model/
  requirements-speaker.txt
  src/mzazi_acoustic/speaker_verification/
    vad.py        voice activity detection
    embed.py      voiceprint from a waveform
    enrol.py      enrolment voiceprint from about 30 s of speech
    verify.py     score one recording against the voiceprint it claims
    decide.py     visit-level decision and threshold calibration
    trials.py     splits, trial lists and simulated visits (evaluation only)
    metrics.py    EER, minDCF, error rates, bootstrap by speaker
  scripts/sv_01_collect.py to sv_06_figures.py
  results/speaker_verification/   one file per stage, and charts in figures/ for each dataset
  tests/speaker_verification/
```

## Development data

LibriSpeech (CC BY 4.0) is used to build and debug the pipeline. AfriVoices-KE access was granted on 2026-11-12 and the developer accepted its terms (Gate 2).
It is English audiobook reading in clean conditions, so it says nothing about Kenyan languages, phones in homes, older voices or real conversations.

- Results go to `results/speaker_verification/dev_librispeech/`, each headed "development data only".
- Thresholds and the X and Y speech rules from this run are never carried over.
- No pass or fail is declared against the targets.
- The score-once marker applies only to the real test set.
- Chapter ID stands in for a recording, so enrolment and test audio come from different chapters.
- The pipeline check is my own: on clean 30-second audio, EER is below 5%. It does not replace the VoxCeleb1 sanity check below.

## Stage SV0: framing and setup

1. Collect the open inputs (see the last section).
2. **Visit recording protocol** (decided 2026-11-12). Two recordings, in a fixed order: the caregiver speaks for at least 10 seconds, then the dependant speaks for at least 10 seconds, for example answering an open question. Each recording is checked against its own enrolled voiceprint. A recording with less than 5 seconds of detected speech (proposed) is "too short" and goes to a supervisor.
3. **Enrolment protocol.** About 30 seconds of natural speech per person, at registration.
4. Add the module's settings to `config.py`.
5. **Fraud scenarios**, agreed before any data is used:

| Scenario | Expected decision |
|---|---|
| Caregiver and dependant both present | Pass |
| Caregiver alone, speaking in both recordings | Fail (dependant absent) |
| Caregiver with a different elderly person | Fail (dependant mismatch) |
| Someone else instead of the caregiver, with the dependant | Fail (caregiver mismatch) |
| Caregiver plus a recording of the dependant played from a phone (replay), including the dependant's recording from an earlier visit | Should fail. Expected to be weak, and reported honestly |

**Deliverable:** `results/speaker_verification/00_framing.md`.
**Gate 1:** approval of the scenarios, protocols and targets.

### Targets

The false accept target was changed from 1% to 10% by the developer on 2026-11-09, with the supervisor's agreement.
A fraudulent visit could pass about 1 time in 10, so a voice result is one signal among several and is never proof on its own.

- Visit-level false accept rate (a fraud scenario passes): **10% or lower**.
- Visit-level false reject rate (a genuine visit fails): **5% or lower**, since a failure falls back to the QR result or a supervisor.
- Processing time per visit recording: **under 10 seconds**.
- All results also broken down by language, noise level and enrolment-to-visit gap.

## Stage SV1: data collection

| Dataset | Use | Notes |
|---|---|---|
| **LibriSpeech** | Development only | CC BY 4.0, ungated. No target is judged on it |
| **VoxCeleb1** | Standard benchmark, sanity check | Celebrity interviews, research purposes, access by request |
| **Mozilla Common Voice** (English and Swahili) | Phone-like recordings, Swahili speakers, impostor trials | Terms unconfirmed |
| **AfriVoices-KE** | Kenyan-language, smartphone-recorded speakers (Dholuo, Kikuyu, Kalenjin, Maasai, Somali). No Swahili or English | Access granted 2026-11-12: gated Hugging Face repos `Anv-ke/<language>`, with a combined mirror at `MCAA1-MSU/anv_data_ke`. The cards state no licence, so **only if the accepted terms clearly permit this use**. Speaker IDs and recordings per speaker to be confirmed from `meta.csv` |
| **DementiaNet** (already held) | Voice change across years and with cognitive decline | No licence stated, see `00_framing.md`. Locked test people excluded |
| **Small volunteer pilot** (optional) | Real phones and the real protocol | Needs consent forms and, if required, ethics approval |

Per dataset, audit speakers, recordings per speaker, minutes, languages, sample rates, corrupt or silent files, and possible duplicates, as a short data card.

### AfriVoices-KE subset (decided 2026-11-12)

- **Languages:** Dholuo, Kikuyu, Kalenjin and Maasai. Somali isn't accessible to this account. Revisions are pinned in `config.AFRIVOICES_REPOS`.
- **Speech:** unscripted (spontaneous) only, approved recordings only.
- **Speakers:** everyone in `dev` and `dev_test` (the `main` group), plus the 51+ age band from `train` (the `older` group), since `dev` and `dev_test` hold only 5 speakers over 50. The splits share no speakers, and the collector refuses to run if they ever do.
- **Sessions:** a recording's day, taken from the millisecond timestamp in its file name (Nairobi time), stands in for a session. A speaker is a caregiver or dependant in a simulated visit only if enrolment and test come from **different days**. Speakers with one day act only as strangers.
- **Kept audio:** per speaker, up to 90 s from each of the two days with the most audio, as 16 kHz mono FLAC. Each parquet block must be read whole, so the collector streams the needed blocks and discards the rest.
- **Sex:** strangers are matched by sex, so speakers whose sex isn't recorded are left out and counted.
- **Split:** stratified by language, group, sex and eligibility.

**Deliverable:** `results/speaker_verification/01_data.md`, and `results/speaker_verification/afrivoices/01_data.md` for AfriVoices-KE.
**Gate 2:** approval before any non-public or newly requested data is used.

## Stage SV2: data processing and trial construction

1. **Standardise** to 16 kHz mono.
2. **Voice activity detection:** Silero VAD, with settings fixed in `config.py` and never tuned against test results.
3. **No windows.** Each visit recording is scored on all of its speech, and enrolment uses all speech in the sample.
4. **Speaker-disjoint split** into calibration and test, stratified by dataset, language and sex where recorded.
5. **Verification trials:** target trials are the same person across different recordings, and impostor trials are different people matched by sex and language where possible.
6. **Simulated visits:** two recordings per visit, for every fraud scenario, each cut from a speaker's test audio (never their enrolment audio).
   The caregiver's recording and the dependant's come from separate parts of the test audio, so a caregiver alone never repeats the same audio in both.
   The primary setting is 8.5 seconds of speech per recording (10 seconds at 85% speech), with variations of 5 and 17 seconds.
   Real recordings from a pilot are reported separately.

**Tests:** no speaker in both calibration and test, no recording used for both enrolment and test, simulated visits contain exactly the intended speakers, and a visit's two recordings never share audio.

**Deliverable:** `02_processing.md`.
**Gate 3a:** check of the split.
Passed by the developer on 2026-11-12 for AfriVoices-KE (272 speakers, 189 eligible, 46 calibration and 48 test visits per scenario), on two conditions for the report: older-speaker results are indicative only (about 21 eligible test speakers, no older Maasai women), and the confidence intervals are wide at about 48 genuine visits.
Test speakers are not scored until SV4's rule is copied into `config.SV_FROZEN_RULE` (`sv_03_embed.py` checks it).

## Stage SV3: voiceprints

| ID | Approach | Role |
|---|---|---|
| **B0** | MFCC mean and variance with cosine similarity | Weak baseline |
| **E1** | **ECAPA-TDNN, pretrained on VoxCeleb (SpeechBrain), frozen** | Main candidate. Published EER on VoxCeleb1 is about 1% |
| **E2** | A second pretrained model | Only if E1 misses the targets on calibration data, with Gate 3 approval |

Voiceprints are computed once and cached.
Similarity is cosine, and score normalisation is added only if calibration shows a clear benefit.
**Sanity check:** reproduce E1's published VoxCeleb1 accuracy approximately if access arrives.
There is no substitute, so without access the final results are reported with the published accuracy marked as not reproduced.

**Deliverable:** `03_embeddings.md`.
**Gate 3:** confirmation of the model.
Passed by the developer on 2026-11-13: E1 is confirmed and E2 is not needed. On AfriVoices-KE calibration speakers, clean trials with enrolment and test from different days, E1's EER is 0.067 at 3 s, 0.034 at 5 s and 0.022 at 10 s and 30 s, against B0's 0.195 to 0.261. Each figure rests on 93 target trials, so one miss moves it by about 0.011. The published VoxCeleb1 figure is not reproduced, as there is no access. Median scoring time is about 3 s per visit on a Colab CPU.

## Stage SV4: calibration

All choices use **calibration speakers only** and are frozen at the end of the stage.

1. **Threshold** on cosine similarity, one for both recordings: the one with the fewest false rejects among those keeping every fraud scenario's false accept rate at or below the target.
2. **Visit decision rule:** a visit passes only if both recordings match their claimed voiceprints. Each recording is a match, a mismatch, or too short to judge.
3. **Minimum speech:** fixed before any data (5 seconds proposed at Gate 1), not tuned. Too-short recordings are counted and reported.
4. **Write everything** to `config.py` and the dev log, with how each value was chosen. Values from development data are not written to `config.py`.

**Deliverable:** `04_calibration.md`.

**Frozen 2026-11-13 by the developer** on AfriVoices-KE calibration speakers (primary setting: 8.5 s of speech per recording, pink noise at 20 dB, 30 s enrolment): both recordings must match at cosine 0.5 or above, with at least 5 s of speech each, set as `config.SV_FROZEN_RULE`.
On the 46 calibration visits per scenario: false reject 0.065 (3 of 46) against the 5% target, so it is **missed by one visit on calibration data**. False accept is 0.022 for caregiver alone, 0.087 for a different dependant and 0.043 for a different caregiver, all within 10%.
The threshold and targets were deliberately not adjusted after seeing these figures. The `clip_20s` test condition shows whether longer recordings would meet both targets, which is a product question for Gate 4.

## Stage SV5: evaluation

Scored **once**, on test speakers, with everything frozen.

### Core results

- Trial level: EER, false accept and false reject rates at the frozen threshold, DET curve.
- Visit level: false accept rate per fraud scenario, and false reject rate for genuine visits.
- 95% confidence intervals by bootstrap resampling of **speakers**.
- B0 and E1 comparison table.

### Robustness

- **Channel:** phone-like band limiting and added noise at several SNR levels, reusing `common/degradation.py`.
- **Speech length:** enrolment of 10, 20 and 30 seconds, and per-person visit speech of 5, 10 and 20 seconds.
- **Language:** enrol in English and verify in Swahili, and the reverse, if any dataset links one person across languages.
- **Time and decline:** with DementiaNet, if permitted, how similarity between one person's clips falls as the years between them grow. This informs a re-enrolment interval.
- **Replay:** if a pilot exists, play enrolled recordings through a phone speaker and re-record them. Without a pilot, replay is an untested risk.

### Practical and errors

Processing time and memory per visit recording, cold start, and added container size.
Listen to a sample of false accepts and false rejects, and note patterns.

**Deliverable:** `05_evaluation.md` with a verdict against each target.
**Gate 4:** review before integration.

### Result, 2026-11-13 (AfriVoices-KE test speakers, scored once)

- **False reject target not met:** 25.0% of genuine visits (12 of 48, interval 12.5% to 37.5%) against 5%. The whole interval is above the target.
- **False accept targets met:** caregiver alone 2.1%, different dependant 4.2% (interval reaching 10.4%), different caregiver 2.1%, against 10%.
- **Trials:** E1's clean 30-second EER is 6.1% (2.1% to 10.4%), against 2.2% on calibration speakers, so the pipeline check (below 5%) is not met. With about 95 target trials each, chance can't be separated from these speakers being harder.
- **Why visits fail more than trials:** at the frozen threshold of 0.5 each recording misses about 12% of the time, and a visit needs both, so 1 - 0.88^2 is about 25%. False accepts on these speakers (2% to 4%) suggest the threshold is stricter than they needed, but it was not re-tuned on the test set.
- **The 12 failed genuine visits:** 9 voice mismatches (6 on the caregiver's recording, 3 on the dependant's) and 3 with too little speech (2 caregiver, 1 dependant). A few very low scores (0.18, 0.22) point to some bad recordings rather than a near-miss threshold.
- **Variants:** 20-second recordings 16.7%, clean audio 22.9%, 10-second enrolment 35.4%. Enrolment length matters most, and noise least.
- **Flaw in the `clip_5s` condition:** it gives each recording exactly `SV_MIN_CLIP_SPEECH_SECONDS` (5.0 s) of speech, and VAD always detects slightly less, so 378 of 384 recordings were too short by construction. Its 100% false reject says nothing about 5-second recordings. It does not affect the primary verdict.
- **A fresh test set exists** if this is revisited: AfriVoices-KE `train` speakers under 51 were never used.

### Gate 4 decision, 2026-11-13 (developer)

Evaluation stops here. The developer chose to integrate it as a **proof of concept**, not a production feature, knowing the false reject target was missed.
Before any real person is enrolled: Terms v4 and fresh consent (`backend/src/terms.ts` tells caregivers and families that recordings are "not analysed by any automated system"), and supervisor sign-off, since this changes the project's objectives and design.

POC scope, decided the same day (the first item later superseded, see "Built" under SV6):
- ~~**Test accounts only.**~~ Superseded the same day: the voice check runs on **every visit**, with consent mandatory through Terms v4.
- **Advisory only.** A failed or missing check never blocks a visit or changes whether it counts. The result (match, mismatch or too short, with score and seconds of speech, per recording) is stored and shown to supervisors.
- **The full flow:** the voice Lambda, an encrypted voiceprint store, database changes, the caregiver app's enrolment screen and two-recording visit flow, and a supervisor view in the web console.

## Stage SV6: integration, only if Gate 4 approves

This is new infrastructure and a change to what the system promises people.

- A new Python container Lambda with `enrol` and `visit` modes, and a new encrypted store for voiceprints.
- `visit` takes the two recordings and returns, for each, match, mismatch or too short, with its score and seconds of speech.
- A `voice_enrollments` table, a `voice_verification` consent type, and a `voice` attempt type.
- Terms v4, because the current terms state that recordings are "not analysed by any automated system".
- App screens for voice enrolment, and a visit flow that records the caregiver and then the dependant, each with a 10-second timer. This replaces the single 30-second recording (change 5).
- The voice check is required on every visit. It runs on the recording after check-in, so it decides whether the visit counts as fully verified. A failed or missing result goes to a supervisor rather than blocking the visit.
- A result is advisory to a supervisor and never marks a visit or caregiver automatically.
- Voiceprints are deleted on offboarding, and audio and voiceprints never appear in logs.

### Built, 2026-11-13 (branch `feat/voice-verification-poc`)

Decided with the developer, replacing the proposal above where they differ:

- **Every visit, consent mandatory.** Terms v4 adds a third required box (voice verification) to both apps. A revoked consent is never analysed (`no_consent`).
- **Two recordings replace the 30-second family recording**: the caregiver's (always required) and the dependant's (or one of the existing reasons). The family plays the dependant's.
- **Enrolment:** caregivers in the caregiver app, dependants by a linked family member in the family app, about 30 s each, at least 20 s of speech.
- **Check-out is confirmed by the family**, like check-in: the caregiver requests it, the family member who facilitated check-in (any linked one after a supervisor override) shows a QR code with 6 digits, and the caregiver scans or types it. If neither works, the caregiver gives a reason and the visit completes at once; it appears as a `checkout_override` exception. Nobody approves it.
- **Advisory only:** a voice check never blocks a visit or changes whether it counts. Supervisors see results and scores (visit details, a Voice checks tab); caregivers and families never see scores.

How it runs:

- `acoustic-model/voice_service/`: a Python container Lambda (`enrol`, `verify`, `remove`) reusing `vad.py`, `embed.py`, `enrol.py`, `verify.score_clip` and `decide.check_clip` unchanged, with `config.SV_FROZEN_RULE` (cosine 0.5, at least 5 s of speech). ECAPA at revision `0f99f2d0` is baked into the image and loaded offline; AAC is decoded with a pinned ffmpeg (`imageio-ffmpeg`).
- `infra/lib/voice.ts` and `storage.ts`: no VPC or database access, 3008 MB, 60 s; invokable only by the API; a voiceprint bucket with its own rotating KMS key. The API's timeout went from the 3 s default to 28 s.
- `backend/src/voiceService.ts` calls it with a 20 s limit; a timeout or error is stored as `unavailable`. `voiceChecks.ts` stores each result; migration 0019 adds `voice_enrollments`, `voice_checks` and the check-out columns.
- Checked locally inside the image, offline, on LibriSpeech audio encoded as AAC: same speaker 0.85 (match), different speaker -0.03 (mismatch), a 4 s clip too short. Local cold start 2.6 s and 0.7 s per check; Lambda's cold start is not yet measured.

Not done: a CloudWatch alarm for the voice Lambda (the project's 5-alarm budget is full), a replay test, and a real-world pilot.

## Decision gates

1. After SV0: scenarios, protocols and targets.
2. Before using any non-public or newly requested data.
3. After SV2 (split) and SV3 (model choice).
4. After SV5: results, before integration.

## Open inputs

| Input | Why it matters | Value |
|---|---|---|
| Supervisor approval of the module | It changes objectives and design | The developer reports no objection (2026-11-09). Confirm it covers storing voiceprints before integration |
| Languages used during visits | Decides which datasets and language tests matter | English, Swahili, Kikuyu, Dholuo |
| Target false accept and reject rates | Sets the thresholds | 10% false accept, 5% false reject (both decided) |
| Voice as required factor or fallback | Changes the visit flow | Required (decided 2026-11-09). A visit needs a voice result to count as fully verified, and a failed or missing result goes to a supervisor |
| What happens when someone refuses voice enrolment or can't speak for 10 seconds | Required biometrics with no alternative may not be valid consent | TBD before integration |
| Recording protocol | Sets the protocol | Two recordings, the caregiver's then the dependant's, at least 10 seconds each (decided 2026-11-12). Minimum detected speech per recording: 5 seconds, proposed |
| AfriVoices-KE terms and structure | Gate 2, and whether enrolment and test can come from different recordings | Access granted and terms accepted by the developer, 2026-11-12. Four repos (not Somali). `recorder_uuid` is the speaker, and each recording is its own file, with its day in the file name |
| Volunteer pilot, yes or no | Decides whether replay and real visit-recording tests are possible | Yes (decided). Needs consent forms and Gate 2 approval before recording |
| Ethics approval route | Required before recording volunteers | Not required by the university (developer, 2026-11-09). Documented consent is still required |
| VoxCeleb fallback if access is delayed | The sanity check can block SV5 | None (decided 2026-11-09). If access does not arrive, the report states that the published accuracy was not reproduced |
| Deadline | Decides whether E2 or the pilot fit | Under a week |

## Known limitations to state

1. No labelled recordings of real caregiver visits, so visit-level results come from recordings cut from single-speaker audio.
2. The two recordings are checked separately, so voice alone doesn't show they were made together, at the visit. A dependant's recording from an earlier visit could be reused (replay, below). A near-duplicate check against past visits' recordings is possible future work.
3. AfriVoices-KE speakers are mostly 18 to 40. The `older` group is small, and nothing here stands in for elderly or cognitively impaired voices. A day stands in for a session, and whether a speaker used the same phone each day isn't recorded.
4. Pretrained models are trained mostly on non-Kenyan speech, and performance on Kenyan languages and accents is measured only as far as available data allows.
5. Replay is tested at most on a small pilot, and there is no anti-spoofing model.
6. Dependants' voices may change with progression, so a re-enrolment interval is an estimate.
7. Elderly and impaired speakers may speak little, lowering accuracy.

## Documents to update if approved

- Chapter 1: objectives.
- Chapter 3: methodology and datasets.
- Chapter 4: functional, non-functional and data requirements.
- `docs/architecture.md`: the new Lambda, container size and memory.
- `docs/schema.sql`: `voice_enrollments`, new consent and attempt types.

## Sources

- Desplanques, Thienpondt and Demuynck (2020), ECAPA-TDNN. https://arxiv.org/abs/2005.07143
- SpeechBrain pretrained ECAPA-TDNN (VoxCeleb). https://huggingface.co/speechbrain/spkrec-ecapa-voxceleb
- Nagrani, Chung and Zisserman (2017), VoxCeleb. https://arxiv.org/abs/1706.08612
- Chung, Nagrani and Zisserman (2018), VoxCeleb2. https://arxiv.org/abs/1806.05622
- Ardila et al. (2020), Common Voice. https://arxiv.org/abs/1912.06670
- AfriVoices-KE. https://arxiv.org/abs/2604.08448
- LibriSpeech. https://www.openslr.org/12
- ASVspoof challenge. https://www.asvspoof.org/
