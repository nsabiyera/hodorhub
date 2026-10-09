# HodorHub — Support-Score Model (draft v0.1)

> Resolves the open question behind **US-3.5** (ingest real social signals) and **US-9.3** (prevent gaming). Defines how on-platform likes and real Facebook/Twitter engagement combine into the scores that drive corporate discovery (**US-4.2**).

## 1. Why two scores, not one

A single number can't serve both purposes the product needs:

- **Support Score (S)** — *cumulative, lifetime* backing. Answers "how much total public support does this project have?" Used for the **"Most supported"** ranking and the number shown on the project page.
- **Momentum Score (M)** — *recency-weighted*. Answers "is this project gaining traction **right now**?" Used for **"Trending"** (US-3.6) and to alert watching corporations (US-4.4).

Discovery (US-4.2) lets corporations sort by either, and the default feed blends both (§6).

## 2. Signals we count

Every countable action is an **engagement event** with a base weight reflecting how strongly it signals genuine support. Amplification (putting your own reputation behind the cause) counts most; passive approval counts least.

| Source | Action | Base weight `w` | Rationale |
|--------|--------|-----------------|-----------|
| On-platform | Support / like | 1.0 | Passive endorsement, but from a known HodorHub user. |
| On-platform | Share-out click (to FB/X) | 3.0 | Active amplification originating on-platform. |
| Facebook | Reaction (like/love/…) | 1.0 | Passive. |
| Facebook | Comment | 2.0 | Active engagement, higher intent. |
| Facebook | Share | 4.0 | Amplification to the sharer's own network. |
| Twitter/X | Like | 1.0 | Passive. |
| Twitter/X | Reply | 2.0 | Active engagement. |
| Twitter/X | Repost | 4.0 | Amplification. |
| Twitter/X | Quote | 4.0 | Amplification + endorsement. |

Weights are **configuration, not code** — see §8. They will need calibration against real data.

## 3. Per-event adjustments

Each event `i` contributes an **effective value** `v_i`:

```
v_i = w_i × trust_i × recency_i
```

### 3.1 Trust multiplier `trust ∈ [0, 1]` — the anti-gaming core (US-9.3)

Scores the credibility of the actor behind the event. Purchased/bot engagement is cheap; this makes it count for little.

```
trust = clamp(base × age_factor × behaviour_factor, 0, 1)
```

| Component | Effect |
|-----------|--------|
| `base` | Verified/identifiable actor → 1.0; unverifiable/anonymous social actor → 0.3 ceiling. |
| `age_factor` | Accounts younger than a threshold (e.g. 30 days) are discounted toward 0. |
| `behaviour_factor` | Lowered by bot-like signals: extreme follower/following ratios, burst activity, prior flags, default avatars, engagement-only history. |

New/unverifiable actors are **not** dropped to zero — they're dampened — so genuine grassroots support still counts while cheap fakes are marginalised.

### 3.2 Recency multiplier `recency`

- **For S (lifetime):** `recency = 1` (all events count fully, forever).
- **For M (momentum):** exponential decay with a **7-day half-life**:

```
recency = exp(−λ × age_days)      λ = ln(2) / 7 ≈ 0.099
```

So an event 7 days old counts half; 14 days, a quarter. Momentum naturally fades unless refreshed by new engagement.

## 4. Per-source diminishing returns (anti single-channel gaming)

Summing sources raw lets one gamed channel (e.g. bought Twitter likes) dominate. So we compress **each source independently** before combining, so runaway numbers on one platform hit diminishing returns:

```
source_value = Σ v_i           (over events in that source)
combined     = Σ_sources  sqrt(source_value)²-free… → see note
```

Concretely, the raw pre-compression total is:

```
R = f(on_platform) + f(facebook) + f(twitter)
```

where `f(x) = x` **but** no single source may contribute more than **50%** of `R`. Any excess above the second-largest source is halved. This caps the payoff of buying engagement on one platform without penalising a project that's genuinely strong everywhere.

## 5. Final compression & the two scores

Absolute counts vary over orders of magnitude (10 vs 10,000). We apply a **log compression** so the score is readable (roughly 0–500) and a tiny charity isn't rendered invisible next to a viral one — every 10× of real support adds a fixed ~100 points rather than multiplying the rank.

```
Support Score   S = round( 100 × log10(1 + R) )          # recency = 1
Momentum Score  M = round( 100 × log10(1 + R_decayed) )  # recency = exp(−λ·age)
```

| Real weighted support `R` | Score |
|---------------------------|-------|
| 10 | 104 |
| 100 | 200 |
| 1,000 | 300 |
| 10,000 | 400 |

## 6. Discovery ranking (US-4.2 / US-4.4)

