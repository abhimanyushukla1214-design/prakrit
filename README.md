# LoopGrid

A working front-end for the LoopGrid smart waste exchange — built for the **HackTheCircle · Sustainability & Social Impact** track.

> Delhi's waste isn't worthless. It's just in the wrong place.

The site has three parts: a marketing/overview page, a fully interactive product demo (household, society and business views), and **Awaaz**, a voice layer that turns Hindi/Hinglish/English speech into structured pickups and ledger rows.

**Live demo:** <https://abhimanyushukla1214-design.github.io/PRAKRIT-YANTRA/>

GitHub Pages serves only static files. Awaaz therefore uses browser speech by default there; to use ElevenLabs, deploy `voice_api.py` separately and paste its HTTPS URL into **Awaaz → Voice API settings**.

For the architecture, the AI track and the honest demo-vs-production split, read [`ARCHITECTURE.md`](ARCHITECTURE.md).

For the corrected pitch — exception-only scanning, lot checks, optional hardware, slide wording and Q&A — read [`PITCH.md`](PITCH.md).

---

## Run it

No build step, no dependencies.

**Option 1 — just open it**

Double-click `index.html`. Everything works from the file system.

**Option 2 — local server (recommended for camera permission)**

```powershell
# from this folder
python -m http.server 5173
# then open http://localhost:5173
```

Camera access requires `localhost` or HTTPS in most browsers. The demo works without a camera — use the 13 sample items.

**Option 3 — Streamlit**

```powershell
pip install -r requirements.txt
streamlit run streamlit_app.py
# then open http://localhost:8501
```

If `streamlit` isn't on your `PATH` (common on Windows when pip installs into
`%APPDATA%\Python\...\Scripts`), use `python -m streamlit run streamlit_app.py`.

Streamlit cannot render a static site natively, so `streamlit_app.py` keeps this
site as-is and frames it full-viewport:

- it copies `index.html` + `assets/` into `./static`, which Streamlit serves at
  `/app/static/...` (needs `server.enableStaticServing`, already set in
  `.streamlit/config.toml`);
- it hides Streamlit's header, toolbar and padding, then embeds the page with
  `st.iframe`. Streamlit sandboxes that frame with scripts, same-origin and
  downloads allowed, and grants camera access, so the scan flow, the QR modal
  and the CSV export all keep working.

`st.iframe` is why `requirements.txt` asks for Streamlit 1.66 or newer.

The HTML/CSS/JS remain the single source of truth — edit them at the repo root
and restart Streamlit. `static/` is generated and git-ignored.

**Deploy to Streamlit Community Cloud**

