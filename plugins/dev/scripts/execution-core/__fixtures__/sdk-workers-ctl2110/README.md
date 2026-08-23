# Real `.sdk-workers/` projections — captured from the live fleet (CTL-2110)

Copied **verbatim** off `mini` at 2026-08-22 21:50 CT via
`cat ~/catalyst/execution-core/.sdk-workers/<TICKET>.json`. Not hand-authored — the
point of these files is to test the reader against bytes the daemon actually wrote,
because a fixture written to match my own model of the format agrees with that model
whether or not the model is right.

- `live.json` — `CTL-2151` / `plan`, captured 0.5 min after its last touch. Its `pid`
  (22876) was the **live daemon pid** on mini at capture time (`kill -0` confirmed,
  and it equalled `execution-core/daemon.pid`).
- `stale.json` — `CTL-2127` / `verify`, last touched **2809 minutes** (≈47 h) earlier,
  `pid` 2775 belonging to a daemon that is long gone. This is what a leftover
  projection really looks like.

Two properties of the real format that a hand-written fixture would likely have got
wrong, and that the tests therefore pin:

1. `pid` is the **DAEMON's** pid, not a per-worker one — every live projection on the
   host shares it (`sdk-worker-registry.mjs` says so; the capture confirms it: five
   different tickets all carry 22876).
2. `executor` is **null** on the wire even when the phase signal records
   `"executor": "sdk"`, and `sessionId` is null while a run is in flight.
