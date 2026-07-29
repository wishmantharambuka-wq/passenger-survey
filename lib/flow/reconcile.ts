/**
 * Flow reconciliation: infer A→B→C pedestrian routing from anonymous
 * screenline counts at each node.
 *
 * See docs/FLOW_ALGORITHM.md for the derivation. Summary:
 *   1. bin all nodes onto a shared, clock-skew-corrected time grid
 *   2. estimate the A→B travel lag by normalised cross-correlation,
 *      seeded from the drawn edge length
 *   3. fit  y_B[t] = rho * d_A→B[t - tau] + b   with 0<=rho<=1, b>=0
 *   4. chain retentions along the path, under proportional routing
 *   5. moving-block bootstrap for confidence intervals
 */

import type {
  BinnedSeries,
  LinkFit,
  NodeCode,
  NodeSummary,
  PathEstimate,
  ReconcileOptions,
  ReconcileResult,
} from "./types";

const DEFAULTS: Required<Omit<ReconcileOptions, "seed">> = {
  walkingSpeedMps: 1.35,
  lagWindow: [0.5, 2.0],
  bootstrapSamples: 400,
  blockBins: 5,
  minCorrelation: 0.3,
};

// ── binning ──────────────────────────────────────────────────────────────

export interface RawBin {
  nodeCode: NodeCode;
  fromApproach: string | null;
  toApproach: string;
  binStartMs: number;
  count: number;
}

/**
 * Fold `count_bins` rows onto one dense grid shared by every node, so series
 * from different devices are index-aligned and can be correlated directly.
 */
export function toSeries(rows: RawBin[], binMs: number): BinnedSeries[] {
  if (rows.length === 0) return [];

  const start = Math.min(...rows.map((r) => r.binStartMs));
  const end = Math.max(...rows.map((r) => r.binStartMs));
  const n = Math.floor((end - start) / binMs) + 1;

  const groups = new Map<string, BinnedSeries>();
  for (const r of rows) {
    const key = `${r.nodeCode}|${r.fromApproach ?? ""}|${r.toApproach}`;
    let s = groups.get(key);
    if (!s) {
      s = {
        nodeCode: r.nodeCode,
        fromApproach: r.fromApproach,
        toApproach: r.toApproach,
        binStart: start,
        binMs,
        values: new Float64Array(n),
      };
      groups.set(key, s);
    }
    const i = Math.floor((r.binStartMs - start) / binMs);
    // counts can go negative mid-session from undo events; clamp the fold
    s.values[i] = Math.max(0, s.values[i] + r.count);
  }
  return [...groups.values()];
}

/** Sum every movement observed at a node — the "total volume passing" series. */
export function totalAtNode(series: BinnedSeries[], node: NodeCode): Float64Array {
  const mine = series.filter((s) => s.nodeCode === node);
  if (mine.length === 0) return new Float64Array(0);
  const out = new Float64Array(mine[0].values.length);
  for (const s of mine) for (let i = 0; i < out.length; i++) out[i] += s.values[i];
  return out;
}

/** Departures from `node` toward a named approach — the driving series. */
export function departuresToward(
  series: BinnedSeries[],
  node: NodeCode,
  approach: string,
): Float64Array {
  const mine = series.filter((s) => s.nodeCode === node && s.toApproach === approach);
  if (mine.length === 0) return new Float64Array(0);
  const out = new Float64Array(mine[0].values.length);
  for (const s of mine) for (let i = 0; i < out.length; i++) out[i] += s.values[i];
  return out;
}

// ── step 2: lag estimation ───────────────────────────────────────────────

/** Pearson correlation of x[t] against y[t+lag], over the overlapping span. */
function laggedCorrelation(x: Float64Array, y: Float64Array, lag: number): number {
  const n = Math.min(x.length, y.length - lag);
  if (n < 4) return 0;

  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i + lag]; }
  const mx = sx / n, my = sy / n;

  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - mx, b = y[i + lag] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

export function estimateLag(
  x: Float64Array,
  y: Float64Array,
  minLag: number,
  maxLag: number,
): { lag: number; correlation: number } {
  let best = { lag: Math.max(0, minLag), correlation: -Infinity };
  for (let lag = Math.max(0, Math.floor(minLag)); lag <= Math.ceil(maxLag); lag++) {
    const c = laggedCorrelation(x, y, lag);
    if (c > best.correlation) best = { lag, correlation: c };
  }
  if (best.correlation === -Infinity) best = { lag: 0, correlation: 0 };
  return best;
}

