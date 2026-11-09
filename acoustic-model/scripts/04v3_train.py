"""v3 Stage 4: the embedding model and comparators C1-C3 on the v2 5 x 5 folds (PLAN.md v3.3-v3.4).

Every run uses the same folds, D2 weights, inner search budget and rank-preserving calibration, so
per-fold differences are matched. Only the v3.3 pipeline can become the model; C1-C3 are checks.
Loads training rows through the test-set guard.

Writes results/04v3_model_training/ and the final model to models/.
"""

import sys
from importlib import metadata as package_metadata

import numpy as np
import pandas as pd
from scipy import stats

from mzazi_acoustic.common import config, guards
from mzazi_acoustic.embeddings import xlsr
from mzazi_acoustic.model_training import compare, cv, final

OUT = config.V3_TRAINING_RESULTS
METRICS = ["roc_auc_person", "brier_person", "ece_person", "roc_auc_clip"]


def corrected_interval(values, n_train, n_test, k=config.CV_FOLDS, r=config.CV_REPEATS, level=0.95):
    """95 % interval for the mean over k x r folds with the Nadeau-Bengio variance correction, the
    same correction the comparisons use (fold training sets overlap, so the plain interval is too narrow)."""
    v = np.asarray(values, float)
    half = stats.t.ppf((1 + level) / 2, k * r - 1) * np.sqrt((1 / (k * r) + n_test / n_train) * v.var(ddof=1))
    return v.mean() - half, v.mean() + half


def runs(base, trajectory):
    """(run name, training table, feature columns, model name, trajectory table or None)."""
    columns = xlsr.layer_columns()
    c1 = pd.read_csv(config.EMBEDDING_RESULTS / "c1_features.csv")
    proxies = pd.read_csv(config.COLLECTION_RESULTS / "file_manifest.csv")[["file_id", *config.CHANNEL_PROXIES]]
    main = xlsr.load_table(base, "clean")
    if main[columns].isna().any().any():
        sys.exit("Some training clips have no clean embedding: rerun scripts/03v3_embeddings.py.")
    return [
        ("v3_main", main, columns, config.V3_MODEL, xlsr.load_table(trajectory, "clean")),
        ("C1_v2_features", base.merge(c1, on="file_id"), config.V3_C1_FEATURES, "logistic_regression", None),
        ("C2_channel_only", base.merge(proxies, on="file_id"), config.CHANNEL_PROXIES, "logistic_regression", None),
        ("C3_pause_only", xlsr.load_table(base, "pause_only"), columns, config.V3_MODEL, None),
    ]


