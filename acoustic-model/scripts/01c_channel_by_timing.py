"""Stage 1, decision D7 follow-up: do channel-quality proxies differ across the dementia timing buckets?

The concern: earlier buckets (5-15 years before onset) are also older recordings, so they may differ
in equipment/era, not just in cognition. This checks that concern instead of assuming it.
Descriptive only: nothing is added to or removed from the dataset based on it.

Writes (committed, anonymised): results/01_data_collection/channel_by_timing.csv and .md.
"""

import pandas as pd
from scipy import stats as sps

from mzazi_acoustic.common import config, stats
from mzazi_acoustic.data_processing import eligibility

OUT = config.COLLECTION_RESULTS
PROXIES = ["noise_floor_dbfs", "bandwidth_hz", "noise_flatness"]
BUCKETS = ["0", "5", "10", "15"]  # after onset, 0-5, 5-10, 10-15 years before onset
YEARS_BEFORE_ONSET = {"0": 0, "5": -5, "10": -10, "15": -15}  # ordered time for Spearman


def load_dementia_clips():
    manifest = pd.read_csv(config.COLLECTION_RESULTS / "file_manifest.csv")
    ages = pd.read_csv(config.COLLECTION_RESULTS / "age_at_recording.csv", dtype={"bucket": str})
    durations = pd.read_csv(config.PROCESSING_RESULTS / "processing_report.csv", dtype={"bucket": str})
    clips = manifest[["file_id", *PROXIES]].merge(ages, on="file_id")
    clips = clips.merge(durations[["file_id", "meets_minimum"]], on="file_id")
    clips = clips[clips["label"] == 1]
    dropped = clips[~clips["bucket"].isin(BUCKETS)]
    return clips[clips["bucket"].isin(BUCKETS)].copy(), dropped


def bucket_rows(clips, subset):
    rows = []
    for proxy in PROXIES:
        for bucket in BUCKETS:
            values = clips.loc[clips["bucket"] == bucket, proxy]
            rows.append({"subset": subset, "analysis": "per_bucket", "proxy": proxy, "bucket": bucket,
                         "n_clips": len(values), "n_people": clips.loc[values.index, "subject_id"].nunique(),
                         "median": values.median(), "q1": values.quantile(0.25), "q3": values.quantile(0.75)})
    return rows


def trend_rows(clips, subset):
    """Clip-level Kruskal-Wallis and Spearman. Caveat: one person's clips aren't independent."""
    rows = []
    for proxy in PROXIES:
        groups = [clips.loc[clips["bucket"] == b, proxy] for b in BUCKETS]
        _, p_kw = sps.kruskal(*groups)
        rho, p_rho = sps.spearmanr(clips["bucket"].map(YEARS_BEFORE_ONSET), clips[proxy])
        rows.append({"subset": subset, "analysis": "trend", "proxy": proxy, "n_clips": len(clips),
                     "n_people": clips["subject_id"].nunique(), "kruskal_p": p_kw, "spearman_rho": rho,
                     "spearman_p": p_rho})
    # Bonferroni across the 3 proxies, separately for each test.
    table = pd.DataFrame(rows)
    table["kruskal_p_bonferroni"] = stats.bonferroni(table["kruskal_p"])
    table["spearman_p_bonferroni"] = stats.bonferroni(table["spearman_p"])
    return table


def within_person_rows(clips, subset):
    """People with an early (10/15) and a late (0/5) clip: mean early minus mean late, Wilcoxon."""
    clips = clips.assign(period=clips["bucket"].map({"0": "late", "5": "late", "10": "early", "15": "early"}))
    means = clips.groupby(["subject_id", "period"])[PROXIES].mean().unstack("period")
    rows = []
    for proxy in PROXIES:
        paired = means[proxy].dropna(subset=["early", "late"])
        diff = paired["early"] - paired["late"]
        p = sps.wilcoxon(diff).pvalue if len(diff) >= 2 else float("nan")
        rows.append({"subset": subset, "analysis": "within_person", "proxy": proxy, "n_people": len(diff),
                     "median_early_minus_late": diff.median(), "wilcoxon_p": p})
    table = pd.DataFrame(rows)
    table["wilcoxon_p_bonferroni"] = stats.bonferroni(table["wilcoxon_p"])
    return table


