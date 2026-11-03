# LoopGrid — Technical Track

Architecture, data flow and AI design for the LoopGrid smart waste exchange
(HackTheCircle · Sustainability & Social Impact).

Two things are described here, kept deliberately separate:

1. **What ships today** — the working demo in this repo. No model runs at
   inference time; the classifier, sensors and routing numbers are scripted.
2. **The AI track** — the exact models, data and serving path that replace the
   scripted parts, with the same UI contracts so the swap is drop-in.

Being explicit about the line between the two is the point. The demo is a
product shell with honest placeholders; the track below is how each placeholder
becomes real.

---

## 1. One-line summary

> A scan-to-marketplace loop: a phone camera classifies a waste item, a
> calibrated model returns a prediction **set** instead of a fake confidence,
> the item becomes a listing, nearby buyers and collectors are matched, a route
> optimiser plans the pickup, and both parties co-sign every handoff into an
> externally anchored carbon ledger.

---

## 2. What runs today

| Layer | Implementation | Where |
|---|---|---|
| UI | Hand-written HTML + CSS + vanilla JS, no framework | `index.html`, `assets/styles.css` |
| State | Single in-memory `state` object, reset on reload | `assets/app.js` |
| Routing | SPA page switch with push transition | `assets/app.js` |
| Classifier | Lookup table of samples, fixed confidence, 950 ms fake latency; exception path only | `SAMPLES`, `classify()` |
| Lot check | Three scripted purity/contamination presets, real source-score arithmetic, ledger append | `LOTS`, `renderLotCheck()` |
| Bins | Hard-coded fill %, positions on a stylised map | `BINS` |
| Route | Fixed permutation + "skip under 40%" filter; distance from a 4-case table | `OPT_ORDER`, `routeStats()` |
| Impact | Per-role constants, hand-authored chart series | `ROLE_DATA` |
| Ledger | 4 hard-coded rows + any lot- or voice-created row, CSV export in the browser | `LEDGER` |
| Hardware | Specs only: passive bin camera, auto-sorting bin, one lot photo | Routes card |
| Voice | Optional FastAPI gateway: ElevenLabs Flash TTS + Scribe STT, deterministic intent parser, mock mode; browser speech/text fallback | `voice_api.py`, `assets/app.js` |
| Hosting | Static files on GitHub Pages; optional Streamlit wrapper for cloud deploy | `index.html`, `streamlit_app.py` |

There is **no database and no trained model** in the current build, and nothing
is persisted. The one backend is the optional Awaaz gateway; if it is not
running, voice falls back to the browser and then to typed text. The UI labels
the lot check, classifier, sensors, routing, hardware and voice providers so the
demo never claims otherwise.

---

## 3. Current architecture

```
┌──────────────────────────────── Browser ────────────────────────────────┐
│  index.html ──► styles.css (tokens, layout, motion)                      │
│       └──► app.js                                                        │
│              ├── state { role, page, sample, listings, points, route… }   │
│              ├── SAMPLES / BINS / ROLE_DATA / LEDGER   (static data)     │
│              ├── classify()   ── 950 ms wait ──► renderScanResult()      │
│              ├── publish()    ── unshift listing ──► marketplace         │
│              ├── routeStats() ── lookup table ──► map + summary          │
│              ├── Awaaz: parser + tools + Web Speech fallback             │
│              └── exportCsv()  ── Blob + <a download>                     │
│  camera (optional) ── getUserMedia ──► <video> preview only              │
└──────────────────────────────────────────────────────────────────────────┘
        │ optional: text / 12 s audio                │
        ▼                                            ▼
  FastAPI voice gateway (voice_api.py)          Streamlit wrapper
  ElevenLabs Scribe → intent → Flash TTS        copies site → ./static,
  no raw audio stored; key stays server-side    embeds via st.iframe
```

Everything in the product demo is client-side, which is why it survives a bad
venue network. The voice gateway is optional and isolated: losing it only drops
Awaaz to browser speech, never the scan, marketplace or ledger screens.

The voice layer (§17), account plan (§18), facility sourcing (§19) and pilot
reward/pilot plan (§20–21) are documented after the main AI track.

---

## 4. Target architecture

```
┌──────────── Edge / phone ────────────┐        ┌──────────── Cloud ────────────┐
│                                      │        │                               │
│  Camera ─► frame grab                │        │  API (FastAPI)                │
│      │                               │        │   ├── /scan        (fallback) │
│      ▼                               │        │   ├── /listings                │
│  YOLOv8n detector (ONNX, int8)       │  HTTPS │   ├── /listings/:id/accept     │
│      │  crops (or "split the bag")   │ ─────► │   ├── /routes/optimise        │
│      ▼                               │        │   ├── /bins/:id/forecast      │
│  MobileNetV3-Small classifier        │        │   ├── /ledger/:id/cosign      │
│      │  logits ─► temperature ─► softmax      │   └── /impact/export          │
│      ▼                               │        │                               │
│  conformal set (90% coverage)        │        │  Postgres (listings, pickups, │
│      ├ 1 class  ─► auto-route        │        │  ledger, signatures)          │
│      ├ 2+ classes ─► ask the user    │        │  Redis (bin state, sessions)  │
│      └ ∅ / OOD ─► "needs human"      │        │  S3 (scan images, reports)    │
│                                      │        │                               │
│  EXIF strip + background blur        │        │  Workers                      │
│  IndexedDB queue when offline        │        │   ├── Merkle anchor (daily)   │
│                                      │        │   ├── fill forecast (cron)    │
│  UI renders set, user confirms       │        │   ├── fraud checks            │
└──────────────────────────────────────┘        │   └── ESG rollup (nightly)    │
                                                └──────────────▲───────────────┘
                                                               │ MQTT
                                                 ESP32 bin sensors
```