def main():
    if not (config.EMBEDDING_RESULTS / "c1_features.csv").exists():
        sys.exit("Run scripts/03v3_embeddings.py first.")
    OUT.mkdir(parents=True, exist_ok=True)
    splits = pd.read_csv(guards.SPLITS_FILE)
    base = guards.load_rows(splits[["file_id", "subject_id", "label"]])  # training rows only
    trajectory = splits.loc[(splits["role"] == "trajectory") & (splits["split"] == "train"),
                            ["file_id", "subject_id", "label"]]
    folds = pd.read_csv(config.PROCESSING_RESULTS / "cv_folds.csv")

    fold_rows, oof_rows, log_rows, main_table = [], [], [], None
    for name, table, columns, model, traj in runs(base, trajectory):
        print(f"{name}: {len(table)} clips, {len(columns)} columns")
        missing = int(table[columns].isna().all(axis=1).sum())
        results = cv.run_cv(table, folds, columns, models=[model], trajectory=traj)
        fold_rows.append(results["fold_metrics"].assign(run=name, clips_without_input=missing))
        oof_rows.append(results["oof_predictions"].assign(run=name))
        log_rows.append(results["tuning_log"].assign(run=name))
        if name == "v3_main":
            main_table = table
            if results["trajectory_predictions"] is not None:
                results["trajectory_predictions"].to_csv(OUT / "trajectory_oof_predictions.csv", index=False)

    fold_metrics = pd.concat(fold_rows, ignore_index=True)
    fold_metrics.to_csv(OUT / "fold_metrics.csv", index=False)
    pd.concat(oof_rows, ignore_index=True).to_csv(OUT / "oof_predictions.csv", index=False)
    pd.concat(log_rows, ignore_index=True).to_csv(OUT / "tuning_log.csv", index=False)

    tuned = fold_metrics[fold_metrics["variant"] == "tuned"]
    wide = tuned.pivot_table(index=["repeat", "fold"], columns="run", values="roc_auc_person")
    n_train, n_test = tuned["n_train"].mean(), tuned["n_val"].mean()

    # Pre-registered readings (PLAN.md v3.4)
    comparisons = []
    for other in ["C1_v2_features", "C2_channel_only"]:
        diff = wide["v3_main"] - wide[other]
        t, p = compare.corrected_repeated_t(diff, n_train, n_test, config.CV_FOLDS, config.CV_REPEATS)
        p_bonferroni = min(1.0, p * config.V3_N_COMPARISONS)
        comparisons.append({"comparison": f"v3_main - {other}", "mean_difference": diff.mean(), "t": t, "p": p,
                            "p_bonferroni": p_bonferroni,
                            "v3_better": bool(diff.mean() > 0 and p_bonferroni < config.ALPHA)})
    comparisons = pd.DataFrame(comparisons)
    comparisons.to_csv(OUT / "comparisons.csv", index=False)
    main_auc, c3_auc = wide["v3_main"].mean(), wide["C3_pause_only"].mean()
    c3_flag = bool(c3_auc >= main_auc - config.V3_C3_MARGIN)
    low, high = corrected_interval(wide["v3_main"], n_train, n_test)

    # Final model: refit on the whole training portion (selection score only, never performance)
    columns = xlsr.layer_columns()
    model, final_log = final.fit_final(main_table, columns, config.V3_MODEL)
    pd.DataFrame(final_log).to_csv(OUT / "final_tuning_log.csv", index=False)
    steps = model.pipeline.named_steps
    meta = final.build_metadata(config.V3_MODEL, [], model)
    meta.pop("features")
    meta.update({
        "encoder": config.ENCODER_NAME, "encoder_revision": config.ENCODER_REVISION,
        "layer": int(steps["select"].layer), "pca_components": int(steps["pca"].n_components),
        "input": f"candidate layers {config.EMBEDDING_CANDIDATE_LAYERS} x 1024, flattened (xlsr.layer_columns)",
        "embedding": {"window_s": config.EMBEDDING_WINDOW_SECONDS,
                      "min_last_window_s": config.EMBEDDING_MIN_LAST_WINDOW_SECONDS,
                      "torch_threads": config.EMBEDDING_TORCH_THREADS},
    })
    meta["package_versions"].update({p: package_metadata.version(p) for p in ["torch", "transformers"]})
    final.save(model, meta)

    summary = tuned.groupby("run")[METRICS].agg(["mean", "std"]).round(4)
    lines = ["# v3 Stage 4 - Embedding model and comparators (exploratory: CV only)", "",
             "Generated by `scripts/04v3_train.py`. 5 repeats x 5 person-grouped folds (v2's folds), tuned and "
             "calibrated. The v2 test set stays locked, so **no figure here is a held-out result**.", "",
             "Mean (SD) across the 25 folds:", "", "```", summary.to_string(), "```", "",
             f"**v3 main, person-weighted ROC-AUC {main_auc:.3f}, 95 % CI {low:.3f}-{high:.3f}** "
             "(corrected for overlapping training folds).", "",
             "## Pre-registered readings (PLAN.md v3.4)", "",
             *[f"- {r.comparison}: mean difference {r.mean_difference:+.4f}, t = {r.t:.3f}, Bonferroni p = "
               f"{r.p_bonferroni:.4f} -> **{'v3 better' if r.v3_better else 'not shown better'}**"
               for r in comparisons.itertuples()],
             f"- C3 (pause audio only): AUC {c3_auc:.3f} vs main {main_auc:.3f}. "
             + ("**At least the main AUC minus 0.05: the signal most likely comes from the recording, not the "
                "speaker.**" if c3_flag else "Below the main AUC minus 0.05: the silence check does not explain "
                                               "the main result."),
             f"- C3 clips with under {config.PAUSE_ONLY_MIN_SECONDS} s of pause audio (median-imputed in the fold): "
             f"{int(fold_metrics.loc[fold_metrics.run == 'C3_pause_only', 'clips_without_input'].iloc[0])}.", "",
             f"Final model: layer {meta['layer']}, {meta['pca_components']} PCA components, saved to models/. "
             "Its refit search score is a selection score only.", ""]
    (OUT / "summary.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