def fmt(value, digits=4):
    return "" if pd.isna(value) else f"{value:.{digits}g}"


def markdown(table, subset_name, subset):
    part = table[table["subset"] == subset]
    lines = [f"## {subset_name}", "", "Per bucket (median [Q1, Q3]; bucket = years before onset, 0 = after onset):", "",
             "| proxy | " + " | ".join(f"bucket {b}" for b in BUCKETS) + " |", "|---|" + "---|" * len(BUCKETS)]
    per = part[part["analysis"] == "per_bucket"]
    for proxy in PROXIES:
        cells = []
        for b in BUCKETS:
            r = per[(per["proxy"] == proxy) & (per["bucket"] == b)].iloc[0]
            cells.append(f"{fmt(r['median'])} [{fmt(r['q1'])}, {fmt(r['q3'])}] (n={int(r['n_clips'])} clips/{int(r['n_people'])} people)")
        lines.append(f"| {proxy} | " + " | ".join(cells) + " |")
    trend = part[part["analysis"] == "trend"]
    lines += ["", "Trend across buckets (clip level; Bonferroni across the 3 proxies):", "",
              "| proxy | Kruskal-Wallis p (Bonf.) | Spearman rho vs time | Spearman p (Bonf.) |", "|---|---|---|---|"]
    for r in trend.itertuples():
        lines.append(f"| {r.proxy} | {fmt(r.kruskal_p_bonferroni)} | {fmt(r.spearman_rho, 3)} | {fmt(r.spearman_p_bonferroni)} |")
    within = part[part["analysis"] == "within_person"]
    if len(within):
        lines += ["", "Within person (people with an early 10/15 clip and a late 0/5 clip; mean early minus mean late):", "",
                  "| proxy | people | median difference | Wilcoxon p (Bonf.) |", "|---|---|---|---|"]
        for r in within.itertuples():
            lines.append(f"| {r.proxy} | {r.n_people} | {fmt(r.median_early_minus_late)} | {fmt(r.wilcoxon_p_bonferroni)} |")
    return lines + [""]


def main():
    clips, dropped = load_dementia_clips()
    primary = clips[eligibility.primary_dataset(clips) & clips["meets_minimum"]]

    table = pd.concat([
        pd.DataFrame(bucket_rows(clips, "all_dementia")), trend_rows(clips, "all_dementia"),
        within_person_rows(clips, "all_dementia"),
        pd.DataFrame(bucket_rows(primary, "primary_dataset")), trend_rows(primary, "primary_dataset"),
    ], ignore_index=True)
    table.to_csv(OUT / "channel_by_timing.csv", index=False)

    lines = ["# Stage 1 - Channel-quality proxies by dementia timing bucket (D7 check)", "",
             "Generated by `scripts/01c_channel_by_timing.py`. Descriptive only: tests whether earlier clips "
             "(5-15 years before onset) differ in recording conditions, i.e. an era/equipment confound, "
             "instead of assuming it. Nothing is added or removed based on it.", "",
             f"Dementia clips only. {len(dropped)} clip(s) with the unexplained suffix bucket "
             f"{sorted(dropped['bucket'].astype(str).unique())} dropped. Proxies are from Stage 1 "
             "(`file_manifest.csv`), measured at native sample rate.", "",
             "Caveat: clip-level tests treat clips as independent, but one person's clips are not, so their "
             "p-values are optimistic. The within-person paired check avoids that for people with both early "
             "and late clips.", "",
             *markdown(table, "All dementia clips", "all_dementia"),
             *markdown(table, "D6 primary dataset (wholly 55+) meeting the 30 s minimum", "primary_dataset")]
    (OUT / "channel_by_timing.md").write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