// ── step 3: box-constrained 2-parameter weighted least squares ───────────

/**
 * Fit  y[t] = rho*x[t] + b  minimising sum w[t]*(residual)^2,
 * subject to 0 <= rho <= 1 and b >= 0.
 *
 * Convex quadratic over a box: the minimum is either interior, on a face
 * (one variable clamped, the other free), or at a corner. All candidates are
 * closed-form, so we enumerate and take the feasible one with lowest SSE.
 * No iteration, no convergence failure.
 */
export function fitRetention(
  x: Float64Array,
  y: Float64Array,
  weights?: Float64Array,
): { rho: number; background: number; sse: number } {
  if (weights) return solveBoxed(x, y, weights);

  // Counts are Poisson (variance ≈ mean), so bins should be weighted by
  // 1/mean. Weighting by 1/OBSERVED y biases rho upward — a bin that happened
  // to come in low gets extra leverage. Two-pass IRLS instead: fit unweighted,
  // then weight by 1/FITTED. Removes the bias; a third pass changes nothing
  // measurable.
  const n = Math.min(x.length, y.length);
  const flat = new Float64Array(n).fill(1);
  const pass1 = solveBoxed(x, y, flat);

  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 1 / Math.max(pass1.rho * x[i] + pass1.background, 1);
  return solveBoxed(x, y, w);
}

function solveBoxed(
  x: Float64Array,
  y: Float64Array,
  w: Float64Array,
): { rho: number; background: number; sse: number } {
  const n = Math.min(x.length, y.length);

  let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0, Syy = 0;
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    Sw += wi; Sx += wi * x[i]; Sy += wi * y[i];
    Sxx += wi * x[i] * x[i]; Sxy += wi * x[i] * y[i]; Syy += wi * y[i] * y[i];
  }
  if (Sw === 0) return { rho: 0, background: 0, sse: 0 };

  const sse = (rho: number, b: number) =>
    Syy - 2 * rho * Sxy - 2 * b * Sy + rho * rho * Sxx + 2 * rho * b * Sx + b * b * Sw;

  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const candidates: Array<[number, number]> = [];

  // interior: unconstrained normal equations
  const det = Sxx * Sw - Sx * Sx;
  if (Math.abs(det) > 1e-9) {
    candidates.push([(Sxy * Sw - Sx * Sy) / det, (Sxx * Sy - Sx * Sxy) / det]);
  }
  // face b = 0, rho free
  if (Sxx > 0) candidates.push([Sxy / Sxx, 0]);
  // faces rho = 0 and rho = 1, b free
  candidates.push([0, Sy / Sw]);
  candidates.push([1, (Sy - Sx) / Sw]);
  // corners
  candidates.push([0, 0], [1, 0]);

  let best = { rho: 0, background: 0, sse: Infinity };
  for (const [r, b] of candidates) {
    const rr = clamp01(r), bb = Math.max(0, b);
    // only accept a candidate that is actually feasible as-proposed, or its
    // projection — projection is safe here because the box is axis-aligned
    const e = sse(rr, bb);
    if (e < best.sse) best = { rho: rr, background: bb, sse: e };
  }
  return best;
}

// ── step 5: moving-block bootstrap ───────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bootstrapRho(
  x: Float64Array,
  y: Float64Array,
  samples: number,
  blockBins: number,
  rand: () => number,
): [number, number] {
  const n = Math.min(x.length, y.length);
  if (samples <= 0 || n < blockBins * 3) return [NaN, NaN];

  const nBlocks = Math.ceil(n / blockBins);
  const draws: number[] = [];
  const bx = new Float64Array(nBlocks * blockBins);
  const by = new Float64Array(nBlocks * blockBins);

  for (let s = 0; s < samples; s++) {
    let k = 0;
    for (let bi = 0; bi < nBlocks; bi++) {
      const start = Math.floor(rand() * Math.max(1, n - blockBins));
      for (let j = 0; j < blockBins; j++, k++) {
        bx[k] = x[start + j] ?? 0;
        by[k] = y[start + j] ?? 0;
      }
    }
    draws.push(fitRetention(bx.subarray(0, k), by.subarray(0, k)).rho);
  }
  draws.sort((a, b) => a - b);
  return [
    draws[Math.floor(0.025 * draws.length)],
    draws[Math.min(draws.length - 1, Math.floor(0.975 * draws.length))],
  ];
}

