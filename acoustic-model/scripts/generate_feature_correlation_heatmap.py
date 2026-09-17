#!/usr/bin/env python
"""Visualizes Phase 3's feature correlation matrix (the multicollinearity check
behind ml-development-spec.md's Phase 3/4 discussion) as two heatmaps:

1. All 88 eGeMAPS features - shows the overall redundancy structure (block
   patterns of highly-correlated feature families) that motivated Phase 4's
   feature selection in the first place. Unlabeled per-cell (88 labels would be
   unreadable); the colorbar plus the already-computed "53 of 3828 pairs at
   |r|>=0.9" figure carries the quantitative claim.
2. Just the 20 Phase-4-selected features - fully labeled and readable, since
   this is the actual input the locked model uses.

Reads two already-computed files, recomputes nothing:
- results/features/feature_correlation_matrix.csv (the full 88x88 matrix)
- results/feature_selection/selected_features.csv (which 20 survived)

Uses the project's validated diverging color pair (blue <-> red, neutral gray
midpoint) rather than an arbitrary colormap, matching the palette already used
in scripts/generate_weekly_assessment_charts.py.

Run via: python scripts/generate_feature_correlation_heatmap.py
Requires matplotlib (requirements-dev.txt only).
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import matplotlib
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap

matplotlib.use("Agg")

from acoustic_model.config import FEATURE_SELECTION_RESULTS_DIR, FEATURES_RESULTS_DIR

# Validated diverging pair (dataviz skill references/palette.md): blue <-> red,
# neutral gray midpoint - not an arbitrary matplotlib colormap.
_DIVERGING_CMAP = LinearSegmentedColormap.from_list(
    "project_diverging", ["#2a78d6", "#f0efec", "#e34948"]
)
PRIMARY_INK = "#0b0b0b"
SECONDARY_INK = "#52514e"
MUTED_INK = "#898781"
SURFACE = "#fcfcfb"


def _shorten(name: str) -> str:
    return name.replace("_sma3nz", "").replace("_sma3", "").replace("Local", "")


def heatmap_all_features() -> Path:
    matrix = pd.read_csv(FEATURES_RESULTS_DIR / "feature_correlation_matrix.csv", index_col=0)
    high_pairs = pd.read_csv(FEATURES_RESULTS_DIR / "high_correlation_pairs.csv")
    n = len(matrix)
    n_possible_pairs = n * (n - 1) // 2

    fig, ax = plt.subplots(figsize=(8, 7))
    fig.patch.set_facecolor(SURFACE)
    im = ax.imshow(matrix.values, cmap=_DIVERGING_CMAP, vmin=-1, vmax=1)

    ax.set_xticks([])
    ax.set_yticks([])
    for spine in ax.spines.values():
        spine.set_visible(False)

    ax.set_title(
        "Feature correlation matrix - all 88 eGeMAPS features (Phase 3)",
        color=PRIMARY_INK, fontsize=12, loc="left", pad=12,
    )

    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label("Pearson correlation (r)", color=SECONDARY_INK, fontsize=9)
    cbar.ax.tick_params(colors=SECONDARY_INK, labelsize=8)
    cbar.outline.set_visible(False)

    fig.tight_layout(rect=(0, 0.06, 1, 1))
    fig.text(
        0.02, 0.015,
        f"{len(high_pairs)} of {n_possible_pairs} possible pairs exceed |r| >= 0.9 - substantial redundancy,\n"
        "why Phase 4 selects a 20-feature subset rather than using all 88.",
        color=SECONDARY_INK, fontsize=9, ha="left", va="bottom",
    )
    out = FEATURES_RESULTS_DIR / "feature_correlation_heatmap_all88.png"
    fig.savefig(out, dpi=150, facecolor=SURFACE)
    plt.close(fig)
    return out


def heatmap_selected_features() -> Path:
    matrix = pd.read_csv(FEATURES_RESULTS_DIR / "feature_correlation_matrix.csv", index_col=0)
    selected = pd.read_csv(FEATURE_SELECTION_RESULTS_DIR / "selected_features.csv")["feature"].tolist()
    subset = matrix.loc[selected, selected]
    labels = [_shorten(f) for f in selected]

    fig, ax = plt.subplots(figsize=(10, 9))
    fig.patch.set_facecolor(SURFACE)
    im = ax.imshow(subset.values, cmap=_DIVERGING_CMAP, vmin=-1, vmax=1)

    ax.set_xticks(range(len(labels)))
    ax.set_yticks(range(len(labels)))
    ax.set_xticklabels(labels, rotation=90, fontsize=7, color=SECONDARY_INK)
    ax.set_yticklabels(labels, fontsize=7, color=SECONDARY_INK)
    ax.tick_params(length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)

    # Direct value labels - only 20x20=400 cells, small enough to read, unlike the full 88x88.
    # 2 decimal places, not 1 - at 1dp, r=-0.98 and r=-1.00 both display as "-1.0", which
    # reads as a data bug (duplicate columns) rather than the genuine near-total redundancy
    # it actually is (both pairs are independently confirmed in high_correlation_pairs.csv).
    for i in range(len(labels)):
        for j in range(len(labels)):
            value = subset.values[i, j]
            text_color = "white" if abs(value) > 0.6 else PRIMARY_INK
            ax.text(j, i, f"{value:.2f}", ha="center", va="center", fontsize=5, color=text_color)

    ax.set_title(
        "Feature correlation matrix - the 20 selected features actually used by the model (Phase 4)",
        color=PRIMARY_INK, fontsize=12, loc="left", pad=12,
    )

    cbar = fig.colorbar(im, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label("Pearson correlation (r)", color=SECONDARY_INK, fontsize=9)
    cbar.ax.tick_params(colors=SECONDARY_INK, labelsize=8)
    cbar.outline.set_visible(False)

    fig.tight_layout()
    out = FEATURES_RESULTS_DIR / "feature_correlation_heatmap_selected20.png"
    fig.savefig(out, dpi=150, facecolor=SURFACE)
    plt.close(fig)
    return out


def main() -> None:
    for path in (heatmap_all_features(), heatmap_selected_features()):
        print(f"Wrote {path}")


if __name__ == "__main__":
    main()
