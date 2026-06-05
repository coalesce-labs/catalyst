---
name: orchestrate
description: "[MOVED] This skill migrated to the catalyst-legacy plugin in catalyst-dev v11.0.0 (CTL-726). Use /catalyst-legacy:orchestrate for wave-based orchestration. The current multi-ticket model is the execution-core daemon (dispatchMode: \"execution-core\")."
disable-model-invocation: true
---

# orchestrate — moved to catalyst-legacy

The wave-based orchestration workflow moved out of catalyst-dev in v11.0.0.

**Use `/catalyst-legacy:orchestrate` instead** (wave-based predecessor).

For the current multi-ticket model, use the execution-core daemon:
- Set `catalyst.orchestration.dispatchMode` to `"execution-core"` in `.catalyst/config.json`
- The daemon coordinates phase-agents (`phase-triage` … `phase-monitor-deploy`) per ticket

See `docs/orchestrator-overview.md` for the full pipeline comparison.
