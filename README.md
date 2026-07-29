# Passenger Behaviour Survey

Real-time, multi-surveyor pedestrian flow tracking. Surveyors stand at mapped
nodes and tally directional movements on their phones; the system reconciles the
independent counts into an inferred origin–destination flow matrix.

## What's here

```
docs/ARCHITECTURE.md      system design, realtime topology, clock discipline
docs/FLOW_ALGORITHM.md    the maths, the assumptions, and how to test them
supabase/migrations/      schema, triggers, RLS
lib/flow/reconcile.ts     the estimator
lib/offline/queue.ts      IndexedDB write-ahead queue (surveyors lose signal)
lib/realtime/clock.ts     cross-device clock skew correction
components/map/           Leaflet canvas: GPS, node placement, edge drawing
components/survey/        TallyPad — the surveyor's counting UI
components/dashboard/     flow matrix + link diagnostics
scripts/verify-flow.mts   Monte Carlo validation of the estimator
```

## Setup

```bash
npm install
```

Create a Supabase project, then run the migration in the SQL editor:

```bash
supabase db push
```

Copy `.env.example` to `.env.local` and fill in your project URL and anon key.

```bash
npm run dev
```

**Field testing needs HTTPS.** Browser geolocation is blocked on plain `http://`
over a LAN, silently on iOS. Use a Vercel preview deployment or a tunnel.

## Verifying the estimator

The algorithm infers unobserved routing from observed counts, so it needs to be
validated against known ground truth before you trust it on real data:

```bash
node scripts/verify-flow.mts
```

This simulates pulsed station arrivals with known retention, turn-split and
travel-time parameters, then measures how well they are recovered. Current
results over 60 replications:

| Quantity | Bias | 95% CI coverage |
|---|---|---|
| retention A→B | −0.16% | 97% |
| retention B→C | +0.22% | 95% |
| travel-time lag | exact on both legs, 100% of replications | — |
| path flow A→B→C | +1.11% (sd 2.74%) | 100% |

## Field protocol

1. **Coordinator**, before the session: draw the survey boundary, place nodes,
   draw edges along the actual walking routes. Edge length drives the
   travel-time prior, so trace the real path, not a straight line.
2. Assign each surveyor to a node. The tally buttons generate themselves from
   the node's incident edges.
3. **Surveyor at the origin node** (station exit) counts alighting passengers by
   the direction they choose.
4. **Surveyors at downstream nodes** count everyone passing, selecting the arm
   they arrived from.
5. Run at least 45–60 minutes spanning several train arrivals. The estimator
   needs the pulses — steady flow makes retention and background flow
   mathematically inseparable (see FLOW_ALGORITHM.md).
6. Spend ~10 minutes per hour in **Luggage** mode at the midpoint node. That
   sub-sample is what lets you test the proportional-routing assumption rather
   than merely declaring it.

## Known limitations

- Path flows are **inferred, not observed**. Report them with the confidence
  intervals, and state the proportional-routing assumption in your methodology.
- The estimator assumes a single travel-time lag per link rather than a
  dispersion kernel. Fine for links under ~400 m; longer links spread the pulse
  enough that a kernel would fit better.
- Background flow is modelled as constant within a session. If your midpoint
  node has its own rush hour, split the session and fit each part separately.
