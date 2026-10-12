"""Stage 5.1 - before the test set (PLAN.md 5.1): training portion and saved folds only.

1. D5 threshold: the pre-registered 90 %-specificity threshold from the chosen model's out-of-fold
   predictions (median over repeats). Written to results; the developer copies it into config
   before the test set is used.
2. Single-speaker sensitivity (D1): CV metrics on validation clips with no other voice.
3. Per fold, the chosen model is refit exactly as in CV (same seed) and checked against the stored
   out-of-fold predictions, then used for permutation importance and the robustness curve, which
   reuses the degraded features 03b saved (same audio, same noise seeds).
D4 (the language-shift check on Kenyan corpora) was never decided, so it isn't run.
"""

import sys

import numpy as np
import pandas as pd

from mzazi_acoustic.common import config, degradation, guards
from mzazi_acoustic.model_evaluation import threshold, validation
from mzazi_acoustic.model_training import candidates, compare, cv, final, metrics

OUT = config.EVALUATION_RESULTS
TRAINING = config.TRAINING_RESULTS


def degraded_tables():
    tables = {}
    for name, _, _ in degradation.conditions():
        path = config.FEATURE_RESULTS / f"degraded_features_{name.replace('+', '_').replace('@', '_')}.csv"
        tables[name] = pd.read_csv(path).set_index("file_id")
    return tables


def single_speaker_cv(oof):
    audit = pd.read_csv(config.COLLECTION_RESULTS / "full_audit_by_clip.csv")[["file_id", "other_voices"]]
    oof = oof.merge(audit, on="file_id", how="left")
    rows = []
    for (repeat, fold), part in oof.groupby(["repeat", "fold"]):
        for subset, rows_in in [("all clips", part), ("single-speaker clips", part[part.other_voices == "no"])]:
            if rows_in["label"].nunique() == 2:
                m = metrics.evaluate(rows_in["label"], rows_in["probability"], rows_in["subject_id"])
                rows.append({"repeat": repeat, "fold": fold, "subset": subset, "n_clips": len(rows_in),
                             "roc_auc_person": m["roc_auc_person"], "brier_person": m["brier_person"],
                             "roc_auc_clip": m["roc_auc_clip"]})
    return pd.DataFrame(rows)


