#!/usr/bin/env python
"""Generates the charts for the weekly assessment summary
(results/weekly_assessment/weekly_assessment_summary.md).

Every chart reads an already-computed results/ CSV - nothing here recomputes
anything from raw audio. Designed to be extended, not rewritten: each chart is
its own function reading a fixed, cited set of input files; adding a chart for
a newly-completed phase means adding one more function and one more call in
main(), not touching the others.

Uses the project's validated default categorical palette (see the dataviz
skill's references/palette.md) rather than matplotlib's defaults, so colors
stay consistent across weeks: XGBoost/Random Forest/SVM/Logistic Regression
always get the same fixed hue, regardless of which subset appears in a given
chart.

Run via: python scripts/generate_weekly_assessment_charts.py
Requires matplotlib (requirements-dev.txt only - not part of the deployed
inference pipeline).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd

matplotlib.use("Agg")

from acoustic_model.config import (
    AUDIT_RESULTS_DIR,
    BASELINE_MODELS_RESULTS_DIR,
    CALIBRATION_RESULTS_DIR,
    FEATURES_RESULTS_DIR,
    RESULTS_DIR,
    ROBUSTNESS_RESULTS_DIR as DOMAIN_SHIFT_RESULTS_DIR,
    TUNING_RESULTS_DIR,
)

FIGURES_DIR = RESULTS_DIR / "weekly_assessment" / "figures"

# Validated default categorical palette (light mode), fixed order - never
# reassigned per-chart, so a model's color is the same in every chart it
# appears in. See the dataviz skill's references/palette.md.
COLOR_XGBOOST = "#2a78d6"  # slot 1, blue
COLOR_RANDOM_FOREST = "#eb6834"  # slot 2, orange
COLOR_SVM = "#1baf7a"  # slot 3, aqua
COLOR_LOGISTIC_REGRESSION = "#eda100"  # slot 4, yellow
COLOR_CRITICAL = "#d03b3b"  # status: critical (the one significant confound pair)
COLOR_MUTED = "#c3c2b7"  # non-significant / de-emphasized bars
PRIMARY_INK = "#0b0b0b"
SECONDARY_INK = "#52514e"
MUTED_INK = "#898781"
GRIDLINE = "#e1e0d9"
SURFACE = "#fcfcfb"

MODEL_COLORS = {
    "xgboost": COLOR_XGBOOST,
    "random_forest": COLOR_RANDOM_FOREST,
    "svm": COLOR_SVM,
    "logistic_regression": COLOR_LOGISTIC_REGRESSION,
}
MODEL_LABELS = {
    "xgboost": "XGBoost",
    "random_forest": "Random Forest",
    "svm": "SVM",
    "logistic_regression": "Logistic Regression",
}


def _style_axes(ax) -> None:
    ax.set_facecolor(SURFACE)
    ax.figure.set_facecolor(SURFACE)
    for spine in ("top", "right"):
        ax.spines[spine].set_visible(False)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color(COLOR_MUTED)
    ax.tick_params(colors=SECONDARY_INK, labelsize=9)
    ax.grid(axis="y", color=GRIDLINE, linewidth=0.8, zorder=0)
    ax.set_axisbelow(True)


def chart_dataset_makeup() -> Path:
    """Phase 1: subjects and files per class.
    Source: results/audit/file_manifest.csv (computed live, not hardcoded, so
    this chart stays correct if the audit is ever rerun)."""
    manifest = pd.read_csv(AUDIT_RESULTS_DIR / "file_manifest.csv")
    classes = ["dementia", "no_dementia"]
    subjects = [manifest[manifest["class_label"] == c]["subject_id"].nunique() for c in classes]
    files = [int((manifest["class_label"] == c).sum()) for c in classes]

    fig, ax = plt.subplots(figsize=(6, 4))
    x = range(len(classes))
    width = 0.35
    ax.bar([i - width / 2 for i in x], subjects, width, label="Subjects", color=COLOR_XGBOOST, zorder=3)
    ax.bar([i + width / 2 for i in x], files, width, label="Files", color=COLOR_RANDOM_FOREST, zorder=3)
    for i, (s, f) in enumerate(zip(subjects, files)):
        ax.text(i - width / 2, s + 4, str(s), ha="center", fontsize=9, color=PRIMARY_INK)
        ax.text(i + width / 2, f + 4, str(f), ha="center", fontsize=9, color=PRIMARY_INK)

    ax.set_xticks(list(x))
    ax.set_xticklabels(["Dementia", "No dementia"])
    ax.set_ylabel("Count", color=SECONDARY_INK)
    ax.set_title("Dataset makeup (Phase 1 audit)", color=PRIMARY_INK, fontsize=12, loc="left")
    ax.legend(frameon=False, loc="upper left")
    _style_axes(ax)
    fig.tight_layout()

    out = FIGURES_DIR / "01_dataset_makeup.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out


def chart_model_performance_pipeline() -> Path:
    """Phase 5 -> 6 -> 7: each candidate's ROC-AUC as it went from untuned to
    tuned to calibrated. Sources: results/baseline_models/aggregated_metrics.csv,
    results/hyperparameter_tuning/stage2_aggregated.csv,
    results/calibration/aggregated_metrics.csv."""
    baseline = pd.read_csv(BASELINE_MODELS_RESULTS_DIR / "aggregated_metrics.csv").set_index("model")
    tuned = pd.read_csv(TUNING_RESULTS_DIR / "stage2_aggregated.csv").set_index("model")
    calibrated = pd.read_csv(CALIBRATION_RESULTS_DIR / "aggregated_metrics.csv").set_index("model")

    stages = ["Untuned\n(Phase 5)", "Tuned\n(Phase 6)", "Calibrated\n(Phase 7)"]
    fig, ax = plt.subplots(figsize=(7, 4.5))

    survivors = ["xgboost", "random_forest", "svm"]
    for model in survivors:
        values = [baseline.loc[model, "roc_auc_mean"], tuned.loc[model, "mean_roc_auc"], calibrated.loc[model, "roc_auc_mean"]]
        ax.plot(stages, values, marker="o", markersize=7, linewidth=2, color=MODEL_COLORS[model], label=MODEL_LABELS[model], zorder=3)

    # Logistic Regression: only has a Phase 5 point (eliminated after Stage 1) -
    # a single marker, not a line, so it isn't implied to have a Phase 6/7 value.
    lr_value = baseline.loc["logistic_regression", "roc_auc_mean"]
    ax.scatter([stages[0]], [lr_value], marker="x", s=70, color=COLOR_LOGISTIC_REGRESSION, zorder=4,
               label="Logistic Regression\n(eliminated after Phase 6 Stage 1)")

    ax.set_ylabel("Mean cross-validated ROC-AUC\n(0.5 = chance, 1.0 = perfect)", color=SECONDARY_INK, fontsize=9)
    ax.set_title("Model performance across the pipeline", color=PRIMARY_INK, fontsize=12, loc="left")
    ax.set_ylim(0.55, 0.75)
    ax.legend(frameon=False, loc="upper left", fontsize=8)
    _style_axes(ax)
    fig.tight_layout()

    out = FIGURES_DIR / "02_model_performance_pipeline.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out


def chart_calibration_curves() -> Path:
    """Phase 7: reliability curves for the three surviving candidates.
    Source: results/calibration/calibration_curve.csv."""
    curve = pd.read_csv(CALIBRATION_RESULTS_DIR / "calibration_curve.csv")

    fig, ax = plt.subplots(figsize=(6, 6))
    ax.plot([0, 1], [0, 1], linestyle="--", color=MUTED_INK, linewidth=1.5, label="Perfectly calibrated", zorder=2)
    for model in ["xgboost", "random_forest", "svm"]:
        subset = curve[curve["model"] == model].sort_values("mean_predicted_probability")
        ax.plot(subset["mean_predicted_probability"], subset["fraction_of_positives"], marker="o",
                markersize=6, linewidth=2, color=MODEL_COLORS[model], label=MODEL_LABELS[model], zorder=3)

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)
    ax.set_xlabel("Predicted probability", color=SECONDARY_INK)
    ax.set_ylabel("Actual fraction that were dementia cases", color=SECONDARY_INK)
    ax.set_title("Calibration curves (Phase 7)", color=PRIMARY_INK, fontsize=12, loc="left")
    ax.legend(frameon=False, loc="upper left", fontsize=9)
    _style_axes(ax)
    fig.tight_layout()

    out = FIGURES_DIR / "03_calibration_curves.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out


def chart_domain_shift_degradation() -> Path:
    """Phase 9: XGBoost's ROC-AUC across the 6 degradation conditions, plus the
    exploratory corrected-pink point. Sources:
    results/domain_shift_robustness/degradation_curve.csv,
    results/domain_shift_robustness/exploratory_corrected_pink_summary.csv."""
    curve = pd.read_csv(DOMAIN_SHIFT_RESULTS_DIR / "degradation_curve.csv")
    order = ["clean", "bandpass_only", "bandpass_white_20db", "bandpass_white_10db", "bandpass_pink_20db", "bandpass_pink_10db"]
    labels = ["Clean", "Bandpass\nonly", "Bandpass +\nwhite @20dB", "Bandpass +\nwhite @10dB", "Bandpass +\npink @20dB", "Bandpass +\npink @10dB"]
    curve = curve.set_index("condition").loc[order].reset_index()

    fig, ax = plt.subplots(figsize=(8, 4.5))
    x = range(len(order))
    ax.errorbar(x, curve["roc_auc_mean"], yerr=curve["roc_auc_std"], marker="o", markersize=7,
                linewidth=2, color=COLOR_XGBOOST, ecolor=COLOR_XGBOOST, elinewidth=1, capsize=3, zorder=3)

    exploratory = pd.read_csv(DOMAIN_SHIFT_RESULTS_DIR / "exploratory_corrected_pink_summary.csv").iloc[0]
    ax.scatter([len(order) - 1 + 0.35], [exploratory["roc_auc_mean"]], marker="D", s=80, color=COLOR_CRITICAL, zorder=4,
               label="Pink @10dB, corrected to true severity\n(exploratory, not pre-registered)")

    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("Mean ROC-AUC across 5 folds", color=SECONDARY_INK)
    ax.set_title("Domain-shift degradation (Phase 9, XGBoost only)", color=PRIMARY_INK, fontsize=12, loc="left")
    ax.legend(frameon=False, loc="lower left", fontsize=8)
    _style_axes(ax)
    fig.tight_layout()

    out = FIGURES_DIR / "04_domain_shift_degradation.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out


_SHORT_FEATURE_NAMES = {
    "jitterLocal_sma3nz_amean": "Jitter",
    "shimmerLocaldB_sma3nz_amean": "Shimmer",
    "HNRdBACF_sma3nz_amean": "HNR",
}
_SHORT_PROXY_NAMES = {
    "noise_floor_db": "noise floor",
    "spectral_bandwidth_hz": "bandwidth",
    "spectral_flatness": "flatness",
}


def chart_confound_check() -> Path:
    """Phase 1/3: how strongly each voice-quality feature correlates with each
    channel-quality proxy - the one bar that survives strict statistical
    correction is highlighted. Source:
    results/features/channel_quality_cross_check.csv."""
    cross_check = pd.read_csv(FEATURES_RESULTS_DIR / "channel_quality_cross_check.csv")
    cross_check["pair_label"] = (
        cross_check["voice_quality_feature"].map(_SHORT_FEATURE_NAMES)
        + " vs. "
        + cross_check["channel_quality_proxy"].map(_SHORT_PROXY_NAMES)
    )
    cross_check = cross_check.sort_values("pearson_r")
    significant = cross_check["pearson_p_bonferroni_strict"] < 0.05
    colors = [COLOR_CRITICAL if sig else COLOR_MUTED for sig in significant]

    fig, ax = plt.subplots(figsize=(7, 5))
    y = range(len(cross_check))
    ax.barh(y, cross_check["pearson_r"], color=colors, zorder=3)
    ax.axvline(0, color=COLOR_MUTED, linewidth=1)
    ax.set_yticks(list(y))
    ax.set_yticklabels(cross_check["pair_label"], fontsize=9)
    ax.set_xlabel("Pearson correlation (r)", color=SECONDARY_INK)
    ax.set_title("Voice-quality feature vs. channel-quality proxy\n(Phases 1 & 3)", color=PRIMARY_INK, fontsize=12, loc="left")

    from matplotlib.patches import Patch
    legend_handles = [
        Patch(color=COLOR_CRITICAL, label="Survives strict correction\n(real, tracked confound)"),
        Patch(color=COLOR_MUTED, label="Not significant"),
    ]
    ax.legend(handles=legend_handles, frameon=False, loc="lower right", fontsize=8)
    _style_axes(ax)
    ax.grid(axis="x", color=GRIDLINE, linewidth=0.8, zorder=0)
    ax.grid(axis="y", visible=False)
    fig.tight_layout()

    out = FIGURES_DIR / "05_confound_check.png"
    fig.savefig(out, dpi=150)
    plt.close(fig)
    return out


def main() -> None:
    FIGURES_DIR.mkdir(parents=True, exist_ok=True)
    generated = [
        chart_dataset_makeup(),
        chart_model_performance_pipeline(),
        chart_calibration_curves(),
        chart_domain_shift_degradation(),
        chart_confound_check(),
    ]
    for path in generated:
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