Why edge-first for vision: the image never leaves the phone, inference works
offline in a basement bin room, and latency stays under ~100 ms. The cloud path
exists only as a fallback for low-end devices and for audit.

---

## 5. The AI track

### 5.1 Scope: three models, on purpose

| Model | Job | Status |
|---|---|---|
| **Classifier** — MobileNetV3-Small | material + contamination | Week 1 |
| **Detector** — YOLOv8n (or a "split the bag" gate) | one item vs several | Week 1–2 |
| **Fill forecast** — LightGBM quantile | bin overflow before it happens | Phase 3 |

Everything else is deliberately **rule-based** until there is data to learn
from:

| Function | Until 500 transactions | Why |
|---|---|---|
| Buyer matching | radius + material + verified + recency | a ranker with no acceptance history learns noise |
| Price suggestion | published commodity band + grade multiplier | same cold-start problem |
| Routing | OR-Tools CVRP | optimisation, not ML — deterministic and auditable |
| Carbon | factor table × weight | an accounting rule, not a prediction |

Shipping six models would invite "show me the data". Shipping three and saying
*why* the others wait is the more defensible story — and it makes the roadmap
credible.

### 5.2 Vision classifier

**Model:** MobileNetV3-Small, fine-tuned, 224×224 input, 13 classes.

| Property | Value |
|---|---|
| Backbone | MobileNetV3-Small (ImageNet pretrained) |
| Params / size | ~2.5 M params · ~4.2 MB fp32 · ~1.2 MB int8 |
| Head | Global pool → dropout 0.2 → dense 13 → softmax |
| Training | 2-stage: frozen backbone (5 epochs, lr 1e-3), then full fine-tune (15 epochs, lr 1e-4) |
| Loss | Class-weighted cross-entropy (hazardous classes up-weighted) |
| Export | ONNX opset 17 → int8 dynamic quantization |
| Runtime | ONNX Runtime Web (WASM, WebGPU when available) |

**Why this model:** it is small enough to ship inside a PWA, runs at 30–80 ms per
frame on a mid-range Android, and is accurate enough for coarse material
routing. The gate below — not model size — handles the hard cases.

### 5.3 Calibration and the gate

Softmax scores are overconfident: a 0.70 output does not mean 70% correct. Two
fixes, both cheap.

**Temperature scaling.** Fit a single temperature `T` on a held-out calibration
split, divide logits by `T` before softmax. Report:

- **ECE** (expected calibration error), target < 0.05
- a **reliability diagram** in the repo (`docs/calibration.png`)
- Brier score alongside accuracy

**Conformal prediction.** Split conformal with a 90% target coverage:

1. Hold out a calibration set the model never trains on.
2. Compute nonconformity score `1 − p̂(y)` for each calibration image.
3. Take the ⌈(n+1)·0.90⌉-th smallest score as threshold `q̂`.
4. At inference, include every class whose score ≤ `q̂`.

The output is a **set**, and the UI acts on its size:

| Set size | Meaning | UI |
|---|---|---|
| 1 | model is sure | auto-route, show the class |
| 2–4 | ambiguous | show all, ask the user to pick |
| 0 or `unknown` | out-of-distribution | "needs human review", manual picker |

That is the sentence worth putting on a slide: *the model knows when it doesn't
know, with a statistical guarantee* — 90% of the time the true class is inside
the returned set, assuming exchangeability. The caveat is stated, not hidden.

**Unknown / OOD.** Two triggers: an empty conformal set, or max softmax below a
floor (0.35) after temperature scaling. Either way the item is not routed
automatically. Sanitary waste, batteries and unknown composites land here far
more often than they should land in a confident wrong bin.

### 5.4 Detection stage

A YOLOv8n detector (3.2 M params) finds boxes; each crop is resized to 224 and
classified. If more than one box exceeds the area threshold, the result becomes
"multiple items — split the bag" rather than a single material. Single-item
photos skip detection and classify the full frame.

The same detector runs on **one lot photo** taken by the collector at pickup. It
is not a per-item gate: it estimates purity and flags contamination classes for
the lot as a whole. Households only use the single-item path when they are
unsure about one object.

For Week 1 this can ship as a simpler gate: if the classifier's conformal set is
large and the image has high edge density in several regions, ask the user to
split the bag. The detector is the upgrade, not a blocker.

### 5.5 Fill-level forecasting

Sensor pings (ultrasonic distance → fill %) arrive every 15 minutes. A
LightGBM quantile model per bin, features: hour, weekday, lag 1 h / 24 h / 7 d,
rolling mean, local event flag. Output: predicted fill at +6 h / +24 h with a
P90 band.

Use: a bin predicted to cross 85% before the next scheduled pass is pulled into
today's route. Cold start: seasonal-naive baseline (same hour last week) for the
first 14 days, then switch to the model.

### 5.6 Routing

OR-Tools `RoutingModel` — capacitated VRP with time windows.

- Nodes: depot + bins above threshold + marketplace pickups.
- Demand: predicted fill × bin capacity.
- Constraints: vehicle capacity, driver shift, 10:00–17:00 window, 3-minute
  service time, one-way lanes.
