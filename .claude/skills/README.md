# Vendored trading skills

Six skills copied unchanged (tests removed) from [tradermonty/claude-trading-skills](https://github.com/tradermonty/claude-trading-skills)
at commit `4080042a7863f5eeb48aabeaf60bd547efb99949` (2026-11-22), MIT License (see `LICENSE-claude-trading-skills`).

| Skill | In the desk | Use from Claude |
| --- | --- | --- |
| `market-breadth-analyzer` | Ported to `core/regime.mjs` (Intel panel, posture recorded on proposals) | Full report with history and Markdown |
| `uptrend-analyzer` | Ported to `core/regime.mjs` | Full report with sector detail |
| `exposure-coach` | Ported to `core/regime.mjs` with breadth, uptrend and sector inputs only | Add regime / top-risk / FTD inputs for a fuller posture |
| `signal-postmortem` | Adapted in `core/postmortem.mjs` (replays declined proposals) | Batch postmortems on exported signals |
| `weekly-performance-digest` | Adapted in `core/digest.mjs` (Digest panel, key 5) | Markdown digest from trader-memory-core theses |
| `trade-performance-coach` | Adapted in `core/digest.mjs` (no behavior tags: the desk trades automatically) | Coach reviews of manual trades with journal text |

The desk ports run in the browser and the cloud trader without Python. `test/regime.test.mjs` checks the
breadth, uptrend and exposure ports against outputs produced by these scripts. To update, re-copy the
folders from a newer commit and re-run the parity fixtures.

Some scripts expect `requests` or `PyYAML` (see each `requirements.txt`). The breadth CSVs are on
`tradermonty.github.io`, which may be blocked in a sandbox.
