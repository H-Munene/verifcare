# Acoustic Model: Weekly Assessment Summary

**Week of:** 2026-09-17
**Covers:** Phases 1 through 9 (of 12 planned)
**How to regenerate:** `python scripts/generate_weekly_assessment_charts.py` rebuilds every chart from the CSVs already in `results/`. This document is written by hand each week, but every number in it is cited to a specific file — see the Verification Appendix at the end. To extend this next week, copy this file's structure, add a "Phase 10" (etc.) section in the same format, and add one more chart function to the generator script if a new phase produces a chart-worthy result.

---

## The big picture

Mzazi Care is a system that helps a caregiver track an elderly dependant's cognitive wellbeing over time. As part of a regular check-in visit, the caregiver records a short voice interaction on their phone. This acoustic model is the piece of the system that listens to that recording and produces a non-diagnostic "trend signal" — not a diagnosis, but a number a supervisor can watch over time, the same way a nurse might watch a patient's blood pressure trend rather than treating any single reading as conclusive. Everything below is about how that model was built, tested, and stress-tested before it's ever allowed to make a real prediction.

---

## Phase-by-phase

### Phase 1: Dataset audit
We started by carefully checking the raw dataset (455 voice recordings from 215 people, some with dementia and some without) for problems before doing anything else with it — corrupted files, duplicate recordings, or hidden biases that could quietly wreck later results. We found the data was in good shape (no unreadable files, no true duplicates), but flagged one early, weak signal worth tracking: a subtle relationship between background recording quality and which group a file belonged to. It wasn't statistically strong enough to be a real concern on its own, but we kept an eye on it in later phases rather than dismissing it.
**Chart:** `figures/01_dataset_makeup.png` — how many people and recordings are in each group.
**Source:** `results/audit/audit_summary.md`, `results/audit/file_manifest.csv`.

### Phase 2: Preparing the audio
Every recording was trimmed of silence and standardized to the same audio format, since a machine-learning model needs consistent input. We also locked in which people's recordings the model is allowed to learn from ("train_pool": 172 people) versus a separate group it's never allowed to see until the very end ("test": 43 people) — this "held-out test set" is what proves the model works on people it wasn't trained on, not just people it memorized.
**Source:** `results/preprocessing/preprocessing_summary.md`, `results/splits/subject_splits.csv`.