- Objective: minimise distance, then maximise kg per km.
- Solver: `PATH_CHEAPEST_ARC` + `GUIDED_LOCAL_SEARCH`, 2 s budget.

This is optimisation, not machine learning. Calling it AI would be dishonest;
it is the deterministic half of the loop and it is what makes the savings
auditable.

---

## 6. Waste taxonomy

The eight-class list was too clean for Indian waste. The classes that actually
cause contamination are the ones that were missing.

| Class | Bin | Notes |
|---|---|---|
| PET | blue | bottles, food trays |
| HDPE | blue | jugs, caps, buckets |
| PP / mixed plastic | blue | containers, caps |
| Paper / cardboard | blue | OCC, newspaper, office paper |
| Glass | blue (crate) | jars, bottles |
| Metal | blue | cans, foil, utensils |
| Textile | white sack | cotton, denim, synthetics |
| Organics | green | food, garden |
| **Multilayer packaging** | **reject** | chip and biscuit wrappers — no viable recycling stream in Delhi |
| **Tetra Pak** | **special** | only specific buyers; otherwise reject |
| **Thermocol** | **reject** | fragile, no local buyer |
| **Sanitary / biomedical** | **hazardous** | never in household bins |
| **Batteries** | **hazardous** | certified handler only |

**Hazardous override.** `sanitary`, `biomedical`, `battery`, `e-waste` carry a
`hazard: true` flag. It overrides the material class in the UI and the API:

- no marketplace listing
- no points for disposal (points would incentivise unsafe handling)
- a certified-handler pickup request instead
- a hard block in the confirm endpoint, not just a UI warning

**Contamination is multi-label**, not a 2-class head: `food residue`, `wet`,
`mixed material`, `hazardous present`, `clean`. A wet cardboard box and a
greasy pizza box are different problems; one contaminates the paper stream, the
other is compostable.

---

## 7. Weight, carbon and additionality

Every CO₂e number depends on weight, and **a photo cannot give weight**. The
honest chain is:

```
photo  →  estimated weight band (±30%)   →  collector-confirmed kg (truth)
```

**Ground truth** is the collector's scale at pickup. The listing carries an
estimate; the ledger carries the confirmed weight. Points and carbon settle on
the confirmed number, so inflating the photo estimate gains nothing.

**Ranges, not points.** Every impact figure renders as a band with a factor
version, e.g. `18–26 kg CO₂e · factor v2026.10`, never a bare `22 kg`. The
factor table is versioned in the repo, so any number can be re-derived years
later.

**Additionality.** Kabadiwalas already collect most PET and cardboard. Counting
all of it as avoided emissions is greenwashing. The claim is:

```
additional_kg = kg × additional_fraction[material, locality]
co2e_band     = additional_kg × factor[material] ± uncertainty
```

`additional_fraction` is the share that would otherwise have gone to landfill or
open burning, estimated from a local baseline survey (starting values:
PET 0.35, OCC 0.25, glass 0.30, organics 0.60, textile 0.70, e-waste 0.55 —
marked as survey estimates, revised quarterly). The UI shows "additional
diversion" next to "total collected", so the two are never conflated.

**Ledger formula, per pickup:**

```
co2e_low, co2e_high = kg_confirmed × additional_fraction × (factor ± 15%)
```

---

## 8. Trust: signatures, Merkle anchor, anti-fraud

A hash chain is tamper-**evident**, not tamper-**proof**: the operator can
rewrite the whole chain from genesis. Three layers fix that.

**1. Dual signatures per handoff.** Each pickup row is signed by the collector
and countersigned by the buyer with Ed25519 keys held on their devices. The
server stores both signatures; it cannot mint a row alone. A row is valid only
with two signatures over the canonical payload.

**2. Daily Merkle root, anchored externally.** Every 24 h the server builds a
Merkle tree over that day's row hashes and publishes the root to a public git
repository plus an OpenTimestamps stamp. Anyone can recompute the root from the
exported CSV and compare. Editing history now requires rewriting a public
commit history and a timestamp — visibly.

**3. Anti-fraud checks** (server-side, on every claim):

| Check | Method | Action |
|---|---|---|
| Reused photo | perceptual hash (pHash), Hamming ≤ 6 | reject, flag account |
| Wrong place | GPS within 150 m of listed locality, time within window | hold for review |
| Weight anomaly | z-score of kg per category per collector, \|z\| > 3 | hold payout |
| Collusion | generator–collector pair frequency vs baseline, ring detection | freeze pair, manual audit |
| Velocity | > N scans/hour or > M kg/day per account | rate limit, review |

Overrides and low-confidence scans go to a **review queue** before they become
training labels, so one bad actor cannot poison the model.

---

## 9. Privacy, consent, offline

| Concern | Implementation |
|---|---|
| Consent | DPDP Act 2023 notice before the first scan: purpose, retention, withdrawal |
| Data minimisation | inference on-device; upload only on explicit "share this scan" |
| Metadata | EXIF stripped on-device before any upload |
| Bystanders | background blurred on-device (segmentation mask), not server-side |
| Retention | images 30 days, ledger rows forever (no personal data), account deletion honoured |
| Offline | scans queued in IndexedDB with a local id, synced on reconnect, idempotent by client id |
| Low-end devices | WASM fallback, 160×160 input, detection disabled, manual picker always available |

---

## 10. Data contracts

**Scan result**