// ── the public entry point ───────────────────────────────────────────────

export interface LinkSpec {
  from: NodeCode;
  to: NodeCode;
  /** approach label at `from` that points toward `to` — names the driving series */
  departureApproach: string;
  /** drawn edge length in metres; seeds the lag search and validates the result */
  lengthM: number | null;
}

/**
 * Enumerate every simple path (no repeated node) in the drawn network, from
 * every root, up to `maxDepth` nodes long. Each path becomes an OD flow to
 * estimate; each prefix of a path becomes a truncated "reached k, not k+1"
 * variant when we chain them.
 */
export function enumeratePaths(
  links: LinkSpec[],
  opts: { maxDepth?: number; roots?: NodeCode[] } = {},
): NodeCode[][] {
  const maxDepth = opts.maxDepth ?? 4;
  const adj = new Map<NodeCode, LinkSpec[]>();
  const nodes = new Set<NodeCode>();
  for (const l of links) {
    if (!adj.has(l.from)) adj.set(l.from, []);
    adj.get(l.from)!.push(l);
    nodes.add(l.from);
    nodes.add(l.to);
  }

  const roots = opts.roots ?? [...nodes];
  const out: NodeCode[][] = [];

  const walk = (path: NodeCode[]) => {
    if (path.length >= 2) out.push(path.slice());
    if (path.length >= maxDepth) return;
    const last = path[path.length - 1];
    for (const l of adj.get(last) ?? []) {
      if (path.includes(l.to)) continue; // no loops in a single OD path
      path.push(l.to);
      walk(path);
      path.pop();
    }
  };

  for (const r of roots) walk([r]);
  return out;
}