- **"Most supported"** sort → order by `S`.
- **"Trending"** sort → order by `M`.
- **Default feed** → blended rank so both established and rising projects surface:

```
rank = 0.6 × norm(S) + 0.4 × norm(M)
```

where `norm(·)` scales each to 0–1 across the currently visible set. The 60/40 split is tunable (§8).

## 7. Ingestion, freshness & degradation (ties to US-3.5)

- **Webhooks** where a platform offers them → near-real-time updates.
- **Polling** otherwise, on a schedule (target every 15–30 min) that respects each platform's rate limits.
- **Recompute:** incrementally on ingestion, plus a full hourly recompute to apply decay to `M`.
- **Provisional vs confirmed events** (mirrors the pending/approved-hours pattern): freshly ingested engagement is *provisional* and enters at a dampened weight; it becomes *confirmed* once it survives the anomaly checks in §3.1 / §4 (e.g. after an aging window with no flag). This blunts flash-mob gaming without hiding genuine viral spikes for long.
- **On API failure:** show last-known scores with a "last updated" timestamp — never reset to zero (US-3.5 AC).

## 8. Configurable parameters (owned by product, tuned with data)

| Parameter | Draft value | Notes |
|-----------|-------------|-------|
| Action weights (§2) | table above | Calibrate against observed conversion to corporate interest. |
| `trust.base` anonymous ceiling | 0.3 | |
| Account-age threshold | 30 days | |
| Momentum half-life | 7 days | Shorter = twitchier trending. |
| Single-source cap | 50% of `R` | |
| Score compression | `100 × log10(1+R)` | |
| Blend split | 0.6 S / 0.4 M | |
| Poll cadence | 15–30 min | Bounded by platform rate limits. |
| Provisional→confirmed window | e.g. 24 h | |

## 9. Worked example

Project **"Rebuild the community garden"**, engagement to date (avg trust shown):

| Source | Events | Weight × trust | Contribution |
|--------|--------|----------------|--------------|
| On-platform | 40 likes (t≈0.7) | 40×1.0×0.7 | 28.0 |
| On-platform | 5 share-outs (t≈0.7) | 5×3.0×0.7 | 10.5 |
| Facebook | 120 reactions (t≈0.6) | 120×1.0×0.6 | 72.0 |
| Facebook | 15 comments (t≈0.6) | 15×2.0×0.6 | 18.0 |
| Facebook | 8 shares (t≈0.6) | 8×4.0×0.6 | 19.2 |
| Twitter/X | 90 likes (t≈0.6) | 90×1.0×0.6 | 54.0 |
| Twitter/X | 12 reposts (t≈0.6) | 12×4.0×0.6 | 28.8 |
| Twitter/X | 5 quotes (t≈0.6) | 5×4.0×0.6 | 12.0 |

Source totals: on-platform 38.5, Facebook 109.2, Twitter 94.8. No source exceeds 50% of the ~242.5 total, so no cap applies.

```
R = 242.5
Support Score S = round(100 × log10(1 + 242.5)) = 239
```

If most of that engagement landed in the last few days (avg decay ≈ 0.7):

```
R_decayed ≈ 170  →  Momentum Score M = round(100 × log10(171)) = 223
```

A high `S` **and** high `M` = an established project *still* accelerating — exactly what a watching corporation should be alerted to.

## 9a. Implementation status

Implemented in `src/modules/scoring` + `src/modules/engagement`: action weights (§2), per-event trust (§3.1), the **log-compressed Support Score** (§5), the **Momentum Score with 7-day-half-life decay** (§3.2), the **per-source cap** (§4 — with the refinement that a *lone* source is uncapped, so single-channel legitimate projects aren't penalised), and anti-gaming (§3.1): a **trust threshold** plus **per-actor velocity/bot-burst** dampening at confirm. All are pure, unit-tested functions.

Not yet implemented (see below): calibration, cross-platform dedup, a full `behaviour_factor` classifier, and the blended discovery rank (§6 — discovery currently sorts by S or M directly).

## 10. Open items before build

- **Calibration:** all weights/parameters are informed guesses until we can correlate them with real "engagement → corporate interest" conversion. Ship with instrumentation to A/B test them.
- **Cross-platform identity dedup:** one person liking on-platform *and* on Facebook is currently double-counted. Full identity linking is hard; best-effort dedup (matched social login) is a fast-follow, not MVP.
- **Bot classifier:** §3.1 `behaviour_factor` needs a concrete first implementation — start rules-based (age, ratio, velocity), evolve to a model.
- **Platform ToS:** confirm what engagement data FB/X APIs permit us to store and for how long — may constrain §7.