### Phase 3: Extracting voice measurements
From each recording, we computed 88 standard voice-science measurements (things like pitch stability, breathiness, and voice quality) using a well-established, published measurement set (eGeMAPS) rather than inventing our own. We also specifically re-checked whether any of these measurements were secretly more about *recording quality* than about the *person's voice* — a real risk, since a noisier microphone shouldn't be mistaken for a health signal. One measurement ("shimmer," a voice-quality metric) was found to be genuinely entangled with background noise level; the others tested clean.
**Chart:** `figures/05_confound_check.png` — how strongly each voice measurement correlates with recording-quality indicators (one bar stands out; the rest don't).
**Source:** `results/features/feature_extraction_summary.md`, `results/features/channel_quality_cross_check.csv`.

### Phase 4: Choosing which measurements matter
88 measurements is too many to use all at once — many overlap or add noise rather than signal. We used a standard statistical method to rank them and found that just 20 of the 88 carry almost all the useful signal (using all 88 actually performs *worse* than using the best 20, a common effect when a model has more inputs than it has data to learn from). Reassuringly, the one voice-quality measurement flagged as noise-contaminated in Phase 3 ("shimmer") did **not** make this final list of 20.
**Source:** `results/feature_selection/selected_features.csv`, `results/feature_selection/k_selection_cv_scores.csv`.

### Phase 5: First model attempts
We trained four different, well-established types of prediction model on the 20 chosen measurements, to see which style of model suits this problem best, without tuning any of them yet. All four landed in a similar, modest performance range (roughly 61–64% on a 50–100% scale, where 50% is a coin flip). No winner was declared yet — that's expected at this stage. We also found that none of the four models' confidence scores could be trusted numerically yet ("is a 70% prediction really right 70% of the time?") — fixing that became Phase 7's job.
**Source:** `results/baseline_models/baseline_models_summary.md`.

### Phase 6: Tuning each model
Each model type has internal settings that can be tuned for better performance, similar to adjusting a recipe. We tuned all four candidates equally and fairly, using a technique that avoids a model "cheating" by tuning itself to already know the answer. One candidate (Logistic Regression) fell clearly behind and was dropped. The remaining three — XGBoost, Random Forest, and SVM — ended up statistically indistinguishable from each other after tuning.
**Chart:** `figures/02_model_performance_pipeline.png` — shows this convergence directly.
**Source:** `results/hyperparameter_tuning/hyperparameter_tuning_summary.md`, `results/hyperparameter_tuning/stage2_aggregated.csv`.

### Phase 7: Making confidence scores trustworthy
This phase fixed the "can we trust a 70% prediction to actually be right 70% of the time" problem from Phase 5, for all three remaining candidates. This meaningfully improved every candidate. While fixing it, we found and had to work around a real limitation in the specific software library used for one of the three models, rather than a limitation of the modeling approach itself. After the fix, the three candidates were *still* statistically tied — no clear winner yet.
**Chart:** `figures/03_calibration_curves.png` — how well each model's confidence scores matched reality (closer to the diagonal line is better; the small sample size here makes the lines noisy, which is itself an honest limitation worth naming, not hidden).
**Source:** `results/calibration/calibration_summary.md`, `results/calibration/calibration_ece.csv`.

### Phase 8: Breaking the tie
With three models still tied, we tried a specific tie-breaker: checking whether any of the three models was leaning heavily on the one noise-contaminated voice measurement flagged back in Phase 3. This check came back **inconclusive** — all three leaned on it similarly little, and not distinguishably differently from each other. So the actual tie-break ended up being a different, already-known number from Phase 7 (a measure of confidence-score accuracy): **XGBoost had the best score there**, so it became the one model we carry forward. Stated plainly: XGBoost wasn't picked for the reason we originally hoped to pick it by — it was picked by a fallback criterion the project had already agreed to use if the primary check didn't resolve things.
**Source:** `results/interpretability/interpretability_summary.md`.

### Phase 9: Stress-testing under real-world conditions
The recordings used to build this model were captured in relatively controlled conditions. In real deployment, a caregiver will record on an ordinary phone microphone in a normal, possibly noisy home. So we simulated that: synthetically degrading held-out recordings (limiting the frequency range to what a phone mic captures, and adding background noise at two severities) and re-testing XGBoost on the degraded versions. **Result: performance drops in a real, statistically confirmed way** under these conditions — even the frequency-range limitation alone, with zero added noise, causes a meaningful drop.
**Chart:** `figures/04_domain_shift_degradation.png`.
**Source:** `results/domain_shift_robustness/domain_shift_robustness_summary.md`.

---

## Things worth highlighting

**1. This project has caught and fixed several real problems during development, not just reported final numbers.** A data-labeling bug affecting 16 people's records (Phase 2), a subtle statistical leak in how one model's confidence scores were being computed (identified Phase 5, fixed Phase 7), a library-usage bug that could have silently corrupted a comparison used in Phase 8, and a noise-generation calibration issue caught mid-analysis in Phase 9 — each was found, verified, and fixed rather than glossed over. (Full list with sources in the Verification Appendix.)

**2. Three different, competing modeling approaches ended up genuinely, statistically tied — twice.** Both after tuning (Phase 6) and after confidence-score fixing (Phase 7), no statistical test could tell XGBoost, Random Forest, and SVM apart. Rather than picking one arbitrarily, the project ran a further, pre-planned tie-breaking check (Phase 8) and was honest when even *that* came back inconclusive, falling back to the next agreed-upon criterion instead. This is presented as a strength of the process, not a failure to find a "real" winner — a close result reported honestly is more trustworthy than a manufactured-looking decisive one.

**3. The model's real-world robustness has now actually been measured, not assumed.** Phase 9 found a real, statistically significant performance drop under simulated phone-microphone-plus-background-noise conditions. This is exactly the kind of gap that would otherwise only be discovered after deployment — finding it now, on a held-out test, is the system working as intended.

**4. Even a caught mid-analysis complication was handled by fixing and re-verifying it, not by softening the finding.** During Phase 9, a noise-generation calibration issue was found (a specific noise type wasn't quite as intense as intended), and rather than quietly adjusting the write-up, the underlying issue was fixed with a mathematically exact correction, re-verified independently against the raw generated audio, and the original result was left standing exactly as measured (since it was, if anything, an *understatement* of the real effect).

---

## Open questions needing supervisor input

- **How cautious should the model be?** Every prediction system has a dial between "catch every possible early warning sign, at the cost of more false alarms" and "raise fewer alarms, at the cost of possibly missing something real." This project has deliberately **not** set that dial yet — it's flagged in the spec as a decision that belongs to the clinical/product side of the project, not something an engineering phase should decide unilaterally. It needs to be set before Phase 10 (final evaluation) locks in a real operating threshold. *(Source: `docs/ml-development-spec.md`, section 8b/9c.)*

---

## What's next (Phases 10–12)

- **Phase 10:** Run the finished, locked model exactly once against the 43 people held out since Phase 2 — the true, final performance number — plus one final check of how it holds up under the same kind of noise/audio-quality stress-test as Phase 9.
- **Phase 11:** Package the finished model into a reproducible, versioned artifact that can be reliably reloaded and re-deployed later.
- **Phase 12:** Wrap that packaged model into the actual cloud service (AWS Lambda) that the rest of the app will call during a real visit.

---

## Verification Appendix

Every number above traces to one of these files. Regenerate any of them with the listed command; none of this was reconstructed from memory.

| # | Claim | Source file | Regenerate with |
|---|---|---|---|
| 1 | 215 subjects, 455 files, 84 dementia / 131 no_dementia subjects | `results/audit/audit_summary.md`, `results/audit/file_manifest.csv` | `python scripts/run_audit.py` |
| 2 | Channel-quality vs. label check does not survive strict correction | `results/audit/audit_summary.md` | `python scripts/run_audit.py` |
| 3 | train_pool 172 subjects / test 43 subjects | `results/splits/subject_splits.csv` | `python scripts/run_splits.py` |
| 4 | 88 eGeMAPS features extracted, 0 failures | `results/features/feature_extraction_summary.md` | `python scripts/run_features.py` |
| 5 | Shimmer vs. noise floor: r=-0.195, survives strict correction; 8 other pairs do not | `results/features/channel_quality_cross_check.csv` | `python scripts/run_features.py` |
| 6 | 20 features selected; CV AUC 0.7157 at k=20 vs. 0.5622 at k=88 | `results/feature_selection/selected_features.csv`, `results/feature_selection/k_selection_cv_scores.csv` | `python scripts/run_feature_selection.py` |
| 7 | The selected jitter feature is a different measurement than the one tested for noise-contamination | `results/feature_selection/selected_features.csv` (row 15) vs. `results/features/channel_quality_cross_check.csv` | — (cross-reference) |
| 8 | Baseline ROC-AUC: RF 0.6436, SVM 0.6421, LR 0.6275, XGBoost 0.6125 | `results/baseline_models/aggregated_metrics.csv` | `python scripts/run_baseline_models.py` |
| 9 | Logistic Regression eliminated after Stage 1; XGBoost/RF/SVM tuned ROC-AUC 0.6419/0.6400/0.6193 | `results/hyperparameter_tuning/stage1_aggregated.csv`, `results/hyperparameter_tuning/stage2_aggregated.csv` | `python scripts/run_hyperparameter_tuning.py` |
| 10 | XGBoost's tuning gain: t=2.352, p=0.0783 (not significant) | `results/hyperparameter_tuning/paired_comparison_summary.csv` | `python scripts/run_hyperparameter_tuning.py` |
| 11 | Calibrated ROC-AUC: SVM 0.6569, RF 0.6526, XGBoost 0.6427; no significant Brier winner (all p=1.0) | `results/calibration/aggregated_metrics.csv`, `results/calibration/pairwise_brier_comparison.csv` | `python scripts/run_calibration.py` |
| 12 | Calibration error (ECE): XGBoost 0.0251, SVM 0.0390, Random Forest 0.0470 | `results/calibration/calibration_ece.csv` | `python scripts/run_calibration.py` |
| 13 | Confound-reliance tie-break inconclusive (all pairwise p≥0.24); XGBoost selected via lowest ECE | `results/interpretability/pairwise_confound_reliance_comparison.csv`, `results/interpretability/interpretability_summary.md` | `python scripts/run_interpretability.py` |
| 14 | Bandpass-only drop: ROC-AUC 0.6427→0.6199; pre-registered pink+10dB test: p=0.0317 (significant) | `results/domain_shift_robustness/degradation_curve.csv`, `results/domain_shift_robustness/worst_case_significance_test.csv` | `python scripts/run_domain_shift_robustness.py` |
| 15 | Corrected pink@10dB (exploratory, not confirmatory): ROC-AUC 0.5400 vs. white@10dB 0.5464 (gap smaller than either's own noise) | `results/domain_shift_robustness/exploratory_corrected_pink_summary.csv` | `python scripts/run_domain_shift_robustness_exploratory.py` |
| 16 | Bugs found & fixed: file_id collision (16 subjects), SVC leakage, sklearn adapter mixin-order bug, pink-noise SNR drift | `docs/acoustic-model-dev-log.md` (Phase 2, Phase 7, Phase 8, Phase 9 entries) — narrative record, not a `results/` CSV; flagged as such | — (no CSV; see dev-log directly) |
| 17 | Sensitivity-vs-precision threshold decision is explicitly unresolved | `docs/ml-development-spec.md`, section 8b/9c | — (a decision record, not a data file) |

**Note on item 16 and 17:** these two are the only entries not backed by a `results/` CSV or generated summary — they're process/decision facts recorded in the project's narrative dev-log and spec rather than computed outputs. Everything else traces to a file a script produces from data, not from a description of what a phase "found."
