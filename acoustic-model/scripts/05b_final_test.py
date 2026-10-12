"""Stage 5.2 - the one-time held-out test (PLAN.md 5.2). Runs once; a marker blocks a second run.

Everything is frozen first: features, the saved model (logistic regression, rank-preserving
calibration) and config.D5_THRESHOLD. Then:
1. main result: person-weighted (primary) and per-clip metrics, with 95 % subject-bootstrap CIs;
2. ROC, PR and calibration curve data;
3. pre-registered sensitivity analyses: over 70 (D6), near onset (D7), single-speaker (D1);
4. the most severe robustness condition (bandpass + pink @ 10 dB) on the test audio, reporting only;
5. the pre-symptomatic trajectory (D7), each clip scored by a model that never saw that person.

`--dry-run` exercises every step on training rows, writes to the scratch folder given, and never
marks the test set as used. It exists because a crash halfway through the real run would waste
the one use of the test set.
"""

import argparse
import zlib
from pathlib import Path

import numpy as np
import pandas as pd
import soundfile as sf
from scipy.stats import spearmanr
from sklearn.metrics import precision_recall_curve, roc_curve

from mzazi_acoustic.common import config, degradation, guards
from mzazi_acoustic.feature_engineering.features import extract_features
from mzazi_acoustic.model_evaluation import final_evaluation as fe
from mzazi_acoustic.model_training import final
from mzazi_acoustic.model_training.weights import person_weights

N_BOOT = 2000
YEARS_BEFORE_ONSET = {"0": 0, "5": -5, "10": -10, "15": -15}


def evaluate(name, rows, p, threshold, rng):
    point = fe.all_metrics(rows["label"], p, rows["subject_id"], threshold)
    ci, used = fe.bootstrap_ci(rows["label"].to_numpy(), p, rows["subject_id"].to_numpy(), threshold, N_BOOT, rng)
    out = []
    for key, value in point.items():
        low, high = ci.get(key, (np.nan, np.nan))
        out.append({"analysis": name, "metric": key, "value": value, "ci_low": low, "ci_high": high,
                    "n_clips": len(rows), "n_people": rows["subject_id"].nunique(),
                    "n_dementia_people": rows.loc[rows.label == 1, "subject_id"].nunique(), "n_boot_used": used})
    return out


def curves(rows, p, out):
    w = person_weights(rows["subject_id"].to_numpy())
    fpr, tpr, thr = roc_curve(rows["label"], p, sample_weight=w)
    pd.DataFrame({"fpr": fpr, "tpr": tpr, "threshold": thr}).to_csv(out / "test_roc_curve.csv", index=False)
    prec, rec, thr = precision_recall_curve(rows["label"], p, sample_weight=w)
    pd.DataFrame({"precision": prec, "recall": rec, "threshold": np.append(thr, np.nan)}).to_csv(
        out / "test_pr_curve.csv", index=False)
    bins = np.minimum((p * config.CALIBRATION_BINS).astype(int), config.CALIBRATION_BINS - 1)
    frame = pd.DataFrame({"bin": bins, "p": p, "y": rows["label"].to_numpy(), "w": w})
    calib = frame.groupby("bin").apply(lambda g: pd.Series({
        "mean_predicted": np.average(g.p, weights=g.w), "observed_rate": np.average(g.y, weights=g.w),
        "n_clips": len(g)}), include_groups=False)
    calib.to_csv(out / "test_calibration_curve.csv")


def degraded_predictions(rows, model, features):
    """The pre-registered most severe condition, extracted from the test audio (reporting only)."""
    noise_type, snr = next((n, s) for name, n, s in degradation.conditions() if name == config.ROBUSTNESS_TEST_CONDITION)
    values = []
    for row in rows.itertuples():
        y, sr = sf.read(config.PROCESSED_DIR / f"{row.file_id}.wav", dtype="float32")
        rng = np.random.default_rng([config.SEED, zlib.crc32(row.file_id.encode())])
        audio, _ = degradation.degrade(y, sr, noise_type, snr, rng)
        values.append(extract_features(audio.astype(np.float32), sr))
    return model.predict_proba(pd.DataFrame(values)[features].to_numpy(float))[:, 1]


