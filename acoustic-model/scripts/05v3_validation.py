"""v3 Stage 5: threshold, C4, C5, single-speaker and trajectory (PLAN.md v3.4-v3.5). Training portion only.

1. D5 threshold from the v3 main out-of-fold predictions (the v2 rule), with CV sensitivity and
   specificity at it. Reported, not frozen: there is no test set left to freeze it for.
2. C4: person-level correlation of the out-of-fold scores with the channel proxies and duration.
3. C5: per fold, the v3 model is refit exactly as in CV (same seed), checked against the stored
   out-of-fold predictions, then scored on the degraded embeddings of its validation clips.
4. Single-speaker CV clips (D1) and the trajectory clips' scores, descriptive.
"""

import sys

import numpy as np
import pandas as pd
from scipy import stats

from mzazi_acoustic.common import config, guards
from mzazi_acoustic.embeddings import xlsr
from mzazi_acoustic.model_evaluation import threshold, validation
from mzazi_acoustic.model_training import compare, cv, metrics

OUT = config.V3_EVALUATION_RESULTS
TRAINING = config.V3_TRAINING_RESULTS


def c4_correlations(oof):
    """Each person's mean out-of-fold probability against their mean proxy and trimmed duration."""
    proxies = pd.read_csv(config.COLLECTION_RESULTS / "file_manifest.csv")[["file_id", *config.CHANNEL_PROXIES]]
    duration = pd.read_csv(config.PROCESSING_RESULTS / "processing_report.csv")[["file_id", "trimmed_s"]]
    clips = oof.groupby(["file_id", "subject_id"], as_index=False)["probability"].mean()
    people = clips.merge(proxies, on="file_id").merge(duration, on="file_id").groupby("subject_id").mean(
        numeric_only=True)
    rows = []
    for column in [*config.CHANNEL_PROXIES, "trimmed_s"]:
        r, p = stats.pearsonr(people["probability"], people[column])
        rows.append({"variable": column, "n_people": len(people), "r": r, "p": p,
                     "reported": bool(abs(r) > config.V3_C4_ABS_R)})
    return pd.DataFrame(rows)