```json
{
  "scan_id": "sc_01J9…",
  "material": "PET",
  "category": "Plastic",
  "prediction_set": ["PET"],
  "set_size": 1,
  "coverage": 0.90,
  "calibrated_p": 0.91,
  "contamination": ["clean"],
  "hazard": false,
  "bin": "blue",
  "grade": "A",
  "weight_est_kg": [17, 32],
  "price_band": [12, 16],
  "co2e_band_kg": [18, 26],
  "factor_version": "2026.10",
  "model": { "name": "lg-vision", "version": "0.3.1", "runtime": "onnx-web" }
}
```

**Listing**

```json
{
  "id": "LG-1042",
  "material": "PET bottles",
  "qty_est_kg": 25,
  "price_band": [12, 16],
  "locality": "Green Park",
  "seller_id": "u_88",
  "verified": true,
  "grade": "A",
  "source_score": 85,
  "status": "listed",
  "created_at": "2026-10-31T09:12:00+05:30"
}
```

**Ledger row**

```json
{
  "pickup_id": "PU-9037",
  "listing_id": "LG-1042",
  "kg_confirmed": 24.6,
  "price_per_kg": 14,
  "co2e_band_kg": [18, 26],
  "factor_version": "2026.10",
  "prev_hash": "0x81cc7d2f",
  "hash": "0x4ab9e310",
  "collector_sig": "ed25519:…",
  "buyer_sig": "ed25519:…",
  "at": "2026-10-31T11:40:00+05:30"
}
```

---

## 11. End-to-end flows

**A. Scan → listing**

```
user taps Scan
  → frame (or sample) → EXIF strip → on-device
  → detector → crops → classifier → temperature → conformal set
  → set size 1  → bin + grade + weight band + price band
    set size 2+ → user picks, choice logged to review queue
    set ∅/OOD   → manual picker, no auto-route
  → hazard? → certified pickup request, stop
  → confirm → POST /listings (optimistic UI, server id swapped in)
  → marketplace, new listing ranked first
```

**B. Buyer match**

```
listing created
  → rule-based: material + radius + verified + recency
  → top-3 notified (push + WhatsApp)
  → buyer accepts → QR issued
  → (re-ranker only after 500 accepted transactions)
```

**C. Pickup and co-sign**

```
collector scans QR → weighs → POST /accept {kg_confirmed}
  → fraud checks (pHash, GPS, weight z-score, collusion)
  → collector signs row → buyer countersigns
  → hash chained, both sigs stored
  → points and carbon settle on kg_confirmed
```

**D. Route**

```
cron 06:00 → bins forecast > 85% before next pass
  → OR-Tools CVRP (2 s) → driver app
  → 14.2 km baseline → 9.6 km optimised, 5 stops
```

**E. ESG export**

```
GET /impact/export?from=&to=&role=
  → walk ledger, verify hash chain + both signatures
  → recompute Merkle root, compare to published anchor
  → CSV: pickup, kg, factor version, co2e band, prev_hash, hash, sigs
```

---

## 12. Evaluation protocol

| Test | Protocol | Target |
|---|---|---|
| Top-1 accuracy | held-out **sites**, not images | ≥ 0.90 |
| Macro F1 | per class, rare classes weighted | ≥ 0.85 |
| Hazardous recall | battery, sanitary, e-waste | ≥ 0.95 |
| Contamination precision | multi-label | ≥ 0.80 |
| Calibration | ECE on held-out set | ≤ 0.05 |
| Conformal coverage | empirical vs nominal 0.90 | 0.88–0.92 |
| Set size | mean classes per prediction | ≤ 1.4 |
| **Hard set** | 500 wet, crushed, low-light, occluded, mixed items | report separately |
| Latency | **₹8,000 Android** (Snapdragon 4-class), p95 | ≤ 120 ms |
| Payload | model + WASM total | ≤ 6 MB |

Per-class and per-site tables go in `docs/eval.md`; a confusion matrix and the
reliability diagram go next to them. The hard set is the number judges should
ask for, because the clean benchmark flatters every model.

---

## 13. Differentiation and hooks

Existing players:

| Player | What they do | Gap LoopGrid targets |
|---|---|---|
| **Recykal** | B2B digital waste marketplace, EPR credit trading, brand compliance | supply is aggregated by large collectors; the household and kabadiwala are abstracted away |
| **Scrapuncle** | consumer scrap pickup, on-demand kabadiwala | price and pickup convenience; no source quality, no auditable chain |

Three hooks, in priority order:

**1. Co-signed handoff ledger.** Collector and buyer sign every handoff; the
daily Merkle root is published where we cannot edit it. "Nobody, including us,
can fake a carbon claim" is the line ESG buyers and brand EPR teams react to.
Recykal sells compliance; this sells *proof*.

**2. Kabadiwala-first design.** The informal sector is the actual recycling
backbone. LoopGrid gives them:

- a Hindi voice-first / WhatsApp-bot interface, not an English app
- a portable **reputation passport** built from verified, co-signed pickups
- UPI payout on QR confirmation, same day
- route and demand visibility they cannot get today

They are not a fallback in the supply chain; they are the supply chain.

**3. Source-level quality score.** Every society gets a segregation score from
its contamination history: `score = 100 − (contamination % × 1.5) −
(reject-stream % × 2.0)`, clamped 0–100, recomputed monthly from co-signed
pickups. Buyers price lots by source; generators watch their score move and lose
money when they mix. This is the behaviour loop that scanning alone does not
create — it makes clean segregation *worth* something.