def trajectory(model, features, matrix, test_rows, test_p, rng):
    """Score per timing bucket, each clip from a model that never saw that person (PLAN.md 5.2 step 7)."""
    oof = pd.read_csv(config.TRAINING_RESULTS / "oof_predictions.csv")
    meta_model = final.load()[1]["model"]
    oof = oof[(oof.model == meta_model) & (oof.variant == "tuned")]
    traj_oof = pd.read_csv(config.TRAINING_RESULTS / "trajectory_oof_predictions.csv")
    traj_oof = traj_oof[traj_oof.model == meta_model]
    # training people: average over the 5 repeats of the fold model that held them out
    scored = [oof.groupby(["file_id", "subject_id", "label"], as_index=False)["probability"].mean().assign(source="cv"),
              traj_oof.groupby(["file_id", "subject_id", "label"], as_index=False)["probability"].mean().assign(source="cv")]
    scored.append(test_rows[["file_id", "subject_id", "label"]].assign(probability=test_p, source="final model"))
    only = matrix[(matrix.role == "trajectory") & (matrix.split == "trajectory_only_person")]
    if len(only):
        p_only = model.predict_proba(only[features].to_numpy(float))[:, 1]
        scored.append(only[["file_id", "subject_id", "label"]].assign(probability=p_only, source="final model"))
    scored = pd.concat(scored, ignore_index=True)
    buckets = pd.read_csv(config.COLLECTION_RESULTS / "age_at_recording.csv", dtype={"bucket": str})[["file_id", "bucket"]]
    scored = scored.merge(buckets, on="file_id")

    rows = []
    controls = scored[scored.label == 0]
    rows.append({"group": "controls (reference)", "n_clips": len(controls), "n_people": controls.subject_id.nunique(),
                 "median_score": controls.probability.median(), "ci_low": np.nan, "ci_high": np.nan})
    dementia = scored[(scored.label == 1) & scored.bucket.isin(YEARS_BEFORE_ONSET)].copy()
    for bucket in ["15", "10", "5", "0"]:
        part = dementia[dementia.bucket == bucket]
        people = part.subject_id.unique()
        meds = [part[part.subject_id.isin(rng.choice(people, len(people)))].probability.median()
                for _ in range(N_BOOT)] if len(people) else [np.nan]
        rows.append({"group": f"dementia, bucket {bucket}", "n_clips": len(part), "n_people": len(people),
                     "median_score": part.probability.median(),
                     "ci_low": np.nanpercentile(meds, 2.5), "ci_high": np.nanpercentile(meds, 97.5)})
    table = pd.DataFrame(rows)

    dementia["years"] = dementia.bucket.map(YEARS_BEFORE_ONSET)
    rho = spearmanr(dementia.years, dementia.probability).statistic
    people = dementia.subject_id.unique()
    boot = []
    for _ in range(N_BOOT):
        sample = pd.concat([dementia[dementia.subject_id == s] for s in rng.choice(people, len(people))])
        if sample.years.nunique() > 1:
            boot.append(spearmanr(sample.years, sample.probability).statistic)
    multi = dementia.groupby("subject_id").filter(lambda g: g.years.nunique() > 1)
    nearer_higher = [g.sort_values("years").probability.iloc[-1] > g.sort_values("years").probability.iloc[0]
                     for _, g in multi.groupby("subject_id")]
    return table, scored, {"spearman_rho": rho, "rho_ci": (np.nanpercentile(boot, 2.5), np.nanpercentile(boot, 97.5)),
                           "within_person_n": len(nearer_higher),
                           "within_person_share_nearer_higher": float(np.mean(nearer_higher)) if nearer_higher else np.nan}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", type=Path, help="exercise every step on training rows, writing here")
    args = parser.parse_args()
    out = args.dry_run or config.EVALUATION_RESULTS
    out.mkdir(parents=True, exist_ok=True)

    threshold = config.D5_THRESHOLD
    assert threshold is not None, "freeze config.D5_THRESHOLD before the test"
    model, meta = final.load()
    features = meta["features"]
    matrix = pd.read_csv(config.FEATURE_RESULTS / "feature_matrix.csv")
    if args.dry_run:
        rows = guards.load_rows(matrix).sample(51, random_state=0).reset_index(drop=True)
    else:
        rows = fe.load_test_rows(matrix)
    rng = np.random.default_rng(config.SEED)
    p = model.predict_proba(rows[features].to_numpy(float))[:, 1]
    rows.assign(probability=p, flagged=p >= threshold)[["file_id", "subject_id", "label", "probability", "flagged"]].to_csv(
        out / "test_predictions.csv", index=False)

    results = evaluate("main", rows, p, threshold, rng)
    curves(rows, p, out)
    report = pd.read_csv(config.PROCESSING_RESULTS / "processing_report.csv")[["file_id", "sensitivity_over_70",
                                                                               "sensitivity_near_onset"]]
    audit = pd.read_csv(config.COLLECTION_RESULTS / "full_audit_by_clip.csv")[["file_id", "other_voices"]]
    flags = rows[["file_id"]].merge(report, on="file_id", how="left").merge(audit, on="file_id", how="left")
    for name, mask in [("sensitivity: over 70 (D6)", flags.sensitivity_over_70.fillna(False).astype(bool)),
                       ("sensitivity: dementia onset to 5 y (D7)", flags.sensitivity_near_onset.fillna(False).astype(bool)),
                       ("sensitivity: single-speaker (D1)", flags.other_voices.eq("no"))]:
        subset = rows[mask.to_numpy()]
        if subset.label.nunique() == 2:
            results += evaluate(name, subset.reset_index(drop=True), p[mask.to_numpy()], threshold, rng)
    p_degraded = degraded_predictions(rows, model, features)
    results += evaluate(f"robustness: {config.ROBUSTNESS_TEST_CONDITION} (reporting only)", rows, p_degraded, threshold, rng)
    table = pd.DataFrame(results)
    table.to_csv(out / "test_metrics.csv", index=False)

    traj_table, traj_scored, traj = trajectory(model, features, matrix, rows, p, rng)
    traj_table.to_csv(out / "trajectory.csv", index=False)
    traj_scored.to_csv(out / "trajectory_scores.csv", index=False)

    flagged = p >= threshold
    confusion = pd.crosstab(rows.label.map(config.LABEL_NAMES).rename("true class"),
                            pd.Series(np.where(flagged, "flagged", "not flagged"), name="model"))
    confusion.to_csv(out / "test_confusion_matrix.csv")

    def line(analysis, metric):
        r = table[(table.analysis == analysis) & (table.metric == metric)].iloc[0]
        return f"{r.value:.3f} [{r.ci_low:.3f}, {r.ci_high:.3f}]"

    main_rows = table[table.analysis == "main"].iloc[0]
    lines = ["# Stage 5.2 - One-time held-out test" + (" (DRY RUN on training rows)" if args.dry_run else ""), "",
             f"Generated by `scripts/05b_final_test.py`. Model: {meta['model']} ({len(features)} features), "
             f"threshold {threshold:.4f} (D5, frozen before the test). {main_rows.n_people} people "
             f"({main_rows.n_dementia_people} dementia), {main_rows.n_clips} clips. 95 % CIs: {N_BOOT} subject bootstraps.", "",
             "## Main result (person-weighted)", "",
             f"- ROC-AUC {line('main', 'roc_auc_person')}; PR-AUC {line('main', 'pr_auc_person')}; Brier {line('main', 'brier_person')}",
             f"- At the frozen threshold: sensitivity {line('main', 'sensitivity_person')}, specificity "
             f"{line('main', 'specificity_person')}, precision {line('main', 'precision_person')}, F1 {line('main', 'f1_person')}, "
             f"accuracy {line('main', 'accuracy_person')}",
             "- Per-clip (unweighted) values are in `test_metrics.csv`.", "",
             "Confusion matrix (clips):", "", "```", confusion.to_string(), "```", "",
             "## Pre-registered sensitivity analyses and robustness (person-weighted ROC-AUC)", ""]
    for name in table.analysis.unique():
        if name != "main":
            r = table[(table.analysis == name) & (table.metric == "roc_auc_person")].iloc[0]
            lines.append(f"- {name}: {line(name, 'roc_auc_person')} ({r.n_people} people, {r.n_dementia_people} dementia)")
    lines += ["", "## Pre-symptomatic trajectory (descriptive only)", "", "```", traj_table.round(4).to_string(index=False), "```", "",
              f"- Spearman rho, years before onset vs score: {traj['spearman_rho']:.3f} "
              f"[{traj['rho_ci'][0]:.3f}, {traj['rho_ci'][1]:.3f}].",
              f"- Within-person (people with clips in 2+ buckets, n = {traj['within_person_n']}): share whose clip nearest "
              f"onset scores higher than their earliest: {traj['within_person_share_nearer_higher']:.2f}.",
              "- Caveat: earlier buckets are also older recordings and younger ages; a trend can't be attributed to cognition alone.", ""]
    (out / "test_summary.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    if not args.dry_run:
        fe.mark_used({"n_clips": len(rows), "threshold": threshold, "model": meta["model"]})


if __name__ == "__main__":
    main()
