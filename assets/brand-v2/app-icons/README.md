# Linear OAuth app icons

Square 512×512 icons for the Catalyst Linear OAuth apps. Same brand mark + Operator
Console surface (`#0B0D10`), differentiated by the **system accent** so the two
app-actors are distinguishable at a glance in Linear's activity feed.

| App | Role | Accent | File |
|-----|------|--------|------|
| **Catalyst** | phase workers — pick up tickets, comment, open PRs | Signal Amber `#FFB547` | `catalyst-icon-512.png` |
| **Catalyst Orchestrator** | execution-core daemon — admission control, state/label transitions, dispatch | Operator Console info `#58A6FF` | `orchestrator-icon-512.png` |

Both accents are defined tokens in `packages/tokens/tokens/operator-console.json`
(`accent` = Signal Amber, `info` = the blue). Amber = the _doers_; info-blue = the
_system / control-plane_.

## Regenerate

```sh
./build.sh   # renders both PNGs from ../mark.svg via the favicons/build.sh pipeline
```

`orchestrator-icon.svg` is a self-contained, fixed-color source (mark + surface baked
in) — handy for quick previews. The canonical, themable source remains `../mark.svg`.