def main():
    model_file = config.MODELS_DIR / "acoustic_model.joblib"
    if not model_file.exists() or not (TRAINING / "oof_predictions.csv").exists():
        sys.exit("Run scripts/04v3_train.py first.")
    OUT.mkdir(parents=True, exist_ok=True)
    splits = pd.read_csv(guards.SPLITS_FILE)
    base = guards.load_rows(splits[["file_id", "subject_id", "label"]])
    training = xlsr.load_table(base, "clean")
    columns = xlsr.layer_columns()
    folds = pd.read_csv(config.PROCESSING_RESULTS / "cv_folds.csv")
    oof_all = pd.read_csv(TRAINING / "oof_predictions.csv")
    oof = oof_all[(oof_all.run == "v3_main") & (oof_all.variant == "tuned")]

    # 1. D5 threshold (reported only)
    frozen, per_repeat = threshold.frozen_threshold(oof)
    at_threshold = []
    for (repeat, fold), part in oof.groupby(["repeat", "fold"]):
        flagged = part["probability"] >= frozen
        w = 1 / part.groupby("subject_id")["file_id"].transform("size")
        pos, neg = part["label"] == 1, part["label"] == 0
        at_threshold.append({"repeat": repeat, "fold": fold,
                             "sensitivity_person": float((w[pos] * flagged[pos]).sum() / w[pos].sum()),
                             "specificity_person": float((w[neg] * ~flagged[neg]).sum() / w[neg].sum())})
    at_threshold = pd.DataFrame(at_threshold)
    at_threshold.to_csv(OUT / "cv_at_d5_threshold.csv", index=False)

    # 2. C4
    c4 = c4_correlations(oof)
    c4.to_csv(OUT / "c4_score_correlations.csv", index=False)

    # 3. C5 robustness, with the refit reproduction check
    degraded = {name: xlsr.load_table(base, name).set_index("file_id") for name, _, _ in config.V3_ROBUSTNESS_CONDITIONS}
    rows, reproduction = [], []
    for (repeat, fold), val_ids in folds.groupby(["repeat", "fold"])["file_id"]:
        in_val = training["file_id"].isin(set(val_ids))
        train, val = training[~in_val], training[in_val].reset_index(drop=True)
        seed = config.SEED + 100 * repeat + fold  # the seed cv.run_cv used for this fold
        model, _ = cv.fit_calibrated(config.V3_MODEL, "tuned", train[columns], train["label"], train["subject_id"], seed)
        p = model.predict_proba(val[columns].to_numpy(float))[:, 1]
        stored = oof[(oof.repeat == repeat) & (oof.fold == fold)].set_index("file_id")["probability"]
        reproduction.append(float(np.max(np.abs(p - stored.reindex(val["file_id"]).to_numpy()))))
        rows.append({"repeat": repeat, "fold": fold, "condition": "clean",
                     "roc_auc_person": validation.person_weighted_auc(val["label"], p, val["subject_id"])})
        for name, table in degraded.items():
            p_degraded = model.predict_proba(table.loc[val["file_id"], columns].to_numpy(float))[:, 1]
            rows.append({"repeat": repeat, "fold": fold, "condition": name,
                         "roc_auc_person": validation.person_weighted_auc(val["label"], p_degraded, val["subject_id"])})
        print(f"  repeat {repeat} fold {fold} (reproduction max diff {reproduction[-1]:.2e})")
    robustness = pd.DataFrame(rows)
    robustness.to_csv(OUT / "robustness_by_fold.csv", index=False)
    curve = robustness.groupby("condition")["roc_auc_person"].agg(["mean", "std"])
    wide = robustness.pivot_table(index=["repeat", "fold"], columns="condition", values="roc_auc_person")
    fm = pd.read_csv(TRAINING / "fold_metrics.csv")
    fm = fm[(fm.run == "v3_main") & (fm.variant == "tuned")]
    drop = wide["clean"] - wide[config.ROBUSTNESS_TEST_CONDITION]
    t, p_value = compare.corrected_repeated_t(drop, fm["n_train"].mean(), fm["n_val"].mean(),
                                              config.CV_FOLDS, config.CV_REPEATS)

    # 4. Single-speaker CV clips and trajectory scores (descriptive)
    audit = pd.read_csv(config.COLLECTION_RESULTS / "full_audit_by_clip.csv")[["file_id", "other_voices"]]
    speaker_rows = []
    for (repeat, fold), part in oof.merge(audit, on="file_id", how="left").groupby(["repeat", "fold"]):
        for subset, rows_in in [("all clips", part), ("single-speaker clips", part[part.other_voices == "no"])]:
            if rows_in["label"].nunique() == 2:
                m = metrics.evaluate(rows_in["label"], rows_in["probability"], rows_in["subject_id"])
                speaker_rows.append({"repeat": repeat, "fold": fold, "subset": subset,
                                     "roc_auc_person": m["roc_auc_person"]})
    speakers = pd.DataFrame(speaker_rows)
    speakers.to_csv(OUT / "cv_single_speaker.csv", index=False)
    trajectory_file = TRAINING / "trajectory_oof_predictions.csv"
    trajectory = pd.read_csv(trajectory_file) if trajectory_file.exists() else pd.DataFrame(columns=["probability"])
    controls = oof[oof.label == 0]["probability"]

    lines = ["# v3 Stage 5 - Checks on the training portion (exploratory: CV only)", "",
             "Generated by `scripts/05v3_validation.py`. No test-set figure exists for v3.", "",
             "## D5 threshold (90 % specificity rule, reported only)", "",
             f"- Per repeat: { {r: round(v, 4) for r, v in per_repeat.items()} }; median **{frozen:.4f}**.",
             f"- In CV at it (mean (SD) over 25 folds, person-weighted): sensitivity "
             f"{at_threshold.sensitivity_person.mean():.3f} ({at_threshold.sensitivity_person.std():.3f}), "
             f"specificity {at_threshold.specificity_person.mean():.3f} ({at_threshold.specificity_person.std():.3f}).", "",
             f"## C4: do the scores follow the recording? (person level, |r| > {config.V3_C4_ABS_R} reported)", "",
             "```", c4.round(4).to_string(index=False), "```", "",
             "## C5: robustness (person-weighted ROC-AUC, mean (SD) over 25 folds)", "",
             f"Refits reproduce the stored out-of-fold predictions to within {max(reproduction):.2e}.", "",
             "```", curve.round(4).to_string(), "```", "",
             f"Pre-registered test, clean vs {config.ROBUSTNESS_TEST_CONDITION}: mean drop {drop.mean():.4f}, "
             f"t = {t:.3f}, p = {p_value:.4f}.", "",
             "## Single-speaker CV clips (D1)", "", "```",
             speakers.groupby("subset")["roc_auc_person"].agg(["mean", "std", "count"]).round(4).to_string(), "```", "",
             "## Trajectory clips (dementia, 10-15 years before onset; scored by a model that never saw the person)", "",
             f"- Mean probability {trajectory['probability'].mean():.3f} over {len(trajectory)} predictions, "
             f"against {controls.mean():.3f} for control clips out of fold.", "",
             "## Not run", "", "- D4 (language shift on Kenyan corpora): no licensed unlabelled corpus in hand.", ""]
    (OUT / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
