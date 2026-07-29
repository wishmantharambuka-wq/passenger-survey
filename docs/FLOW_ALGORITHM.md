# The Flow Reconciliation Algorithm

## The problem, stated honestly

Your surveyors produce **screenline counts** — anonymous totals crossing a point. They do not produce **trajectories**. Nobody records "person #418 went A→B→C". So the A→B→C flow is not measured; it is **inferred**. This is the classic *OD matrix estimation from link counts* problem, and it is underdetermined in general.

What makes it solvable in your specific case is the railway station. Trains arrive in **pulses**. A pulse is a natural experiment: a burst of 200 people leaves A at 08:14, and ~90 seconds later a bump appears at B. The size of that bump relative to the pulse *is* the retention rate. Steady, featureless flow would leave ρ and background flow mathematically confounded; pulsed flow separates them. Your data generating process is unusually favourable — exploit it.

---

## Notation

| Symbol | Meaning |
|---|---|
| `Δ` | bin width (default 60 s; use 30 s if pulses are sharp) |
| `d_A→B[t]` | passengers departing A toward B in bin `t` (**observed** — surveyor A logs direction) |
| `y_B[t]` | passengers crossing B in bin `t` (**observed** — surveyor B's total) |
| `τ_AB` | travel-time lag A→B, in bins |
| `ρ_AB` | retention: fraction of A→B departures that actually reach B, ∈ [0,1] |
| `b_B[t]` | background flow at B from unobserved sources (side lanes, shops, non-station pedestrians), ≥ 0 |

---

## Step 1 — Bin and align

Bin every node's events into a common time grid using the **skew-corrected** timestamp (`occurred_at`, not device time — see Architecture §3).

## Step 2 — Estimate the lag τ from the data

Prior from map geometry: `τ₀ = length_m / 1.35 m·s⁻¹` (mean adult walking speed; use 1.2 for crowded/elderly-heavy footways).

Refine by **normalised cross-correlation** of the two flow series over a search window of `[0.5·τ₀, 2.0·τ₀]`:

```
τ̂_AB = argmax_τ  corr( d_A→B[t], y_B[t+τ] )
```

This is the "timestamped conservation" you asked for, made concrete. Two useful properties:

- It self-calibrates. Real walking speed on a real footway with real crowding is not 1.35 m/s, and now you don't have to guess.
- **`τ̂` is itself a finding.** Effective walking speed by time of day is a legitimate result for an urban-behaviour paper, and it falls out of the algorithm for free.

If the peak correlation is below ~0.3, the link is not identifiable from this data — the algorithm reports `LOW_CONFIDENCE` rather than a fake number.

## Step 3 — Estimate retention ρ and background b

Fit, over all bins, the constrained linear model:

```
y_B[t]  =  ρ_AB · d_A→B[t − τ̂]  +  b_B[t]  +  ε[t]
```

Taking `b_B` as locally constant (`b_B[t] = b`), this is a two-parameter least-squares fit with box constraints:

```
minimise  Σ_t ( y_B[t] − ρ·x[t] − b )²      s.t.  0 ≤ ρ ≤ 1,  b ≥ 0
```

The feasible set is a box and the objective is convex quadratic, so the optimum is the unconstrained solution, or lies on a face, or on a corner — all six candidates are closed-form. `fitRetention()` in [`lib/flow/reconcile.ts`](../lib/flow/reconcile.ts) enumerates them exactly. No iterative solver, no convergence failures, runs in microseconds on a phone.

Weighting: counts are Poisson, so variance ≈ mean. Weight each bin by `1 / max(y_B[t], 1)` so the busy pulse bins don't dominate purely by magnitude.

**Interpretation:**

```
passed A→B          = ρ̂_AB · Σ_t d_A→B[t]
diverted before B   = (1 − ρ̂_AB) · Σ_t d_A→B[t]
background at B     = Σ_t y_B[t] − ρ̂_AB · Σ_t d_A→B[t]
```

That is your "how many came from A but never reached B", and it is separated from "people at B who never came from A" — which a naive `count_B − count_A` subtraction silently conflates, and which is the single most common error in manual pedestrian surveys.

## Step 4 — Chain to C

```
f(A→B→C)     = Q_A→B · ρ̂_AB · ρ̂_BC
f(A→B→¬C)    = Q_A→B · ρ̂_AB · (1 − ρ̂_BC)
f(A→¬B)      = Q_A→B · (1 − ρ̂_AB)
```

with `ρ̂_BC` fitted the same way, using B's outflow toward C as the driving series.

### The assumption you must declare

This chaining assumes **proportional routing**: a pedestrian who arrives at B from A diverts at B with the same probability as any other pedestrian at B. Formally, route choice is Markov (memoryless) at each node.

This is the standard assumption in traffic assignment, and it is *sometimes wrong* — station passengers may be systematically more likely to continue straight than local pedestrians. Do not bury this. Two responses:

1. **Report it as a stated assumption** in your methodology. Every published link-count-based OD study does.
2. **Test it cheaply.** The tally UI supports an optional attribute tag (see below). Have surveyor B spend 10 minutes per hour recording a coarse attribute — carrying luggage / not — for everyone passing. Station-origin pedestrians are over-represented among luggage carriers. Comparing the luggage-carrier turn split at B against the overall turn split gives you a direct empirical estimate of how badly proportional routing is violated, and a correction factor. This is a ~30 line addition to the UI that upgrades your result from "estimated under assumption" to "estimated and validated".

## Step 5 — Uncertainty

Point estimates without intervals are not defensible. Use a **moving-block bootstrap** over time bins (block length ≈ 5 bins, to preserve the pulse autocorrelation), 500 resamples, refit ρ each time, report the 2.5/97.5 percentiles. Path uncertainty comes from resampling the whole chain jointly, so the ρ_AB and ρ_BC intervals compose correctly rather than being naively multiplied.

## Step 6 — Consistency checks (run these, surface them in the UI)

| Check | Meaning if it fires |
|---|---|
| `ρ̂ = 1.0` exactly, boundary-clamped | B may be counting people A never sent, or A is undercounting. Look at the surveyors. |
| `ρ̂ < 0.2` | Either a genuine major diversion point, or surveyor B is at the wrong location / counting the wrong movement. |
| background `b` > 60% of B's total | B's site is dominated by non-station flow — fine, but the A→B estimate rests on a small signal. Widen your CI expectations. |
| `τ̂` at the edge of the search window | Geometry is wrong or the correlation is spurious. |
| correlation peak < 0.3 | `LOW_CONFIDENCE` — do not report the path flow as a number. |

---

## Why not a full dynamic OD estimator?

You could formulate the whole network as one weighted NNLS over path flows with a travel-time kernel (dispersion, not a single lag) and solve with projected gradient. It's maybe 150 more lines. For 3–6 nodes with pulsed input it will land within a few percent of the pairwise method above, is much harder to explain to an examiner, and fails opaquely. Start with the pairwise estimator; the data structures in `reconcile.ts` are already shaped so a global solver can be dropped in later as a second `method` on `flow_estimates`.