Secondary hooks: **live price feedback** is already in the demo — the ₹/kg band
drops when contamination is detected, so the user sees why segregation pays.
Still on the roadmap: micro-lot pooling against recycler standing orders,
Grad-CAM on the result card, and a digital-twin slider that recomputes
km/fuel/CO₂ live.

---

## 14. Demo vs production, stated plainly

| Claim in the demo | Status |
|---|---|
| "90% set · 1 class" for PET | Scripted lookup, not a model |
| Conformal set / coverage | UI shows the real contract; numbers are scripted |
| "Bin at IIT Gate 2 is 88% full" | Hard-coded, not sensor-fed |
| "14.2 km → 9.6 km" | Modelled table, not solved |
| "₹14/kg" | Illustrative band |
| CO₂e figures | Modelled bands; factor version is a placeholder |
| Co-signed ledger / 2-of-2 signatures | UI demo: rows, signature chips and Merkle anchor are illustrative. No Ed25519 keys, no signature verification, no external commit |
| Collector passport / reputation | Demo data; no KYC, verified pickups or UPI transfer |
| Live price feedback | Hand-authored clean vs contaminated reference prices, not a market feed |
| Source quality score | Demo data, scoring rule described |
| Lot check | Real interaction; purity, contamination and score deltas are hand-authored |
| Passive bin camera / auto-sorting bin | Specified options with costs and failure modes; nothing installed |
| Camera preview | Real `getUserMedia`, classification scripted |
| Awaaz “ElevenLabs ready” | Real only when the FastAPI gateway has a key; otherwise browser speech, mock or typed fallback |
| Voice-created pickup / spoken receipt | Real browser parsing and SHA-256 of the receipt text; no Ed25519 signature, no external anchor, no audio retention |
| Streak / ₹20–₹100 reward | Rule and counter only; no money, pool or UPI rail is live |
| Facility directory | Sources and trust rules only; deliberately no invented company names |
| Accounts | One seeded demo user; no OTP, session or password storage in this build |

Nothing here claims a trained model, live sensors, signed handoffs, paying
buyers or real money movement.

---

## 15. Priorities

| When | Work |
|---|---|
| **Week 1** | Calibrated classifier (temperature + ECE), conformal gate at 90%, unknown/OOD path, expanded Indian class list with hazardous override, multi-label contamination; Awaaz plain STT/TTS APIs |
| **Week 2** | Co-signed ledger (Ed25519) + daily Merkle anchor, source-level quality score; phone-OTP auth + roles |
| **Week 3–4** | FastAPI + Postgres, real listings, QR pickup, fraud checks; facility import from CPCB/SPCB + municipal MRFs |
| **Month 2** | OR-Tools on real coordinates, sensor simulator, ElevenLabs Agents tools with signed sessions, hard-set evaluation on a ₹8,000 phone |
| **Month 3** | **One-campus pilot, 6–8 weeks** (or a 4-week variant with only the ₹20 reward), 10–20 bins, 2 kabadiwala partners |
| After 500 transactions | Matching re-ranker and price model — only then |
| Later | Micro-lot pooling, digital twin, telephony/WhatsApp voice |

---

## 16. Judge questions

**"How is this different from Recykal or Scrapuncle?"**
Recykal sells compliance to brands and abstracts the household away; Scrapuncle
sells pickup convenience. LoopGrid keeps the kabadiwala as a first-class user,
co-signs every handoff so a carbon claim can be verified by a third party, and
prices lots by source quality — which changes behaviour upstream instead of
just moving waste downstream.

**"How do you know the model works on real Delhi waste?"**
Site-split evaluation (no counter in both train and test), a 500-image hard set
of wet/crushed/low-light/mixed items, per-class recall with hazardous recall
≥ 0.95, and a calibration curve with ECE ≤ 0.05. Until those pass, the app
keeps the scripted fallback.

**"What stops people gaming the points?"**
pHash duplicate detection, GPS/time validation, per-collector weight z-scores,
collusion detection on generator–collector pairs, and settlement on the
collector-confirmed weight rather than the photo estimate. Overrides go through
review before they become labels.

**"Is the carbon number real?"**
It is a range with a cited factor version, computed only on **additional**
diversion over the existing kabadiwala baseline, settled on weighed kg. We
publish the factor table and the Merkle root so the number can be checked, and
we state the uncertainty instead of hiding it.

**"Why only three models?"**
Because a matching ranker and a price model with no transaction history learn
noise. They are rule-based until 500 accepted pickups, and we say so. Three
models we can evaluate beats six we cannot.

**"What breaks at scale?"**
Buyer liquidity per locality, sensor battery life, and label drift as packaging
changes. Mitigations: seeded buyer pools per pincode, 6-month battery budget at
15-minute pings, quarterly relabelling from reviewed overrides.

---

## 17. Awaaz — the voice layer

Awaaz is a **layer**, not a second brain. Speech becomes text, text becomes a
structured tool call, and LoopGrid's existing rules decide what is allowed to
happen. The voice model can describe a decision; it cannot make one.

```
┌─ phone ──────────────────────────────┐      ┌─ FastAPI gateway ──────────────┐
│ push-to-talk (12 s cap)              │      │ POST /api/voice/stt            │
│  └ MediaRecorder ── audio ───────────┼─────►│  └ ElevenLabs Scribe           │
│                                      │      │      → transcript, audio gone  │
│ typed text (always available) ───────┼─────►│ POST /api/voice/intent         │
│                                      │      │  └ deterministic slots/tools   │
│ caption + result card ◄──────────────┼──────┤      → reply text              │
│  └ <audio> ◄── cached mp3 ───────────┼──────┤ POST /api/voice/tts (Flash)    │
│  └ SpeechSynthesis fallback          │      │  └ key stays server-side       │
│  └ text-only fallback                │      └────────────────────────────────┘
└──────────────────────────────────────┘
```

