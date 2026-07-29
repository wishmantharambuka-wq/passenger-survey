export type NodeCode = string;

/** One node's counts for one movement, binned onto the shared time grid. */
export interface BinnedSeries {
  nodeCode: NodeCode;
  /** null at an origin node — passengers entering the network (alighting). */
  fromApproach: string | null;
  toApproach: string;
  /** Grid start, epoch ms. All series in a session share binStart and binMs. */
  binStart: number;
  binMs: number;
  values: Float64Array;
}

export interface LinkFit {
  from: NodeCode;
  to: NodeCode;
  /** retention: fraction of departures from `from` that reach `to`, in [0,1] */
  rho: number;
  rhoLow: number;
  rhoHigh: number;
  /** estimated lag in bins, refined from the data */
  tauBins: number;
  /** travel time implied by tauBins, seconds */
  tauSeconds: number;
  /** effective walking speed implied by tau and the drawn edge length, m/s */
  effectiveSpeedMps: number | null;
  /** peak normalised cross-correlation at tauBins */
  correlation: number;
  /** per-bin background flow at `to` not originating from `from` */
  background: number;
  /** departures toward `to` / total volume observed at `from` — the turn split */
  turnShare: number;
  departures: number;
  arrivals: number;
  confidence: "ok" | "low_confidence";
  warnings: string[];
}

export interface PathEstimate {
  path: NodeCode[];
  /** 'A→B→C', or 'A→B→¬C' for the truncated variant */
  label: string;
  estimate: number;
  ciLow: number;
  ciHigh: number;
  confidence: "ok" | "low_confidence";
}

export interface ReconcileOptions {
  /** nominal walking speed for the travel-time prior, m/s */
  walkingSpeedMps?: number;
  /** lag search window as multiples of the geometric prior */
  lagWindow?: [number, number];
  /** bootstrap resamples for confidence intervals; 0 disables */
  bootstrapSamples?: number;
  /** moving-block length in bins — preserve pulse autocorrelation */
  blockBins?: number;
  /** below this peak correlation the link is reported as low_confidence */
  minCorrelation?: number;
  seed?: number;
}

/** Volume observed at a single node, plus its outbound split. */
export interface NodeSummary {
  code: NodeCode;
  totalVolume: number;
  /** { armLabel: count } — how the total broke down across the node's exits */
  outboundByArm: Record<string, number>;
}

export interface ReconcileResult {
  links: LinkFit[];
  paths: PathEstimate[];
  nodes: NodeSummary[];
  binMs: number;
  binStart: number;
  binCount: number;
}