export function reconcile(
  series: BinnedSeries[],
  links: LinkSpec[],
  paths: NodeCode[][],
  opts: ReconcileOptions = {},
): ReconcileResult {
  const o = { ...DEFAULTS, ...opts };
  const rand = mulberry32(opts.seed ?? 42);
  const binMs = series[0]?.binMs ?? 60_000;
  const binStart = series[0]?.binStart ?? 0;
  const binCount = series[0]?.values.length ?? 0;
  const binSec = binMs / 1000;

  const fits: LinkFit[] = links.map((spec) => {
    const warnings: string[] = [];
    const x = departuresToward(series, spec.from, spec.departureApproach);
    const y = totalAtNode(series, spec.to);

    if (x.length === 0 || y.length === 0) {
      return emptyFit(spec, ["no data for one or both nodes"]);
    }

    // lag search window, seeded from the drawn geometry
    const priorBins =
      spec.lengthM != null ? spec.lengthM / o.walkingSpeedMps / binSec : 1;
    const minLag = Math.max(0, Math.floor(priorBins * o.lagWindow[0]));
    const maxLag = Math.max(minLag + 1, Math.ceil(priorBins * o.lagWindow[1]));
    const { lag, correlation } = estimateLag(x, y, minLag, maxLag);

    if (lag <= minLag || lag >= maxLag) {
      warnings.push(
        "lag estimate sits at the edge of the search window — check the drawn edge length",
      );
    }

    // align: compare departures at t against arrivals at t+lag
    const m = Math.min(x.length, y.length - lag);
    const xs = x.subarray(0, Math.max(0, m));
    const ys = y.subarray(lag, lag + Math.max(0, m));

    const { rho, background } = fitRetention(xs, ys);
    const [rhoLow, rhoHigh] = bootstrapRho(xs, ys, o.bootstrapSamples, o.blockBins, rand);

    const departures = sum(x);
    const arrivals = sum(y);
    const originTotal = sum(totalAtNode(series, spec.from));
    const turnShare =
      originTotal > 0 ? Math.min(1, Math.max(0, departures / originTotal)) : 0;
    const tauSeconds = lag * binSec;

    if (rho >= 0.999) {
      warnings.push("retention clamped at 1.0 — the origin node may be undercounting");
    }
    if (rho <= 0.2 && correlation >= o.minCorrelation) {
      warnings.push("very low retention — confirm the downstream surveyor's position");
    }
    if (background * Math.max(1, m) > 0.6 * arrivals) {
      warnings.push("destination is dominated by background flow; expect wide intervals");
    }

    return {
      from: spec.from,
      to: spec.to,
      rho,
      rhoLow: Number.isNaN(rhoLow) ? rho : rhoLow,
      rhoHigh: Number.isNaN(rhoHigh) ? rho : rhoHigh,
      tauBins: lag,
      tauSeconds,
      effectiveSpeedMps:
        spec.lengthM != null && tauSeconds > 0 ? spec.lengthM / tauSeconds : null,
      correlation,
      background,
      turnShare,
      departures,
      arrivals,
      confidence: correlation < o.minCorrelation ? "low_confidence" : "ok",
      warnings,
    };
  });

  const byLink = new Map(fits.map((f) => [`${f.from}->${f.to}`, f]));
  const pathEstimates: PathEstimate[] = [];

  for (const path of paths) {
    const legs: LinkFit[] = [];
    let ok = true;
    for (let i = 0; i + 1 < path.length; i++) {
      const f = byLink.get(`${path[i]}->${path[i + 1]}`);
      if (!f) { ok = false; break; }
      legs.push(f);
    }
    if (!ok || legs.length === 0) continue;

    const q = legs[0].departures;
    const confidence = legs.some((l) => l.confidence === "low_confidence")
      ? "low_confidence"
      : "ok";

    /**
     * Per-leg continuation probability.
     *
     * Leg 0 is just the retention on A→B, because A's departures toward B are
     * directly observed. Every later leg also needs the TURN SHARE at the
     * intermediate node: of everyone arriving at B, only some fraction heads
     * toward C at all. Omitting it silently inflates the path flow.
     *
     * Using the node-wide turn share for the A-origin subgroup IS the
     * proportional-routing assumption — see docs/FLOW_ALGORITHM.md step 4.
     */
    const factor = (k: number, rho: (f: LinkFit) => number) =>
      k === 0
        ? rho(legs[0])
        : legs[k].turnShare * rho(legs[k]);

    const through = (upto: number, rho: (f: LinkFit) => number) => {
      let v = q;
      for (let k = 0; k <= upto; k++) v *= factor(k, rho);
      return v;
    };

    // completed path: A→B→C
    pathEstimates.push({
      path,
      label: path.join("→"),
      estimate: through(legs.length - 1, (f) => f.rho),
      ciLow: through(legs.length - 1, (f) => f.rhoLow),
      ciHigh: through(legs.length - 1, (f) => f.rhoHigh),
      confidence,
    });

    // truncated variants: reached path[k] but never reached path[k+1]
    for (let k = 0; k < legs.length; k++) {
      const base = (rho: (f: LinkFit) => number) => (k === 0 ? q : through(k - 1, rho));
      pathEstimates.push({
        path: path.slice(0, k + 1),
        label: `${path.slice(0, k + 1).join("→")}→¬${path[k + 1]}`,
        estimate: base((f) => f.rho) * (1 - factor(k, (f) => f.rho)),
        ciLow: base((f) => f.rhoLow) * (1 - factor(k, (f) => f.rhoHigh)),
        ciHigh: base((f) => f.rhoHigh) * (1 - factor(k, (f) => f.rhoLow)),
        confidence,
      });
    }
  }

  // ── per-node summaries ─────────────────────────────────────────────────
  // "Total volume passing Node A" and how it distributed across A's exits.
  const nodeCodes = new Set<NodeCode>();
  for (const l of links) { nodeCodes.add(l.from); nodeCodes.add(l.to); }
  for (const s of series) nodeCodes.add(s.nodeCode);

  const nodeSummaries: NodeSummary[] = [...nodeCodes].sort().map((code) => {
    const outboundByArm: Record<string, number> = {};
    let totalVolume = 0;
    for (const s of series) {
      if (s.nodeCode !== code) continue;
      let sub = 0;
      for (let i = 0; i < s.values.length; i++) sub += s.values[i];
      outboundByArm[s.toApproach] = (outboundByArm[s.toApproach] ?? 0) + sub;
      totalVolume += sub;
    }
    return { code, totalVolume, outboundByArm };
  });

  return {
    links: fits,
    paths: pathEstimates,
    nodes: nodeSummaries,
    binMs, binStart, binCount,
  };
}

function sum(a: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}

function emptyFit(spec: LinkSpec, warnings: string[]): LinkFit {
  return {
    from: spec.from, to: spec.to,
    rho: 0, rhoLow: 0, rhoHigh: 0,
    tauBins: 0, tauSeconds: 0, effectiveSpeedMps: null,
    correlation: 0, background: 0, turnShare: 0, departures: 0, arrivals: 0,
    confidence: "low_confidence", warnings,
  };
}
