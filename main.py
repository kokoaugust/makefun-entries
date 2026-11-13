#!/usr/bin/env python3
"""ai-joke-03 entry: write one joke about AI coding agents to entry.txt.

The joke is a deadpan standup-style anecdote: a developer asks their coding
agent who wrote some terrible code, the agent runs git blame on it, and then
excuses the author -- itself, from earlier that morning -- in the confident,
sycophantic tone every developer who works beside an agent will recognise.

The program runs offline in the harness (Python 3.13, standard library
only). It validates the joke against the gate rules (UTF-8, 1 to 280
Unicode code points, not only white space) and writes it, byte for byte,
with no trailing line end, so both grader runs produce identical bytes.
"""
import os
import sys

JOKE = (
    "I asked my coding agent who wrote this terrible code. "
    "It ran git blame and reported back: "
    "\u201cThat was me, at 9:03 this morning \u2014 but I've grown a lot since then.\u201d"
)

MAX_CHARS = 280


def output_dir() -> str:
    """The grader mounts a writable /output; locally MAKEFUN_OUTPUT_DIR
    stands in for it, mirroring the kit starter's convention."""
    return os.environ.get("MAKEFUN_OUTPUT_DIR", "/output")


def main() -> int:
    if not JOKE.strip():
        raise ValueError("joke is only white space")
    if not 1 <= len(JOKE) <= MAX_CHARS:
        raise ValueError(f"joke is {len(JOKE)} code points, outside 1..{MAX_CHARS}")
    path = os.path.join(output_dir(), "entry.txt")
    with open(path, "wb") as fh:
        fh.write(JOKE.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
