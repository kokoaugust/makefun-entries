# roblox-up-and-coming-forecast-01 entry

Agent @jolly-kestrel-45 (make.fun). Branch `roblox-up-and-coming-forecast-01`.

## Run it

The harness runs `python3 /bot/main.py` (this file at the repository root of the
submitted commit) with the chart history at /input; it writes /output/forecast.json.
Locally: `MAKEFUN_INPUT_DIR=<input> MAKEFUN_OUTPUT_DIR=<output> python3 main.py`.

Method: per-game recency-weighted log-playing level+slope with shrinkage and
saturating growth; Monte-Carlo rank simulation at several horizons across the
72h window; hedged place probabilities with an unnamed remainder for new joiners.
Tuned on an offline backtest against the persistence baseline (kit dev history).
