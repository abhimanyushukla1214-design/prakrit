# LoopGrid — pitch script and slide wording

This is the judge-facing version of the corrected model: **nobody scans every
item**. The routine check happens at the lot level, at pickup. The scanner is an
exception tool.

Use this with the live demo, not as a replacement for it.

---

## 1. The 30-second version

> Delhi throws away 11,000 tonnes a day. Most of it still has value, but it is
> destroyed before a buyer ever sees it: one wet bag contaminates a whole sack
> of paper, and the kabadiwala who could have sold it never gets the call.
>
> LoopGrid is the exchange layer. Households sort as they already do. At pickup,
> the collector takes **one photo of the lot** — not every item — and we check
> purity and contamination in seconds. A clean lot is listed to a verified
> buyer; a dirty one is rejected and re-sorted before it costs anyone money.
> The buyer's acceptance becomes a source-level quality score, and every handoff
> is co-signed into a carbon ledger.
>
> No new habit for the family. No item-by-item scanning. One photo at the point
> where the material already changes hands.

---

## 2. The 3-minute script

### 0:00–0:25 — The problem is connection, not intention

> People already want to sort. The failure is at the last metre: a yoghurt tub
> at 7am, a wet corner in a cardboard bundle, a battery in the dry bin. One
> mistake contaminates the load, the buyer rejects it, and the value is gone.
>
> At the same time, the kabadiwala who runs this economy works on phone calls
> and memory — no price transparency, no route, no proof of what he collected.

### 0:25–1:05 — The correction: verification at the lot, not the item

> We deliberately do **not** ask every family to scan every item. That would be
> a chore, and nobody would do it.
>
> The household keeps the normal wet/dry split. The collector takes **one photo
> of the bag or bin** at pickup. The check returns purity, contamination classes
> and a decision: accept, accept with a price deduction, reject and re-sort, or
> isolate a hazard. The buyer's acceptance is the ground truth.
>
> The single-item scanner exists only for the exception: a battery, a wrapper,
> a dirty tub. It is an “I’m not sure” helper, not a daily ritual.

**Demo beat:** open **Sort & verify → Verify a lot → Clean dry lot**. Point at
96% purity, 2% contamination, source score 85 → 87. First, for the clean lot: **Accept · list to buyer**. That creates the buyer chain — the clean lot becomes a listing with 3 verified buyers, and the chain is live. Then **Mixed bag** → 71%
purity, reject and re-sort. Say: “This is one photo, not a hundred scans.”

### 1:05–1:35 — The loop

> A clean lot becomes a listing. Nearby verified buyers and collectors are
> ranked. The collector gets a route that skips bins under 40% — 14.2 km becomes
> 9.6 km in the model. The buyer confirms weight and material at the gate.
> That event is the fact we settle on.
>
> The family sees the bin, the price band and the points. The collector sees a
> route and a passport. The society sees a source score. The buyer sees
> contamination before bidding. One loop, four users.

**Demo beat:** Marketplace listing → accept pickup. Routes → optimise. Point at
the collector passport on Overview.

### 1:35–2:10 — Why the data is defensible

> Every handoff is co-signed by both sides. The carbon number is a range, with a
> factor version, counted only on **additional** diversion — not on total
> collected kilos. A daily Merkle root is anchored externally, so neither the
> buyer nor LoopGrid can rewrite a row alone.
>
> The source score is the differentiator: `100 − contamination × 1.5 − reject
> stream × 2.0`. It prices the **source**, not just the material, so a society
> that mixes waste sees its resale price fall. And it is built from lot checks
> and buyer acceptance — not from how often someone opened the camera.

**Demo beat:** Impact → source quality score → ledger → verify anchor. Switch
Household / Society / Business. Export CSV.

### 2:10–2:40 — The voice layer, for the people who actually handle the waste

> The informal sector runs on phone calls and voice notes. So Awaaz turns
> Hindi, Hinglish or English speech into a structured pickup: “Kal Sector 12 se
> 40 kilo PET.” No camera, no typing.
>
> The model can describe a decision; it cannot make one. Confidence below 70%
> creates nothing. Hazardous waste never becomes a listing, even if the voice
> mishears. Every spoken line has a caption, and the spoken receipt hashes the
> receipt **text** into the ledger — the audio is never stored.

**Demo beat:** Awaaz → sample pill → Create pickup → Co-sign. Show the receipt
hash and the **next anchor** chip. Keep it short.

### 2:40–3:00 — The pilot and the honest ask

> The pilot is 6–8 weeks on one campus, not all of Delhi. We measure handoffs per
> week, contamination caught before the buyer, voice task completion on a
> ₹8,000 phone, and fraud flags per 100 handoffs. The reward is a capped pilot
> pool — ₹20, ₹60, ₹100 across three months — not guaranteed income.
>
> The demo is a working product shell with honest placeholders: the classifier,
> sensors and signatures are simulated. The next step is to replace them on one
> campus, with one kabadiwala partner, and prove the loop.