1. Push this folder to a GitHub repo.
2. Go to [share.streamlit.io](https://share.streamlit.io) → **New app**.
3. Pick the repo, branch `main`, main file `streamlit_app.py`.
4. Deploy. The HTTPS URL gives the demo a real secure context, so the camera
   preview works there too.

No secrets or API keys are needed.

---

## Run the Awaaz voice layer (optional)

The site works with no backend: Awaaz falls back to the browser's
`SpeechRecognition` / `SpeechSynthesis`, then to typed text. To use ElevenLabs,
run the small FastAPI gateway that keeps the key server-side:

```powershell
# 1. Install the gateway dependencies (separate from Streamlit's)
pip install -r requirements-voice.txt

# 2. Put the key in the server environment, never in index.html/app.js
$env:ELEVENLABS_API_KEY = "your-key"
# Optional free contract test: returns a tone + canned transcript, spends nothing
# $env:VOICE_MOCK = "1"

# 3. Start the gateway
uvicorn voice_api:app --reload --port 8000
```

Then open **Awaaz → Voice API settings**, enter `http://localhost:8000`, and
press **Test**. The chip turns green when the gateway reports a key. Without a
key the chip says *Server key missing* and the browser fallback stays active.

| Endpoint | Contract |
|---|---|
| `POST /api/voice/tts` | `{text, lang, quality}` → cached `audio/mpeg`; `quality: "high"` only for narration |
| `POST /api/voice/stt` | multipart `audio`, `lang` → `{text, language, provider}`; audio is not stored |
| `POST /api/voice/intent` | `{text, lang, pending_task}` → `{intent, confidence, slots, tools, reply}` |
| `GET /api/voice/health` | capability probe used by the fallback chain |

The gateway is deliberately dumb: it transcribes, speaks and parses intent. The
confidence gate, hazardous routing, pricing and ledger rules stay in
LoopGrid's own code. `voice_api.py` mirrors the browser parser so the typed and
server paths return the same shape.

Cost controls: identical text + voice + model + language is cached once, short
prompts use Flash, push-to-talk caps a clip at 12 s, and `VOICE_DAILY_CHAR_CAP`
returns `429` instead of silently overspending. Cached repeats do not count.

**Privacy:** the microphone is push-to-talk, requires the DPDP consent box, and
raw audio is discarded after transcription. Only the transcript fields needed
for the request are kept. The spoken receipt hashes the **receipt text**, not the
audio.

---

## What's inside

| Route | What it does |
|---|---|
| Overview (`#landing`) | Pitch, problem chain, six-step loop, B2C/B2B/ops layers, modelled impact, pricing |
| Overview | Dashboard with carbon ring, green points wallet, bin fill sensors, activity, onboarding checklist, verified collector passport (kabadiwala-first) |
| Sort & verify | **Routine path:** one lot photo at pickup checks purity/contamination, updates the source score and logs the handoff. **Exception path:** a simulated 13-item scanner with a 90% conformal set, hazardous override, unknown/OOD path and live price feedback — used only when one item is ambiguous |
| Marketplace | Filterable listings, search, verified toggle, save/shortlist, listing detail modal with QR + hash timeline |
| Routes & bins | Stylised South Delhi map, fill levels, route optimiser, skip-under-40% toggle, overflow prediction, optional hardware options (passive bin camera / auto-sorting bin / lot photo) |
| Impact | Role-based metrics, monthly diversion chart, material donut, source-level quality score, society leaderboard, co-signed ledger with Merkle anchor, CSV export |
| Awaaz | Push-to-talk Hindi/Hinglish/English, consent gate, structured pickup draft, confidence gate, spoken receipt hashed to the ledger, segregation coach, cached smart-bin voices, language switch, API settings + fallback chain |

### Why nobody scans every item

Scanning every item before throwing it away is a product-killer. The demo therefore puts the routine check at the **lot level**:

1. A household keeps the normal wet/dry split and drops the bag at the collection point.
2. The collector or society manager takes **one photo of the bag or bin** at pickup.
3. The check returns purity, contamination classes and a decision: accept, accept with a price deduction, or reject and re-sort.
4. The buyer's acceptance is the ground truth. No per-item effort is required from the family.
5. A single-item scan is an **exception helper** — a battery, a wrapper, a dirty tub — not a daily ritual.

This is also better for the quality score: it is built from real lot checks and buyer acceptance, not from how often a user opened the camera.

**Demo script for judges (≈90 seconds)**

1. Landing → **Open live demo**.
2. **Sort & verify** → **Verify a lot** → *Clean dry lot*. Show **96% purity**, 2% contamination, source score **85 → 87**, then **Accept · list to buyer** — the clean lot becomes a listing with 3 verified buyers (buyer chain created). Then *Mixed bag* → **Reject · resort** at 71% purity. This is the routine path: one photo, no item scanning, and for sorted material no scan at all.
3. Scroll to **Exception scanner** → choose *PET bottle* → **Classify item**. The card shows a **90% conformal set with one class**, so it auto-routes. → **Confirm & list**. You land in **Marketplace** with the new listing at the top.
4. Open a listing → show QR, status timeline, **Accept pickup**.
5. Back on **Sort & verify**, open *Hard cases* → **Food scraps** to show the **live price feedback** (clean ₹6/kg vs ₹4/kg for wet + food residue). Then **Battery** → **Request certified pickup** (no points, no listing), and **Unknown** → **Needs review** (empty set, no auto-route).
6. **Routes & bins** → **Optimise route** → 14.2 km → 9.6 km, 3 low bins skipped → scroll to **Hardware, optional** (passive bin camera, auto-sorting bin, lot photo) and the facility sourcing card.
7. **Overview** → point at Rafiq Khan's **collector passport** (reputation from co-signed pickups, UPI payout, Hindi/WhatsApp channels).
8. **Impact** → point at the **source quality score** (lot checks + buyer acceptance → score/100) → scroll to the **co-signed ledger** → **Verify anchor** (Merkle root vs public commit) → switch Household / Society / Business → **Export ESG report**.
9. **Awaaz** → tick consent → tap the **“40 kg PET · kal 6 baje”** pill. The result shows the parsed slots, confidence, and the tools that would run. → **Create pickup** → **Co-sign & ledger it**. The spoken receipt appears with a SHA-256 of the receipt **text**, and the new ledger row is marked **next anchor** — it is not folded into today's root.
10. **Awaaz** → switch to English → **Segregation coach → E-waste → Sunnein**; tap a **smart-bin voice**; show that the caption is always on screen.
11. Optional: topbar role switch, **Redeem** points, **pilot reward rules** on the points card, mobile bottom nav.

---

## Honest demo notes

- The classifier is **scripted on 13 sample items**, not a trained model. It is labelled as a demo model in the UI.
- The **lot check is simulated**: purity, contamination and source-score deltas are hand-authored demo values. No lot photo is processed. The UI states this and calls the check the routine path, not a live model. A clean lot accepted through the check creates a demo buyer chain (listing + 3 verified buyers); a mixed lot is rejected and a hazard is isolated.
- The **passive bin camera and auto-sorting bin are specified options, not built hardware**. Costs, sensors and failure modes are written on the card; nothing is installed.
- The conformal set is **scripted data that follows the real contract** (one class → auto-route, several → user picks, empty → human review). No calibration set exists yet.
- Bin fill levels and sensor pings are **simulated**; the UI says so.
- Routing numbers (14.2 → 9.6 km, fuel, CO₂e) are modelled, not measured.
- Marketplace sellers, weights, hashes, source quality scores and ESG rows are demo data. The scoring rule is printed on the card.
- The co-signed ledger, signature chips, collector passport and Merkle anchor are **illustrative UI**. No Ed25519 keys are generated, no signatures are verified, no UPI payment is initiated, and the root is not committed anywhere. The UI says so on the card.
- The live price feedback uses hand-authored clean/contaminated reference prices, not a market feed.
- Camera preview is real (`getUserMedia`) but classification still maps to the sample set.
- **Awaaz is real only when `ELEVENLABS_API_KEY` is set on the FastAPI gateway.** Without it the UI uses browser speech, then typed text. `VOICE_MOCK=1` returns a tone and a canned transcript for contract tests, and the chip says **Mock voice API**. No model was trained for intent parsing; it is deterministic rules.
- The spoken receipt is a **UI demonstration**: the receipt **text** is hashed in the browser, but no Ed25519 signature is produced and the hash is not committed. New rows are labelled **queued for the next daily anchor** rather than pretending they are already in the root.
- The streak card is a **pilot rule**, not a balance. No money moves, no reward pool is live, and no UPI payout is initiated.
- The facility card **does not name a single company**. It links to CPCB/OSM and states the trust rule; the directory is not connected in this build.
- Accounts are a **single seeded demo user (Ananya R.)**. No OTP is sent, no session is created, and no password is stored. The production auth design is in `ARCHITECTURE.md` §18.
- Nothing calls a live buyer, sensor, payment rail or SMS gateway.

This is deliberate: the deck and the app should not claim a model or hardware that does not exist yet.

---

## Motion system

Built to the brief, CSS-first:

| Interaction | Implementation |
|---|---|
| Button press | `scale(.97)` + shadow, 120 ms `cubic-bezier(.22,1,.36,1)` |
| Toggle | knob `translateX(20px)`, 130 ms ease-out |
| Save / confirm icons | `pop` keyframe, 300 ms spring overshoot |
| Modal | `scale(.95) translateY(10px)` → `scale(1)`, 300 ms / 200 ms |
| Page change | horizontal push + fade, 300 ms `cubic-bezier(.25,1,.5,1)` |
| Dropdown | `scaleY(.9)` from top origin, 200 ms |
| Skeleton | CSS shimmer, 1.5 s loop |
| Progress | `transform: scaleX()` with 400 ms ease-out |
| Spinner | 800 ms linear rotate |
| Onboarding | staggered CSS reveal, 120 ms apart |
| Landing sections | `IntersectionObserver` + reveal transitions |

Only `transform` and `opacity` are animated. `will-change` is applied only during page/modal transitions and removed afterwards. `prefers-reduced-motion` is respected globally.

---

## Files

```
index.html          structure, icon sprite, landing, app shell, modals
assets/styles.css   design tokens, components, responsive layout, motion
assets/app.js       state, routing, lot checks, exception classifier, marketplace, map, charts, Awaaz
voice_api.py        FastAPI gateway: ElevenLabs TTS/STT, deterministic intent, mock mode
requirements-voice.txt  fastapi, uvicorn, httpx, python-multipart
.env.example        server-side voice key, models, CORS, daily cap
streamlit_app.py    Streamlit wrapper: serves the site and frames it full-screen
requirements.txt    streamlit
.streamlit/         server + theme config for the wrapper
PITCH.md            corrected pitch script, slide wording and Q&A
screenshots/        desktop + mobile captures for the submission form
```

No frameworks, no bundler, no network dependency except the Google Fonts link (falls back to system fonts offline).

**On mobile**, the bottom bar has Home, Verify, Market and Impact. *Routes & bins* opens from the two map tiles on the Overview page.

---

## Design tokens

- Forest green `#1B5E20`
- Teal `#00897B`
- Navy `#0B1F3A`
- Light grey `#F5F8F4`
- Display type: Sora · Body: Inter

---

## Notes for the next iteration

- Replace the scripted classifier with a calibrated MobileNetV3-Small (temperature scaling + a 90% conformal gate) served from a small FastAPI endpoint.
- Swap the SVG map for Leaflet + OpenStreetMap and an OR-Tools routing call.
- Persist listings, points and saved items (currently in-memory so every demo starts clean).
- Replace the demo hash chain with dual-signed Ed25519 handoffs and a daily Merkle anchor before calling the ESG export audited.
- Add phone-OTP auth (Firebase/Supabase Auth or equivalent), roles and DPDP consent receipts — design in `ARCHITECTURE.md` §18.
- Load facility records from CPCB/SPCB, municipal MRF lists and OSM, with source + last-verified date and a user report path (§19).
- Move the voice gateway's rate limit/usage ledger to Redis and add short-lived signed sessions before exposing ElevenLabs Agents tools to the public.