### 17.1 Integration levels

1. **Plain APIs (built).** Scribe for STT, Flash v2.5 for TTS, typed fallback.
   The gateway exposes `/stt`, `/tts`, `/intent`, `/health`.
2. **ElevenLabs Agents (next).** The agent gets only these tools:
   `create_listing`, `get_matches`, `get_status`, `confirm_pickup`,
   `explain_item`. Sessions are short-lived and signed by our backend; the agent
   never receives a database credential. The tool result is rendered as a card,
   so the user can see what was actually executed.
3. **Telephony / WhatsApp voice (later).** The same gateway sits behind a
   number; the receipt can be sent as text after the call. This is the route for
   feature-phone users, and it is why the parser is deterministic rather than
   prompt-only.

### 17.2 Why the parser is rule-based

The safety path cannot depend on an LLM improvising. `voice_api.py` extracts
material, quantity, locality and time with explicit aliases, number words and
regexes, and returns the same `{intent, confidence, slots, tools, reply}` shape
as the browser parser. Examples:

| Utterance | Intent | Result |
|---|---|---|
| “Kal subah 6 baje Sector 12 se 40 kilo PET” | `create_listing` | 40 kg PET, Sector 12, tomorrow 06:00, ₹19–25/kg |
| “Mera pickup LG-1043 kahan hai?” | `get_status` | reads the co-signed timeline |
| “Haan” (with a pending pickup) | `confirm_pickup` | co-signs the handoff |
| “E-waste kaise sort karein?” | `explain_item` | hazardous route, no listing |
| “Haan” (nothing pending) | `clarify` at 0.40 | asks for material + weight |

Word-boundary matching matters: “Hauz Khas” must not be read as “haan”. The
confirm vocabulary is token-matched, not substring-matched.

### 17.3 Gates that stay in our code

- **Confidence gate.** Below 0.70 the UI shows the transcript, the low-confidence
  warning and **no create/confirm button**. The API returns `clarify`, not a
  guess.
- **Hazardous override.** E-waste, batteries and sanitary waste never become a
  marketplace listing and never earn points. The voice layer can say “certified
  handler”; only the rule engine can route it.
- **Consent.** The mic is disabled until the DPDP checkbox is ticked. Typed text
  is labelled as the no-audio path.
- **No raw audio storage.** The gateway reads the upload, forwards it to Scribe,
  and returns the transcript. It does not write the audio to disk.
- **Spoken receipt.** On confirmation we hash the **receipt text** with SHA-256,
  show the hash, and add the row to the ledger as *queued for the next daily
  anchor*. The audio is not hashed, because the audio is not the record. The
  root is not rewritten retroactively.

### 17.4 Fallback chain

```
ElevenLabs gateway ──► browser SpeechRecognition / SpeechSynthesis ──► typed text
        │                         │                                      │
   status chip:             status chip:                          reply caption
   "ElevenLabs ready"       "Browser voice"                       always present
```

The chip is not decoration: it states which provider is actually answering.
`VOICE_MOCK=1` is a separate state (“Mock voice API”) and returns a tone plus a
canned transcript, so the contract can be tested without spending credits.
`GET /api/voice/health` drives the probe; a missing key, an offline gateway and
a mock server are three different labels.

### 17.5 Cost, latency and caching

| Control | Implementation |
|---|---|
| Repeated prompts | cache key = hash(text + voice + model + language); identical smart-bin warnings are paid once |
| Short replies | `eleven_flash_v2_5` |
| Narration | `eleven_multilingual_v2` only for the monthly story |
| Session length | push-to-talk, 12 s cap, no always-on listening |
| Daily spend | `VOICE_DAILY_CHAR_CAP` → `429` with a browser-fallback message |
| Abuse | per-IP rate limit (20/min TTS, 12/min STT, 40/min intent) |
| Privacy | audio not persisted; cache holds synthesized output only |

For the pilot, move the in-process counters to Redis and add a per-account
budget. Latency should be reported p50/p95 on a ₹8,000 phone, including the
network round-trip, not just the model call.

### 17.6 Accessibility

- First-screen language choice: हिन्दी / Hinglish / English.
- Every spoken line has an on-screen caption: the result reply, coach line, bin
  voice and monthly story all write their text before speaking.
- Large mic target, visible pressed state, no colour-only status.
- Push-to-talk instead of wake-word, so the app does not listen continuously.
- Test with noisy markets and accented Hindi; report WER and task completion,
  not just “it worked in a quiet room”.

### 17.7 Demo vs production

| Claim | Status |
|---|---|
| “ElevenLabs ready” | Real only if the gateway has a key; otherwise labelled browser/mock |
| STT / TTS | Real API path exists; no key was available for this build, so only mock/browser paths were exercised |
| Intent parsing | Deterministic rules; not a trained NLU model |
| Spoken receipt hash | Real SHA-256 of the text in the browser; not signed, not externally anchored |
| “Transcript only” | True of the gateway code: it does not write audio; production must enforce retention server-side |
| Telephony / WhatsApp | Not built |

