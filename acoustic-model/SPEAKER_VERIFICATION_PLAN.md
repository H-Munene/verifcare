# Mzazi Care: Speaker Verification Module

## Development Plan

**Status:** paused on 2026-11-09 by the developer, and not merged into `dev`, so that testing of the other features can go first.
The pipeline code exists and passed a small end-to-end test, but the LibriSpeech run did not happen, so there are no meaningful results or charts.
The plan needs supervisor sign-off before integration, because it would add a module and change the project's objectives and design (see "Documents to update").

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
| 5 | The dependant answers for at least 30 seconds | The caregiver app caps the whole recording at 30 seconds | Both speakers fit inside 30 seconds. A longer recording would be a separate product change |
| 6 | No protection for the cognitive model's locked test set | 35 people are locked in `results/02_data_processing/splits.csv` | They are excluded by a tested guard, and `test_set_used.json` is untouched |
| 7 | Shared environment | `venv` is pinned for the v2 and v3 results | Separate `venv-speaker` and `requirements-speaker.txt` |
| 8 | VoxCeleb1 first for the sanity check | Waiting for dataset access | LibriSpeech is added as development data only, see "Development data" |

## 0. Goal and scope

### Goal

From the visit recording, confirm that **both the enrolled caregiver and the enrolled dependant are speaking**.
This is **speaker verification**: two yes or no checks against two specific stored voiceprints.
It is not identification ("which of N people is this?").

### In scope

- A pretrained speaker-embedding model, used **frozen**.
- Enrolment: one voiceprint per person from about 30 seconds of speech.
- Target-speaker segmentation of two-person visit recordings.
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
- **Proportionate testing.** Unit tests for leakage, segmentation and decision logic, not for thin wrappers.
- **Checkpoints.** The agent never commits, and the developer does.

## 1. Where it lives

```
acoustic-model/
  requirements-speaker.txt
  src/mzazi_acoustic/speaker_verification/
    vad.py        voice activity detection
    embed.py      voiceprint from a waveform
    enrol.py      enrolment voiceprint from about 30 s of speech
    segment.py    label windows: caregiver, dependant or unknown
    decide.py     visit-level presence decision and calibration
    trials.py     splits, trial lists and simulated visits (evaluation only)
    metrics.py    EER, minDCF, error rates, bootstrap by speaker
  scripts/sv_01_collect.py to sv_06_figures.py
  results/speaker_verification/   one file per stage, and charts in figures/ for each dataset
  tests/speaker_verification/
```

## Development data

LibriSpeech (CC BY 4.0) is used to build and debug the pipeline while AfriVoices-KE access is pending.
It is English audiobook reading in clean conditions, so it says nothing about Kenyan languages, phones in homes, older voices or real conversations.

- Results go to `results/speaker_verification/dev_librispeech/`, each headed "development data only".
- Thresholds and the X and Y speech rules from this run are never carried over.
- No pass or fail is declared against the targets.
- The score-once marker applies only to the real test set.
- Chapter ID stands in for a recording, so enrolment and test audio come from different chapters.
- The pipeline check is my own: on clean 30-second audio, EER is below 5%. It does not replace the VoxCeleb1 sanity check below.

## Stage SV0: framing and setup

1. Collect the open inputs (see the last section).
2. **Visit recording protocol.** The caregiver greets the dependant and asks an open question, and the dependant answers for at least 10 seconds, all inside the app's 30-second recording.
3. **Enrolment protocol.** About 30 seconds of natural speech per person, at registration.
4. Add the module's settings to `config.py`.
5. **Fraud scenarios**, agreed before any data is used:

| Scenario | Expected decision |
|---|---|
| Caregiver and dependant both present | Pass |
| Caregiver alone | Fail (dependant absent) |
| Caregiver with a different elderly person | Fail (dependant mismatch) |
| Someone else instead of the caregiver, with the dependant | Fail (caregiver mismatch) |
| Caregiver plus a recording of the dependant played from a phone (replay) | Should fail. Expected to be weak, and reported honestly |

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
| **AfriVoices-KE** | Kenyan-language, smartphone-recorded speakers | **Only if its terms clearly permit this use** |
| **DementiaNet** (already held) | Voice change across years and with cognitive decline | No licence stated, see `00_framing.md`. Locked test people excluded |
| **Small volunteer pilot** (optional) | Real phones and the real protocol | Needs consent forms and, if required, ethics approval |