---

## 3. Slide wording

### Slide 4 — “The loop” (old → new)

| Old | New |
|---|---|
| “User scans every item before throwing it away.” | “Households sort as usual. The collector verifies each lot with one photo at pickup.” |
| “AI identifies each item.” | “AI checks lot purity and contamination; the buyer's acceptance is the ground truth.” |
| “Camera-first segregation.” | “Exception-only scanning, plus a lot-level check.” |
| “Six steps from bin to buyer.” | Keep the six steps, but put **verify the lot** at step 2, not **scan the item**. |

Suggested step labels:

1. Generate material
2. **Verify the lot** — one photo, purity + contamination
3. Match a verified buyer
4. Collect on an optimised route
5. Buyer accepts — weight + QR proof
6. Impact ledger — co-signed, auditable

### Slide 5 — “Product” or “How it works”

Use three columns:

| Household | Collector / society | Buyer / recycler |
|---|---|---|
| Sorts wet/dry as usual | One lot photo at pickup | Sees source score before bidding |
| Scans only when unsure | Confirmed weight + route | Accepts or rejects at the gate |
| Points, pickups, streak | Passport, UPI settlement | Traceable intake, ESG proof |

Add one line under the columns:

> **No item-by-item scanning.** The routine check is one lot photo at the point
> where the material changes hands.

### Slide 6 — “Hardware, optional” (if you show it)

> **Lot photo** — no hardware, works on any phone. **Default.**
>
> **Passive bin camera** — one ESP32-CAM on a shared bin; alerts only on a
> mismatch; ₹1,500–2,500; privacy, power and false alerts are real costs.
>
> **Auto-sorting bin** — camera + inductive, moisture and load sensors; servo
> flap; 3–4 containers; ₹3,000–6,000 prototype. Shared locations only. Jams,
> wet/crushed errors and maintenance are the failure modes. Low-confidence items
> go to an “unsure” container; hazardous waste to a locked reject bin.
>
> **We do not put a smart bin in every home.** We verify the lot first, then add
> hardware only where volume justifies it.

---

## 4. Q&A answers

**“Doesn’t every family have to scan every item?”**
> No. Households never scan routine waste. They keep the normal wet/dry split.
> The collector verifies each lot with one photo at pickup, and the buyer's
> acceptance is the ground truth. The single-item scanner is an exception helper
> for a battery, a wrapper or a dirty tub.

**“Why would a collector take the photo?”**
> Because it protects his payment. A clean lot is accepted faster and at a
> better price; a rejected lot is documented before it becomes his problem. The
> passport and the co-signed handoff are his proof. The photo is one tap, not a
> new workflow.

**“Is the automatic sorting bin real?”**
> Yes, commercial units exist and a student team can build a prototype for
> roughly ₹3,000–6,000. But it is not the core product. It suits shared
> points — campus, mall, society gate — where volume justifies maintenance. It
> still needs a lot check, because a misclassified item has to be caught before
> a buyer sees it.

**“What if the lot photo is wrong?”**
> The buyer's accept/reject is the final label. A rejected lot is re-sorted and
> re-checked. Low-confidence items go to human review, not into a forced class.
> The source score is recalculated from those outcomes.

**“What stops people gaming the points?”**
> One verified handoff per day counts, the receiver confirms weight and material,
> and the system flags same-pair spikes, impossible weights, reused photos
> (pHash), GPS/time mismatches and collusion. Flagged rows do not count.

**“What is actually built?”**
> A working static product with a lot-check flow, an exception scanner, a
> marketplace, routing, an impact ledger, and a voice layer with a real FastAPI
> gateway. The classifier, sensors, signatures and hardware are simulated and
> labelled. No trained model is claimed.

**“Why voice?”**
> Because the people who handle most of Delhi's waste use voice notes and phone
> calls, not forms. Awaaz lists a pickup by speech, reads a receipt, and coaches
> segregation in Hindi or Hinglish. It is wired to the ledger and routing tools,
> not a chatbot.

---

## 5. Do not say

- “Every family scans every item.”
- “The AI sorts everything automatically.”
- “We have a trained classifier.” (Say: the demo is scripted; the model plan is specified.)
- “The ledger is cryptographically verified.” (Say: the UI demonstrates the contract; signatures and anchor are illustrative.)
- “We pay users ₹180.” (Say: a capped pilot reward of ₹20/₹60/₹100 per month, points or vouchers first.)
- “We have a facility network.” (Say: official-list sourcing is specified; no company is invented in the demo.)
- “The auto-sorting bin is deployed.” (Say: it is a specified option for shared locations, not built here.)
