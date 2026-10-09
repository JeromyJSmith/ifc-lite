---
"@ifc-lite/clash": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

Clash runs can be bounded in time, and the MCP clash tools say what their rules matched.

`ClashSettings.timeBudgetMs` is a wall-clock budget for a run. Past it the run rejects with `ClashTimeBudgetExceededError` (rule, element pair, triangle counts) and returns no partial result. The TS kernel reads the clock inside a pair's triangle loop, which an `AbortSignal` cannot do: one pair of two 213,253-triangle meshes held a run for more than four minutes with no way to stop it. `ifc-lite clash --time-budget <seconds>` exposes it; MCP `clash_check` and `clash_matrix` take `time_budget_s` (default 120).

MCP `clash_check` and `clash_matrix` now return `ruleCoverage` and `ruleCoverageOutcome`, as the CLI's `--json` already did, and the summary line says when no rule matched any element. Before, a selector that matched nothing read as a clean model.