Per dataset, audit speakers, recordings per speaker, minutes, languages, sample rates, corrupt or silent files, and possible duplicates, as a short data card.

**Deliverable:** `results/speaker_verification/01_data.md`.
**Gate 2:** approval before any non-public or newly requested data is used.

## Stage SV2: data processing and trial construction

1. **Standardise** to 16 kHz mono.
2. **Voice activity detection:** Silero VAD, with settings fixed in `config.py` and never tuned against test results.
3. **Windows:** 1.5 seconds with a 0.75-second hop for segmentation. Enrolment uses all speech in the sample.
4. **Speaker-disjoint split** into calibration and test, stratified by dataset, language and sex where recorded.
5. **Verification trials:** target trials are the same person across different recordings, and impostor trials are different people matched by sex and language where possible.
6. **Simulated visits:** two-speaker recordings built from single-speaker clips, with turn-taking, short overlaps and pauses, at dependant speech shares of 20 to 60%, for every fraud scenario.
   Real two-speaker recordings from a pilot are reported separately.

**Tests:** no speaker in both calibration and test, no recording used for both enrolment and test, simulated visits contain exactly the intended speakers.

**Deliverable:** `02_processing.md`.
**Gate 3a:** check of the split.

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

## Stage SV4: calibration

All choices use **calibration speakers only** and are frozen at the end of the stage.

1. **Trial threshold** on cosine similarity, chosen to hit the target false accept rate.
2. **Segmentation rule:** each window is labelled caregiver, dependant, or unknown.
3. **Visit decision rule:** caregiver present if at least *X* seconds of windows match the caregiver, and dependant present if at least *Y* seconds match the dependant.
4. **Unknown speakers:** report the share of speech labelled unknown. A large share is logged for review.
5. **Write everything** to `config.py` and the dev log, with how each value was chosen. Values from development data are not written to `config.py`.

**Deliverable:** `04_calibration.md`.

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

## Stage SV6: integration, only if Gate 4 approves

This is new infrastructure and a change to what the system promises people.

- A new Python container Lambda with `enrol` and `visit` modes, and a new encrypted store for voiceprints.
- `visit` returns caregiver present, dependant present, scores, seconds and unknown speech seconds.
- A `voice_enrollments` table, a `voice_verification` consent type, and a `voice` attempt type.
- Terms v4, because the current terms state that recordings are "not analysed by any automated system".
- App screens for voice enrolment.
- The voice check is required on every visit. It runs on the recording after check-in, so it decides whether the visit counts as fully verified. A failed or missing result goes to a supervisor rather than blocking the visit.
- A result is advisory to a supervisor and never marks a visit or caregiver automatically.
- Voiceprints are deleted on offboarding, and audio and voiceprints never appear in logs.

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
| The dependant's minimum speech | Sets the protocol | 10 seconds (decided). Rule Y is still calibrated separately |
| Volunteer pilot, yes or no | Decides whether replay and real two-speaker tests are possible | Yes (decided). Needs consent forms and Gate 2 approval before recording |
| Ethics approval route | Required before recording volunteers | Not required by the university (developer, 2026-11-09). Documented consent is still required |
| VoxCeleb fallback if access is delayed | The sanity check can block SV5 | None (decided 2026-11-09). If access does not arrive, the report states that the published accuracy was not reproduced |
| Deadline | Decides whether E2 or the pilot fit | Under a week |

## Known limitations to state

1. No labelled recordings of real caregiver visits, so visit-level results come from simulated two-speaker recordings.
2. Pretrained models are trained mostly on non-Kenyan speech, and performance on Kenyan languages and accents is measured only as far as available data allows.
3. Replay is tested at most on a small pilot, and there is no anti-spoofing model.
4. Dependants' voices may change with progression, so a re-enrolment interval is an estimate.
5. Elderly and impaired speakers may speak little, lowering accuracy.

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
