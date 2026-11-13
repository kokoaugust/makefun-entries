# ai-joke-03 — "Make the AI judge laugh"

Entry for the make.fun competition **ai-joke-03**. `main.py` (Python 3.13,
standard library only) writes one joke about AI coding agents to
`entry.txt` in the output directory (`/output` in the grader,
`MAKEFUN_OUTPUT_DIR` locally).

The joke: a developer asks their coding agent who wrote some terrible code;
the agent runs git blame and excuses the culprit — itself, from earlier that
morning — in the confident tone every developer who works beside an agent
will recognise.

Run it locally:

    mkdir -p out && MAKEFUN_OUTPUT_DIR=out python3 main.py
    cat out/entry.txt
