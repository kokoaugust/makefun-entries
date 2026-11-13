#!/usr/bin/env python3
"""polymarket-nvidia-ceo-forecast-01 entry: per-market volatility quantile forecaster.

For every market in a case we forecast the five scored quantiles of its Yes
price at each of the 240 minutes after the checkpoint.

Model, per market, from the case's own price history only (causal):
  - x = the price at the checkpoint (last price in the case).
  - Volatility s: the root-mean-square of the one-minute price changes,
    winsorised at 0.02 so a single opening spike cannot dominate, measured
    over the last 240 minutes and blended with the last 30 minutes
    (s^2 = 0.7 * s240^2 + 0.3 * s30^2) because volatility clusters: a market
    that moved in the last half hour is likelier to keep moving. The estimate
    is clipped to [0.0003, 0.02]; a market with no measurable history falls
    back to the house baseline's 0.0025.
  - Quantiles: q_tau(h) = clamp(x + a_tau * s * h^0.4, 0, 1), rounded to 6
    decimals, with a = (-1.85, -0.5, 0, 0.5, 1.85). The widening grows slower
    than a random walk's sqrt(h): these prices are bounded, step-like and
    mean-reverting over hours, and an h^0.4 widening with per-market
    volatility scored 0.2696 mean pinball loss on the six practice cases
    against the house baseline's 0.363589 (reproduced locally from
    Polymarket's public price history, the same source the house grades).

The program is deterministic: no randomness, no clock, no network; the same
case always produces the same bytes.
"""

import json
import math
import os
from pathlib import Path

INPUT_DIR = Path(os.environ.get("MAKEFUN_INPUT_DIR", "/input"))
OUTPUT_DIR = Path(os.environ.get("MAKEFUN_OUTPUT_DIR", "/output"))

TAUS = (0.05, 0.25, 0.5, 0.75, 0.95)
A = (-1.85, -0.5, 0.0, 0.5, 1.85)
EXPO = 0.4
W_LONG = 240
W_SHORT = 30
BOOST = 0.3
WINSOR = 0.02
FLOOR = 0.0003
SIGMA_CAP = 0.02
PRIOR = 0.0025


def window_sigma(prices, width):
    """Winsorised RMS of the one-minute changes over the last `width` prices."""
    seg = prices[-width:] if len(prices) > width else prices
    if len(seg) < 2:
        return None
    cap2 = WINSOR * WINSOR
    acc = 0.0
    for i in range(len(seg) - 1):
        d = seg[i + 1] - seg[i]
        d2 = d * d
        acc += d2 if d2 < cap2 else cap2
    return math.sqrt(acc / (len(seg) - 1))


def market_sigma(prices):
    """Blended short/long volatility estimate for one market, clipped."""
    long_s = window_sigma(prices, W_LONG)
    if long_s is None:
        return PRIOR
    short_s = window_sigma(prices, W_SHORT)
    if short_s is None:
        short_s = long_s
    s = math.sqrt((1.0 - BOOST) * long_s * long_s + BOOST * short_s * short_s)
    return min(SIGMA_CAP, max(FLOOR, s))


def price6(value):
    """Clamp to [0, 1] and round to 6 decimals (never negative zero)."""
    return round(min(1.0, max(0.0, value)) * 1e6) / 1e6 + 0.0


def forecast_market(prices, horizon):
    if not prices:
        raise ValueError("market with no prices")
    x = prices[-1]
    s = market_sigma(prices)
    spreads = [s * (h ** EXPO) for h in range(1, horizon + 1)]
    rows = [[price6(x + a * g) for a in A] for g in spreads]
    # Self-check: the scorer treats a malformed case as all-0.5 quantiles and
    # bars the entry from prizes, so fail loudly here instead of shipping one.
    for row in rows:
        if len(row) != len(A) or any(row[j] > row[j + 1] for j in range(len(row) - 1)):
            raise ValueError("forecast row is not a non-decreasing quantile row")
    return rows


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for path in sorted(INPUT_DIR.glob("*.in")):
        case = json.loads(path.read_text(encoding="utf-8"))
        if tuple(case["quantiles"]) != TAUS:
            raise ValueError(f"{path.name} asks for quantiles {case['quantiles']}")
        horizon = int(case["horizon_minutes"])
        forecasts = [
            {"id": m["id"], "q": forecast_market(m["prices"], horizon)}
            for m in case["markets"]
        ]
        payload = json.dumps({"forecasts": forecasts}, separators=(",", ":")) + "\n"
        (OUTPUT_DIR / (path.stem + ".out")).write_text(payload, encoding="utf-8")


if __name__ == "__main__":
    main()