def main():
    model_file = config.MODELS_DIR / "acoustic_model.joblib"
    if not model_file.exists():
        sys.exit("Stage 4 hasn't saved a model yet: run scripts/04_train.py first.")
    OUT.mkdir(parents=True, exist_ok=True)
    _, meta = final.load()
    chosen, feature_cols = meta["model"], meta["features"]
    training = guards.load_rows(pd.read_csv(config.FEATURE_RESULTS / "feature_matrix.csv"))
    folds = pd.read_csv(config.PROCESSING_RESULTS / "cv_folds.csv")
    oof_all = pd.read_csv(TRAINING / "oof_predictions.csv")
    oof = oof_all[(oof_all.model == chosen) & (oof_all.variant == "tuned")]

    # 1. D5 threshold
    frozen, per_repeat = threshold.frozen_threshold(oof)
    pd.DataFrame([{"repeat": r, "threshold": t} for r, t in per_repeat.items()]
                 + [{"repeat": "median (frozen)", "threshold": frozen}]).to_csv(OUT / "d5_threshold.csv", index=False)
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

    # 2. Single-speaker sensitivity analysis (CV)
    speakers = single_speaker_cv(oof)
    speakers.to_csv(OUT / "cv_single_speaker.csv", index=False)

    # 3. Refit per fold: reproduction check, permutation importance, robustness curve
    degraded = degraded_tables()
    importance_rows, robustness_rows, reproduction, calibration_rows = [], [], [], []
    for (repeat, fold), val_ids in folds.groupby(["repeat", "fold"])["file_id"]:
        in_val = training["file_id"].isin(set(val_ids))
        train, val = training[~in_val], training[in_val].reset_index(drop=True)
        seed = config.SEED + 100 * repeat + fold  # the seed cv.run_cv used for this fold
        model, _ = cv.fit_calibrated(chosen, "tuned", train[feature_cols], train["label"], train["subject_id"], seed)
        p = model.predict_proba(val[feature_cols].to_numpy(float))[:, 1]
        stored = oof[(oof.repeat == repeat) & (oof.fold == fold)].set_index("file_id")["probability"]
        reproduction.append(float(np.max(np.abs(p - stored.reindex(val["file_id"]).to_numpy()))))
        # Raw scores vs calibrated probabilities: calibration must not change the ranking
        # (a slope of 0 means "no usable ranking": the base rate for everyone).
        raw = candidates.scores(model.pipeline, val[feature_cols].to_numpy(float))
        calibration_rows.append({"repeat": repeat, "fold": fold, "slope": model.slope,
                                 "raw_auc_person": validation.person_weighted_auc(val["label"], raw, val["subject_id"]),
                                 "calibrated_auc_person": validation.person_weighted_auc(val["label"], p,
                                                                                         val["subject_id"])})

        imp = validation.permutation_importance(model, val[feature_cols], val["label"], val["subject_id"],
                                                feature_cols, config.PERMUTATION_REPEATS,
                                                np.random.default_rng(seed))
        importance_rows.append(imp.assign(repeat=repeat, fold=fold))

        robustness_rows.append({"repeat": repeat, "fold": fold, "condition": "clean",
                                "roc_auc_person": validation.person_weighted_auc(val["label"], p, val["subject_id"])})
        for name, table in degraded.items():
            x_degraded = table.loc[val["file_id"], feature_cols].to_numpy(float)
            p_degraded = model.predict_proba(x_degraded)[:, 1]
            robustness_rows.append({"repeat": repeat, "fold": fold, "condition": name,
                                    "roc_auc_person": validation.person_weighted_auc(val["label"], p_degraded,
                                                                                     val["subject_id"])})
        print(f"  repeat {repeat} fold {fold} done (reproduction max diff {reproduction[-1]:.2e})")

    calibration = pd.DataFrame(calibration_rows)
    calibration.to_csv(OUT / "calibration_by_fold.csv", index=False)

    importance = pd.concat(importance_rows, ignore_index=True)
    importance.to_csv(OUT / "permutation_importance_by_fold.csv", index=False)
    summary_imp = (importance.groupby("feature")["importance_mean"].agg(["mean", "std"])
                   .sort_values("mean", ascending=False))
    summary_imp["family"] = np.where(summary_imp.index.isin(config.FAMILY_A_FEATURES), "A (pausing/timing)",
                                     "B (voice stability)")
    summary_imp.to_csv(OUT / "permutation_importance.csv")
    positive = summary_imp["mean"].clip(lower=0)
    share_a = positive[summary_imp["family"].str.startswith("A")].sum() / positive.sum() if positive.sum() > 0 else np.nan

    robustness = pd.DataFrame(robustness_rows)
    robustness.to_csv(OUT / "robustness_by_fold.csv", index=False)
    curve = robustness.groupby("condition")["roc_auc_person"].agg(["mean", "std"])
    curve.to_csv(OUT / "robustness_curve.csv")
    wide = robustness.pivot_table(index=["repeat", "fold"], columns="condition", values="roc_auc_person")
    fm = pd.read_csv(TRAINING / "fold_metrics.csv")
    fm = fm[(fm.model == chosen) & (fm.variant == "tuned")]
    t, p_value = compare.corrected_repeated_t(wide["clean"] - wide[config.ROBUSTNESS_TEST_CONDITION],
                                              fm["n_train"].mean(), fm["n_val"].mean(), config.CV_FOLDS, config.CV_REPEATS)

    flags = pd.read_csv(config.FEATURE_RESULTS / "degradation_flags.csv")
    duration = pd.read_csv(config.FEATURE_RESULTS / "duration_dependence.csv")
    flagged = sorted(set(flags.loc[flags.flagged, "feature"]) | set(duration.loc[duration.flagged, "feature"]))
    spk = speakers.groupby("subset")[["roc_auc_person", "brier_person", "n_clips"]].agg(["mean", "std"]).round(4)

    lines = ["# Stage 5.1 - Before the test set (training portion, 5 x 5 CV)", "",
             f"Generated by `scripts/05a_validation.py`. Chosen model: **{chosen}** ({len(feature_cols)} features).", "",
             "## D5 operating threshold (pre-registered)", "",
             f"- Per repeat (lowest threshold with person-weighted specificity >= {config.D5_TARGET_SPECIFICITY:.0%}): "
             f"{ {r: round(t, 4) for r, t in per_repeat.items()} }",
             f"- **Frozen threshold (median): {frozen:.4f}**. Copy into `config.D5_THRESHOLD` before the test set is used.",
             f"- In CV at this threshold (mean (SD) over 25 folds, person-weighted): sensitivity "
             f"{at_threshold.sensitivity_person.mean():.3f} ({at_threshold.sensitivity_person.std():.3f}), specificity "
             f"{at_threshold.specificity_person.mean():.3f} ({at_threshold.specificity_person.std():.3f}).", "",
             "## Calibration per fold (`calibration_by_fold.csv`)", "",
             f"- Raw-score AUC {calibration.raw_auc_person.mean():.3f} ({calibration.raw_auc_person.std():.3f}); "
             f"calibrated AUC {calibration.calibrated_auc_person.mean():.3f} ({calibration.calibrated_auc_person.std():.3f}).",
             f"- Folds where calibration found no usable ranking (slope 0, base rate for everyone): "
             f"{int((calibration.slope == 0).sum())} of {len(calibration)}.", "",
             "## Single-speaker sensitivity analysis (D1, CV)", "", "```", spk.to_string(), "```", "",
             "## Permutation importance (person-weighted ROC-AUC drop; mean and SD across 25 folds)", "",
             f"Refit check: the per-fold refits reproduce the stored out-of-fold predictions to within "
             f"{max(reproduction):.2e} (max absolute difference).", "",
             "```", summary_imp.round(4).to_string(), "```", "",
             f"- Share of positive importance on family A (pausing/timing): {share_a:.1%}.",
             f"- Features flagged in Stage 3.3 (degradation shift or duration dependence), read with their importance: "
             f"{flagged or 'none'}.",
             "- Importance shows association, not causation.", "",
             "## Recording-quality robustness (person-weighted ROC-AUC, mean (SD) over 25 folds)", "",
             "```", curve.round(4).to_string(), "```", "",
             f"Pre-registered test, clean vs {config.ROBUSTNESS_TEST_CONDITION} (corrected repeated k-fold t-test, "
             f"df = {config.CV_FOLDS * config.CV_REPEATS - 1}): mean drop "
             f"{(wide['clean'] - wide[config.ROBUSTNESS_TEST_CONDITION]).mean():.4f}, t = {t:.3f}, p = {p_value:.4f}.", "",
             "## Not run", "", "- D4 (language-shift check on Kenyan corpora): never decided.", ""]
    (OUT / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