Voice metrics for the pilot: WER on a noisy/accented Hindi test set, intent
accuracy, slot F1 for material/weight, task completion without typing, p95
latency, and cost per completed pickup.

---

## 18. Accounts and authentication

The demo runs as one seeded user (**Ananya R.**). No OTP is sent and no session
is created. Production auth is specified here so the demo does not pretend to
have it.

### 18.1 Methods

- **Phone + OTP primary.** Many users do not use email; the phone is also the
  collector's identity.
- **Google sign-in optional.**
- **Logout** clears the refresh token and local session on the device.
- **Forgot password via OTP.** If phone OTP is the only factor, no password is
  needed. If a password is added: phone → OTP → verify → set new password →
  revoke all old sessions.

### 18.2 Fields

| Required | Optional |
|---|---|
| Name | Email |
| Phone | Language (Hindi/English) |
| Role: household / society admin / collector / buyer | Profile photo |
| Address: flat/house, locality, city, pincode | Map pin (with permission) |
| DPDP consent checkbox | |

Role controls what the app shows: a household never sees buyer pricing logic, a
collector sees routes and weight entry, a buyer sees lots and source scores.

### 18.3 OTP and session rules

- 6 digits, expires in 5 minutes.
- 3–5 attempts, then a cooldown.
- Resend cooldown 30–60 s.
- Rate-limit by phone **and** by IP.
- Store passwords only as bcrypt/argon2 hashes; never plain text.
- Short-lived access token (minutes) + rotating refresh token; revoke on logout.
- SMS in India needs **DLT registration**. Firebase Authentication or Supabase
  Auth can provide phone OTP + Google sign-in without building the SMS path;
  either is acceptable for the pilot.
- Consent receipts (version, timestamp, purpose) are stored; account deletion
  removes personal data and keeps only non-personal ledger hashes.

### 18.4 Why the demo does not fake it

A fake OTP box that accepts any code teaches judges the wrong thing and creates a
security anti-pattern. The demo therefore says “single seeded account” and keeps
the auth work in this section plus the roadmap.

---

## 19. Facility directory — never invent a company

The AI may extract, normalise and rank facility records. It may **not** create a
facility. Every record carries a source and a `last_verified` date.

### 19.1 Sources, in trust order

1. **Official lists:** CPCB / State Pollution Control Board authorised recyclers
   and EPR portal registrations.
2. **Municipal records:** local-body MRF, dry-waste collection centre and
   processing-plant lists (e.g. DPCC/MCD in Delhi).
3. **Map data:** Google Places or OpenStreetMap for scrap dealers near the user.

### 19.2 Where AI helps

- Extract names, addresses, contact details and accepted waste types from PDFs
  and tables.
- Normalise duplicates (“M/s …”, abbreviations, transliterations).
- Map a user's material to facility categories: plastic, paper, e-waste, wet,
  hazardous.
- Rank by distance, accepted material, capacity and verification status.

### 19.3 Trust labels

| Label | Rule |
|---|---|
| **Verified** | Appears in an official CPCB/SPCB/municipal list; show source + last verified date |
| **Unverified — call before going** | Map-only result; never presented as a partner |
| **Reported closed / wrong** | User report; hidden pending re-check |
| **Not connected** | Demo state: the directory card names sources, not companies |

The demo intentionally shows **zero facility names**. It shows the sources and
the rule, because inventing “Okhla Green Recyclers Pvt Ltd” would be the one
thing the brief explicitly forbids.

---

## 20. Pilot reward: verified-handoff streak

This is a **pilot reward**, not guaranteed income. It counts verified handoffs,
not app opens.

| Month | Condition | Payout for that month |
|---|---|---|
| 1 | ≥ 4 verified handoffs + quality pass | ₹20 |
| 2 consecutive | Same condition | ₹60 |
| 3 consecutive | Same condition | ₹100 |

The amounts are **each month's payout**, not a bonus stacked on the previous
one. Three months cost **₹180 per user**, which must be checked against the
pilot budget before it is promised.

### 20.1 Anti-fraud

- Only **one verified handoff per day** counts.
- The **receiver must confirm** weight and material; a generator-only tap does
  not count.
- Flag same generator–collector pairs spiking, impossible weights, reused photos
  (pHash), GPS/time mismatches and collusion patterns.
- Flagged rows do not count toward the streak and go to review.
- Settlement uses the collector-confirmed weight, not the photo estimate.

### 20.2 Grace and payout

- **One grace week:** a single missed week does not wipe progress; a longer gap
  resets the streak.
- Start with **points or vouchers**. Real-money UPI later goes through a licensed
  payment partner, not a wallet we operate (RBI rules).
- Set a **monthly reward pool**; if it runs out, pay proportionally.
- Wording in the UI and deck: *pilot reward, capped pool, not guaranteed income.*

The demo shows the rule and a counter. No money moves, no pool is live and no
UPI transfer is initiated.

---

## 21. Pilot plan and the 30-second demo

### 21.1 Pilot

- **6–8 weeks, one campus** (a college or a large society), not all of Delhi.
- Why that length: a monthly reward needs at least a month of activity, and the
  two-month streak needs two; voice accuracy, contamination and fraud attempts
  need repeated handoffs. A few days gives too little data.
- **4-week variant:** drop the 2- and 3-month streaks and test only the ₹20
  month. Less data, lower cost.
- Metrics: handoffs/week, contamination rate by source, voice task completion
  and WER, p95 latency on a ₹8,000 phone, fraud flags per 100 handoffs, reward
  cost per retained user, kg diverted and CO₂e range with factor version.
