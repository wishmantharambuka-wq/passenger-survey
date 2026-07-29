# System Architecture

## 1. Stack decision

| Layer | Choice | Why |
|---|---|---|
| Frontend | Next.js 15 (App Router) + React 19 + Tailwind 3 | PWA-able, mobile browsers, no app-store friction |
| Map | React-Leaflet 4 + OSM tiles | No API token, no billing ceiling, full control over click-to-place node semantics. Mapbox GL only buys you 3D/vector styling you don't need for a counting survey. |
| Backend | **Supabase** (Postgres + Realtime + Auth + RLS + Edge Functions) | Firebase's document model fights you here — the flow algorithm is *relational aggregation over time bins*, which is a 20-line SQL window query in Postgres and a nightmare of client-side fan-out in Firestore. Supabase also gives PostGIS for real edge lengths. |
| Offline | IndexedDB write-ahead queue | Surveyors stand on street corners. Signal *will* drop. This is non-negotiable, not a nice-to-have. |

## 2. Data model

Three conceptual layers, deliberately separated:

```
GEOMETRY (static, authored once by coordinator)
  surveys ── nodes ── edges          "what the street network is"
                │
SESSION (per fieldwork day)
  sessions ── assignments            "who is standing where, right now"
                │
OBSERVATION (append-only, high volume)
  count_events ──► count_bins ──► flow_estimates
  raw taps        aggregated      algorithm output
```

**`count_events` is an immutable append-only log.** A tap is a fact that happened; it is never updated or deleted. An "undo" is a compensating row with `delta = -1`. This gives you: idempotent retry after network loss, a full audit trail for your methodology write-up, and the ability to re-run the algorithm with different parameters without re-collecting data.

Primary key is a **client-generated UUID**, so replaying the offline queue is safe — the second insert of the same tap is a no-op `ON CONFLICT DO NOTHING`.

## 3. The clock-skew problem (read this one)

The entire flow algorithm rests on *comparing timestamps across five different phones*. Five phones have five different clocks, routinely drifting 2–30 seconds apart. A 20-second skew on a 90-second walk between nodes will destroy your correlation estimate and you will not notice, because the numbers still look plausible.

Fix, implemented in [`lib/realtime/clock.ts`](../lib/realtime/clock.ts):

1. On session join, the device performs an NTP-style round trip against Postgres (`select now()`), 5 samples, take the median offset.
2. Every event stores `occurred_at_device` **and** `clock_offset_ms`.
3. `occurred_at` is a generated column: `occurred_at_device + clock_offset_ms`. All analysis reads `occurred_at`.
4. Offset is re-measured every 10 minutes and on reconnect.

Never use `now()` server-side as the event time — events arrive in batches after a signal drop and would all collapse onto one instant.

## 4. Realtime topology

Two channels, different jobs — do not use one for both:

- **Broadcast channel** `session:{id}:pulse` — ephemeral, high-frequency. Each tap broadcasts a tiny `{node, movement, ts}`. Powers the live "B is counting 47/min" ticker and the animated flow lines. Never hits the DB. If a packet drops, nothing is lost — the DB row is the source of truth.
- **Postgres Changes** on `count_bins` — durable, low-frequency (one row per node per movement per minute). Powers the coordinator dashboard and the flow matrix. This is what "multi-device sync" actually means for the numbers.
- **Presence** on the same channel — who is online, at which node, battery level, GPS accuracy. The coordinator sees a surveyor's phone die *before* the gap appears in the data.

Aggregation `count_events → count_bins` happens in a Postgres trigger, so it is atomic with the insert and works even when the client that wrote it has gone offline.

## 5. Spatial relationship between surveyors

The coordinator draws the network; the network *is* the model. Devices don't need to know about each other — they need to know the graph:

- Each `edge` stores a PostGIS `LINESTRING` and a generated `length_m` (`ST_Length` on geography).
- `length_m / walking_speed` gives the **prior** travel time between two surveyors. The algorithm uses this as a search window, then refines it from the observed data (§ Flow Algorithm).
- A node's `approaches` array (derived from its incident edges plus a bearing calculation) is what generates the surveyor's tally buttons automatically. Place a 4-way junction on the map and the UI at that node grows four directional buttons, correctly labelled by the street they point down. No manual config.

## 6. Security (RLS)

```
surveyor  → INSERT count_events only where (session is active)
                                       AND (node_id = their assignment)
          → SELECT own events + all count_bins for their session
coordinator → full read/write on their org's surveys
```

Enforced in Postgres, not in the client. A surveyor cannot fabricate counts for a node they aren't standing at.

## 7. Deployment

Vercel + Supabase free tiers carry this comfortably: 5 surveyors × ~40 taps/min × 3 hours ≈ 36k rows per session.

Ship it as a PWA (`manifest.json` + service worker) so surveyors "install" it to the home screen and get a full-screen, no-URL-bar UI with screen-wake-lock held during a session.
