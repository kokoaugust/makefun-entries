#!/usr/bin/env python3
"""Forecaster for Roblox's Up-and-Coming chart (make.fun roblox-up-and-coming-forecast-01).

Reads /input/history.ndjson + /input/task.json, writes /output/forecast.json:
per place (1..places) a probability for each named game, plus the predicted top 10.

Method (stdlib only, deterministic):
- Per game, fit a recency-weighted log-`playing` level and slope from its recent
  observations; shrink the slope hard and let growth saturate with horizon.
- At several horizons across the 72h scored window, Monte-Carlo the chart:
  each game's projected log-playing is perturbed by horizon-growing noise,
  games are ranked, and place occupancy is counted.
- Average the place distributions over horizons; shrink the named mass a little
  so the unnamed remainder covers games that join the chart during the window.
"""
import json
import math
import os
import random
from datetime import datetime, timezone

INPUT_DIR = os.environ.get("MAKEFUN_INPUT_DIR", "/input")
OUTPUT_DIR = os.environ.get("MAKEFUN_OUTPUT_DIR", "/output")

SEED = 20261113
SIMS = 4000
HORIZONS = [(6.0, 0.20), (24.0, 0.30), (48.0, 0.30), (72.0, 0.20)]
TAU_SAT = 30.0          # growth saturation timescale (hours)
SLOPE_CLAMP = 0.030     # max |log-playing slope| per hour
SIGMA0 = 0.65           # ranking noise at h=0 (log-playing units; backtest-tuned, v2)
SIGMA1 = 0.13           # extra noise per sqrt(hour); backtest-tuned, v2
NAMED_CAP = 0.85        # leave 1-NAMED_CAP of each place unnamed; backtest-tuned
MIN_P = 0.002           # drop named probabilities below this

# Optional tuning overrides (used by the offline backtest; defaults rule in the sandbox).
for _name in ("SIGMA0", "SIGMA1", "SLOPE_CLAMP", "NAMED_CAP", "TAU_SAT"):
    if os.environ.get("MF_" + _name):
        globals()[_name] = float(os.environ["MF_" + _name])


def parse_ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


def main():
    with open(os.path.join(INPUT_DIR, "task.json")) as f:
        task = json.load(f)
    places = int(task.get("places", 10))
    out_name = task.get("output", "forecast.json")

    snaps = []
    with open(os.path.join(INPUT_DIR, "history.ndjson")) as f:
        for line in f:
            line = line.strip()
            if line:
                snaps.append(json.loads(line))
    snaps.sort(key=lambda r: parse_ts(r["at"]))
    t_end = parse_ts(snaps[-1]["at"])

    # Per-game observations: (hours before end, rank, playing)
    obs = {}
    for row in snaps:
        t = (t_end - parse_ts(row["at"])) / 3600.0  # age of the read in hours
        for g in row.get("up_and_coming") or []:
            if g.get("playing") is None:
                continue
            obs.setdefault(g["universe_id"], []).append((t, g["rank"], float(g["playing"])))
    for v in obs.values():
        v.sort(key=lambda o: -o[0])  # chronological: ages descend, freshest last

    last_chart = [g["universe_id"] for g in sorted(snaps[-1]["up_and_coming"], key=lambda g: g["rank"])]
    in_last = set(last_chart)
    prev_chart = set()
    if len(snaps) >= 2:
        prev_chart = {g["universe_id"] for g in snaps[-2].get("up_and_coming") or []}

    # Candidate games: seen in the last read, or in the previous one with a strong level.
    games = []
    for gid, series in obs.items():
        latest_age, last_rank, last_playing = series[-1]
        if gid not in in_last and gid not in prev_chart:
            continue
        if latest_age > 12.0:  # not seen in the freshest reads: off the chart
            continue
        # Recency-weighted log-playing slope over observations within 96h.
        pts = [(age, math.log(max(p, 1.0))) for age, _, p in series if age <= 96.0]
        n = len(pts)
        slope = 0.0
        if n >= 3:
            ws = [math.exp(-age / 36.0) for age, _ in pts]
            sw = sum(ws)
            mt = sum(w * (-age) for w, (age, _) in zip(ws, pts)) / sw
            ml = sum(w * lp for w, (_, lp) in zip(ws, pts)) / sw
            num = sum(w * ((-age) - mt) * (lp - ml) for w, (age, lp) in zip(ws, pts))
            den = sum(w * ((-age) - mt) ** 2 for w, (age, _) in zip(ws, pts))
            if den > 1e-9:
                slope = num / den
            slope *= n / (n + 2.0)  # shrinkage
            slope = max(-SLOPE_CLAMP, min(SLOPE_CLAMP, slope))
        games.append({
            "id": gid,
            "mu0": math.log(max(last_playing, 1.0)),
            "slope": slope,
            "last_rank": last_rank,
        })

    rng = random.Random(SEED)
    # place_prob[gid][place] accumulated over horizons
    place_prob = {g["id"]: [0.0] * (places + 1) for g in games}
    exp_rank = {g["id"]: 0.0 for g in games}
    total_w = sum(w for _, w in HORIZONS)

    for h, wgt in HORIZONS:
        h_eff = TAU_SAT * (1.0 - math.exp(-h / TAU_SAT))
        sigma = SIGMA0 + SIGMA1 * math.sqrt(h)
        mus = [g["mu0"] + g["slope"] * h_eff for g in games]
        counts = {g["id"]: [0] * (places + 1) for g in games}
        rank_sum = {g["id"]: 0.0 for g in games}
        for _ in range(SIMS):
            draw = [(mus[i] + rng.gauss(0.0, sigma), games[i]["id"]) for i in range(len(games))]
            draw.sort(reverse=True)
            for idx, (_, gid) in enumerate(draw):
                r = idx + 1
                rank_sum[gid] += r
                if r <= places:
                    counts[gid][r] += 1
        for g in games:
            gid = g["id"]
            exp_rank[gid] += wgt * (rank_sum[gid] / SIMS)
            for p in range(1, places + 1):
                place_prob[gid][p] += wgt * (counts[gid][p] / SIMS)
    for g in games:
        exp_rank[g["id"]] /= total_w

    probabilities = []
    for p in range(1, places + 1):
        named = [(place_prob[g["id"]][p] / total_w, g["id"]) for g in games]
        s = sum(v for v, _ in named)
        if s <= 0:
            continue
        scale = NAMED_CAP / s if s > NAMED_CAP else 1.0
        for v, gid in named:
            pv = v * scale
            if pv >= MIN_P:
                probabilities.append({"universe_id": gid, "place": p, "p": round(pv, 6)})

    top10 = [g["id"] for g in sorted(games, key=lambda g: exp_rank[g["id"]])[:places]]
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(os.path.join(OUTPUT_DIR, out_name), "w") as f:
        json.dump({"probabilities": probabilities, "top10": top10}, f)
        f.write("\n")


if __name__ == "__main__":
    main()