- The pilot is where the scripted classifier, sensors and signatures get
  replaced; the demo does not wait for that to be presentable.

### 21.2 Demo (competition, ~30 seconds for the core loop)

1. Collector says **“40 kilo PET, haan”**.
2. The manager taps **confirm**.
3. The ledger row appears with both signatures.
4. The receipt is spoken and its **text hash** is shown.
5. The streak counter moves from 3/4 to 4/4, with the rule visible.

No pilot is required for this demo. The 6–8 weeks is the real-world test, not
the length of the handoff.

---

## 22. Verification model: exception scanning, lot checks, passive bins

The first version of the product implied that every family must scan every item
before throwing it away. That is not a product; it is a chore. It also produces
bad data, because the people who scan most carefully are not the people who
handle the material.

The corrected model puts verification where the material actually changes hands.

### 22.1 The routine path

1. A household keeps the normal wet/dry split. No camera, no app, no per-item
   decision.
2. The bag or bin arrives at the collection point.
3. The collector or society manager takes **one photo of the lot** and enters
   the collector-confirmed weight.
4. The check returns purity, contamination classes and a decision:
   - **Accept** → list the lot;
   - **Accept with deduction** → list, but the price band reflects the
     contamination;
   - **Reject** → re-sort before listing;
   - **Hazard found** → isolate, certified handler, no points.
5. The buyer's acceptance or rejection at the gate is the ground truth.
6. The source score updates from lot checks and buyer acceptance, not from app
   usage.

This is the flow the demo now shows first on **Sort & verify → Verify a lot**.

### 22.2 The exception path

The single-item scanner remains, but only for the cases where it earns its
place: a battery, an unfamiliar wrapper, a dirty tub, a material the household
has not seen before. The UI labels it **Exception scanner · optional** and says
plainly that routine bags do not need it.

The scanner still carries the full contract: conformal set, hazardous override,
unknown/OOD path, price feedback. It is just no longer the front door.

### 22.3 Sampling and ground truth

- **Random spot-checks** at pickup, not exhaustive checks.
- **Buyer acceptance** is the label that settles the source score.
- A rejected lot is not silently discarded; it is re-sorted and re-checked.
- Overrides (a user picking a class from a multi-class set) go to a review queue.
- Metrics that matter: lot checks per pickup, contamination caught before the
  buyer, buyer rejection rate, and **scans per household per week** — which
  should trend toward zero.

### 22.4 Passive cameras

An optional ESP32-CAM on a shared society bin can watch the opening and raise an
alert only when the lot looks wrong. It requires no user action. It is not a
replacement for the lot check: it is an early-warning signal, and it has real
costs — power, mounting, privacy, false alerts and maintenance.

Recommendation: one or two shared bins in the pilot, not every household bin.

### 22.5 Automatic sorting bins

Automatic sorting bins exist commercially and are buildable by a student team.
A minimal prototype:

- **Brain:** Raspberry Pi, or ESP32-CAM for a simpler version.
- **Vision:** a small MobileNet / TensorFlow Lite classifier for plastic, paper,
  glass, metal and reject.
- **Sensors:** inductive proximity for metal, capacitive/moisture for wet waste,
  load cell for weight. Metal and wet are far more reliable with sensors than
  with the camera alone.
- **Mechanism:** one servo-driven flap or a rotating tray over 3–4 containers.
- **Fill:** one ultrasonic sensor per container.
- **Cost:** roughly ₹3,000–6,000 for a prototype, before enclosure and
  maintenance.

Honest limits:

- Accuracy drops on wet, crushed, dirty and nested items.
- Moving parts jam; a bin that jams is worse than a bin that does not sort.
- Hazardous items must go to a separate **locked reject** container.
- A low-confidence item must go to an **“unsure”** container for human review,
  not be forced into a class.
- It costs more than a normal bin, so it suits **shared points** — campus,
  mall, society gate, office — not every household.
- It improves purity but does not remove the need for a lot check, because a
  misclassified item still has to be caught before it reaches a buyer.

Recommendation: ship the **lot photo first** because it needs no hardware and
works on any phone. Add a passive camera to shared bins in the pilot. Treat the
auto-sorting bin as a later campus/mall pilot, not the core product.

### 22.6 What this changes in the pitch

| Old phrasing | New phrasing |
|---|---|
| “A user scans an item before throwing it away.” | “Households sort as usual; the collector verifies each lot with one photo.” |
| “Camera-first segregation for every item.” | “Exception-only scanning, plus a lot-level check at pickup.” |
| “The classifier tells every family what to do.” | “The classifier helps when someone is unsure; the buyer acceptance is the truth.” |
| “We need a smart bin in every home.” | “Passive cameras on shared bins; auto-sorting bins only where volume justifies them.” |

The quality score is stronger under the new model, because it is built from real
acceptance data instead of user effort.

### 22.7 Demo vs production

| Claim | Status |
|---|---|
| Lot check UI | Real interaction; purity, contamination and score deltas are hand-authored demo values |
| Exception scanner | Scripted 13-item classifier; same UI contract as the planned model |
| Passive camera | Specified option; nothing installed |
| Auto-sorting bin | Specified option with cost and failure modes; no prototype in this build |
| Buyer acceptance as ground truth | Product rule; no live buyer in the demo |
| Source score update | Real arithmetic on demo inputs; not a live market feed |
