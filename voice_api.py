"""LoopGrid Awaaz — server-side voice gateway.

The browser never sees the ElevenLabs key. This small FastAPI service is the
only place that talks to ElevenLabs, and it is deliberately boring:

  POST /api/voice/tts     text  -> cached mp3 (Flash / multilingual)
  POST /api/voice/stt     audio -> transcript (Scribe), audio is not stored
  POST /api/voice/intent  text  -> structured tool call + spoken reply
  GET  /api/voice/health  capability probe for the browser fallback chain

Safety rules (hazardous routing, confidence gates) stay in LoopGrid's own code.
The voice layer can describe a decision; it cannot make one.

Run locally:
    pip install -r requirements-voice.txt
    $env:ELEVENLABS_API_KEY = "..."      # PowerShell
    uvicorn voice_api:app --reload --port 8000

Without a key the service reports `configured: false` and the UI falls back to
the browser's SpeechSynthesis / SpeechRecognition, then to text.

No audio is written to disk. Only the TTS output is cached, keyed by a hash of
text + voice + model + language, because repeated prompts are the same file.
"""

from __future__ import annotations

import hashlib
import io
import math
import os
import re
import struct
import time
import wave
from collections import defaultdict, deque
from datetime import date
from pathlib import Path
from typing import Literal

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent
CACHE_DIR = Path(os.getenv("VOICE_CACHE_DIR", ROOT / ".voice-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

API_KEY = os.getenv("ELEVENLABS_API_KEY", "").strip()
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM").strip()
TTS_MODEL = os.getenv("ELEVENLABS_TTS_MODEL", "eleven_flash_v2_5").strip()
STT_MODEL = os.getenv("ELEVENLABS_STT_MODEL", "scribe_v1").strip()
MOCK = os.getenv("VOICE_MOCK", "0").strip() == "1"
DAILY_CHAR_CAP = int(os.getenv("VOICE_DAILY_CHAR_CAP", "20000"))
ALLOW_ORIGINS = [o.strip() for o in os.getenv("VOICE_ALLOW_ORIGINS", "*").split(",") if o.strip()]

app = FastAPI(title="LoopGrid Awaaz", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOW_ORIGINS or ["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Small in-process guards. For a pilot, move these to Redis + a real budget.
# ---------------------------------------------------------------------------
_hits: dict[str, deque[float]] = defaultdict(deque)
_usage = {"day": date.today(), "chars": 0}


def _rate_limit(ip: str, limit: int = 20, window: float = 60.0) -> None:
    now = time.monotonic()
    q = _hits[ip]
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= limit:
        raise HTTPException(status_code=429, detail="Too many voice requests. Try again in a minute.")
    q.append(now)


def _charge(chars: int) -> None:
    today = date.today()
    if _usage["day"] != today:
        _usage["day"] = today
        _usage["chars"] = 0
    if _usage["chars"] + chars > DAILY_CHAR_CAP:
        raise HTTPException(status_code=429, detail="Daily voice budget reached. Browser voice fallback is available.")
    _usage["chars"] += chars


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    return (forwarded.split(",")[0].strip() or request.client.host) if request.client else "unknown"


def _cache_key(*parts: str) -> str:
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()[:32]


def _mock_wav(text: str) -> bytes:
    """A short two-tone clip so the API contract can be tested without a key."""
    sample_rate = 16000
    duration = min(0.9, 0.18 + len(text) / 900)
    frames = int(sample_rate * duration)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(sample_rate)
        data = bytearray()
        for i in range(frames):
            t = i / sample_rate
            freq = 520 if t < duration / 2 else 700
            envelope = min(1.0, i / 400, (frames - i) / 600)
            value = int(8000 * envelope * math.sin(2 * math.pi * freq * t))
            data.extend(struct.pack("<h", value))
        wav.writeframes(bytes(data))
    return buf.getvalue()


# ---------------------------------------------------------------------------
# TTS
# ---------------------------------------------------------------------------
class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    lang: str = "hi"
    quality: Literal["flash", "high"] = "flash"


@app.post("/api/voice/tts")
async def tts(payload: TTSRequest, request: Request):
    _rate_limit(_client_ip(request))
    text = " ".join(payload.text.split())
    lang = "en" if payload.lang == "en" else "hi"
    model = "eleven_multilingual_v2" if payload.quality == "high" else TTS_MODEL

    ext, media = "mp3", "audio/mpeg"
    key = _cache_key(text, VOICE_ID, model, lang, ext)
    path = CACHE_DIR / f"{key}.{ext}"

    if path.is_file():
        return FileResponse(path, media_type=media, headers={"X-Voice-Cache": "hit", "X-Voice-Provider": "elevenlabs"})

    if MOCK:
        wav_path = CACHE_DIR / f"{key}.wav"
        if not wav_path.is_file():
            wav_path.write_bytes(_mock_wav(text))
        return FileResponse(wav_path, media_type="audio/wav", headers={"X-Voice-Cache": "miss", "X-Voice-Provider": "mock"})

    if not API_KEY:
        return JSONResponse(
            status_code=503,
            content={"detail": "voice_unconfigured", "fallback": "browser", "hint": "Set ELEVENLABS_API_KEY on the server."},
        )

    _charge(len(text))
    headers = {"xi-api-key": API_KEY, "Accept": "audio/mpeg"}
    body = {
        "text": text,
        "model_id": model,
        "voice_settings": {"stability": 0.45, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": True},
    }
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}?output_format=mp3_44100_128"
    try:
        async with httpx.AsyncClient(timeout=25.0) as client:
            res = await client.post(url, headers=headers, json=body)
    except httpx.HTTPError:
        return JSONResponse(status_code=502, content={"detail": "voice_upstream_unreachable", "fallback": "browser"})

    if res.status_code >= 400:
        return JSONResponse(
            status_code=502,
            content={"detail": "voice_upstream_error", "status": res.status_code, "fallback": "browser"},
        )

    path.write_bytes(res.content)
    return FileResponse(path, media_type=media, headers={"X-Voice-Cache": "miss", "X-Voice-Provider": "elevenlabs"})


# ---------------------------------------------------------------------------
# STT
# ---------------------------------------------------------------------------
STT_MOCK = {
    "hi": "Kal subah 6 baje Sector 12 se 40 kilo PET uthana hai.",
    "hinglish": "Kal subah 6 baje Sector 12 se 40 kilo PET uthana hai.",
    "en": "Pick up 40 kilos of PET from Sector 12 tomorrow at 6 am.",
}


@app.post("/api/voice/stt")
async def stt(request: Request, audio: UploadFile = File(...), lang: str = Form("hi")):
    _rate_limit(_client_ip(request), limit=12)
    data = await audio.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty audio.")
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Audio must be under 12 MB.")

    if MOCK:
        return {"text": STT_MOCK.get(lang, STT_MOCK["hinglish"]), "language": lang, "provider": "mock"}

    if not API_KEY:
        return JSONResponse(
            status_code=503,
            content={"detail": "stt_unconfigured", "fallback": "browser", "hint": "Set ELEVENLABS_API_KEY on the server."},
        )

    files = {"file": (audio.filename or "voice.webm", data, audio.content_type or "audio/webm")}
    form = {"model_id": STT_MODEL}
    try:
        async with httpx.AsyncClient(timeout=45.0) as client:
            res = await client.post(
                "https://api.elevenlabs.io/v1/speech-to-text",
                headers={"xi-api-key": API_KEY},
                files=files,
                data=form,
            )
    except httpx.HTTPError:
        return JSONResponse(status_code=502, content={"detail": "stt_upstream_unreachable", "fallback": "browser"})

    if res.status_code >= 400:
        return JSONResponse(status_code=502, content={"detail": "stt_upstream_error", "status": res.status_code, "fallback": "browser"})

    body = res.json()
    return {"text": (body.get("text") or "").strip(), "language": lang, "provider": "elevenlabs"}


# ---------------------------------------------------------------------------
# Intent + deterministic tools (no LLM in the safety path)
# ---------------------------------------------------------------------------
class IntentRequest(BaseModel):
    text: str = Field(min_length=1, max_length=800)
    lang: str = "hi"
    pending_task: bool = False


MATERIALS = [
    ("PET bottles", "pet", 22, ["pet", "paani ki bottle", "water bottle", "plastic bottle", "बोतल", "पीईटी"]),
    ("Glass jars", "glass", 3, ["glass", "kaanch", "काँच", "कांच", "jar", "bottle"]),
    ("Cardboard", "cardboard", 14, ["cardboard", "carton", "kagaz", "paper", "card board", "कार्डबोर्ड", "गत्ता"]),
    ("Textile offcuts", "textile", 18, ["textile", "kapda", "cloth", "fabric", "कपड़ा"]),
    ("Battery", "battery", 0, ["battery", "बैटरी"]),
    ("E-waste", "ewaste", 65, ["e-waste", "ewaste", "electronic", "charger", "ई-कचरा"]),
    ("Food scraps", "food", 4, ["food", "wet", "geela", "banana", "compost", "गीला", "खाना"]),
    ("Mixed plastic", "mixed", 0, ["plastic", "wrapper", "polythene", "प्लास्टिक"]),
    # Bulk items
    ("Steel almirah", "almirah", 20, ["almirah", "almari", "wardrobe", "अलमारी", "अलमीरा"]),
    ("3-seater sofa", "sofa", 15, ["sofa", "couch", "सोफा"]),
    ("Double mattress", "mattress", 10, ["mattress", "gadda", "गद्दा"]),
    ("Refrigerator", "fridge", 0, ["fridge", "refrigerator", "फ्रिज"]),
    ("Washing machine", "washing_machine", 18, ["washing machine", "वाशिंग मशीन"]),
    ("Air conditioner", "ac", 0, ["air conditioner", "ac unit", "एसी", "ac"]),
    ("CRT Television", "tv_crt", 0, ["crt tv", "television", "टीवी", "tv"]),
    ("Bicycle", "cycle", 15, ["cycle", "bicycle", "साइकिल"]),
]

NUM_WORDS = {
    "ek": 1, "do": 2, "teen": 3, "char": 4, "paanch": 5, "panch": 5, "chhah": 6, "chah": 6,
    "saat": 7, "aath": 8, "nau": 9, "das": 10, "bees": 20, "pachees": 25, "tees": 30,
    "chalis": 40, "pachas": 50, "saath": 60, "sau": 100, "एक": 1, "दो": 2, "तीन": 3,
    "चार": 4, "पांच": 5, "छह": 6, "सात": 7, "आठ": 8, "नौ": 9, "दस": 10,
    "बीस": 20, "पच्चीस": 25, "तीस": 30, "चालीस": 40, "पचास": 50, "साठ": 60,
}

LOCALITIES = ["sector 12", "sector 21", "green park", "hauz khas", "saket", "dwarka", "vasant kunj", "okhla", "iit delhi"]


def _find_material(text: str):
    for canonical, sample, price, aliases in MATERIALS:
        if any(alias in text for alias in aliases):
            return canonical, sample, price
    return None, None, 0


def _find_qty(text: str) -> float | None:
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:kilo|kgs?|kg|किलो)", text)
    if match:
        return float(match.group(1))
    match = re.search(r"(\d+(?:\.\d+)?)\s*(?:kilo|kgs?|kg)", text)
    if match:
        return float(match.group(1))
    for word, value in NUM_WORDS.items():
        if re.search(rf"\b{re.escape(word)}\b", text):
            return float(value)
    return None


def _find_locality(text: str) -> str | None:
    for locality in LOCALITIES:
        if locality in text:
            return "Sector 12" if locality == "sector 12" else locality.title()
    match = re.search(r"sector\s*(\d+)", text)
    if match:
        return f"Sector {match.group(1)}"
    return None


def _find_when(text: str) -> str:
    day = None
    if any(w in text for w in ["kal", "tomorrow", "कल"]):
        day = "tomorrow"
    elif any(w in text for w in ["aaj", "today", "आज"]):
        day = "today"
    period = None
    if any(w in text for w in ["subah", "morning", "सुबह"]):
        period = "morning"
    elif any(w in text for w in ["shaam", "evening", "शाम"]):
        period = "evening"
    match = re.search(r"(\d{1,2})\s*(?:baje|bje|am|pm|बजे)", text)
    hour = match.group(1) if match else None
    if day and hour:
        return f"{day} {hour}:00"
    if day:
        return day
    if hour:
        return f"{hour}:00"
    return "as soon as possible"


def _reply(intent: str, slots: dict, lang: str, confidence: float) -> str:
    material = slots.get("material") or ""
    qty = slots.get("qty_kg")
    locality = slots.get("locality") or ""
    when = slots.get("when") or ""
    price = slots.get("price_per_kg") or 0
    lo, hi = slots.get("band") or (0, 0)

    if intent == "create_listing":
        if slots.get("hazard"):
            if lang == "en":
                return f"This is a hazardous stream: {qty:g} kg of {material}. I will request a certified handler. No marketplace listing and no points."
            if lang == "hi":
                return f"यह खतरनाक कचरा है: {qty:g} किलो {material}. मैं प्रमाणित हैंडलर को अनुरोध भेजूँगा। कोई लिस्टिंग नहीं और कोई पॉइंट नहीं।"
            return f"Yeh hazardous waste hai: {qty:g} kilo {material}. Main certified handler ko request bhejunga. Koi listing nahi, koi points nahi."
        if lang == "en":
            return (
                f"{qty:g} kg of {material} from {locality}, {when}. "
                f"The band is ₹{lo}–{hi} per kg, about ₹{lo * qty:,.0f}–{hi * qty:,.0f}. Shall I create the pickup?"
            )
        if lang == "hi":
            return (
                f"{qty:g} किलो {material}, {locality}, {when}. "
                f"भाव ₹{lo}–{hi} प्रति किलो, कुल ₹{lo * qty:,.0f}–{hi * qty:,.0f}. क्या मैं पिकअप बना दूँ?"
            )
        return (
            f"{qty:g} kilo {material}, {locality}, {when}. "
            f"Rate ₹{lo}–{hi} per kilo, total ₹{lo * qty:,.0f}–{hi * qty:,.0f}. Pickup bana doon?"
        )

    if intent == "get_status":
        if lang == "en":
            return "Pickup LG-1043 was collected at 11:05, delivered at 14:40 and accepted by the buyer at 15:02. The ledger row is intact."
        if lang == "hi":
            return "पिकअप LG-1043 सुबह 11:05 पर उठाया गया, 14:40 पर पहुँचा और 15:02 पर खरीदार ने स्वीकार किया। लेजर पंक्ति सही है।"
        return "Pickup LG-1043 11:05 baje uthaya gaya, 14:40 par pahuncha aur 15:02 par buyer ne accept kiya. Ledger row intact hai."

    if intent == "confirm_pickup":
        if not slots.get("pending_task"):
            if lang == "en":
                return "There is no pickup waiting to confirm. Tell me the material and weight first."
            if lang == "hi":
                return "अभी कोई पिकअप पुष्टि के लिए तैयार नहीं है। पहले सामान और वजन बताइए।"
            return "Abhi koi pickup confirm karne ke liye ready nahi hai. Pehle material aur weight bataiye."
        if lang == "en":
            return "Confirmed. I have written the spoken receipt to the ledger."
        if lang == "hi":
            return "पुष्टि हो गई। बोला हुआ रसीद लेजर में दर्ज कर दिया है।"
        return "Confirm ho gaya. Bola hua receipt ledger mein darj kar diya."

    if intent == "explain_item":
        if slots.get("hazard"):
            if lang == "en":
                return "This is a hazardous stream. Do not put it in the dry bin. Hand it to a CPCB-registered handler."
            if lang == "hi":
                return "यह खतरनाक कचरा है। सूखे कचरे में न डालें। सीपीसीबी पंजीकृत हैंडलर को दें।"
            return "Yeh hazardous waste hai. Dry bin mein mat daalein. CPCB-registered handler ko dein."
        if material:
            if lang == "en":
                return f"{material}: keep it clean and dry. The current band is ₹{lo}–{hi} per kg."
            if lang == "hi":
                return f"{material}: साफ और सूखा रखें। अभी भाव ₹{lo}–{hi} प्रति किलो है।"
            return f"{material}: saaf aur sookha rakhein. Abhi rate ₹{lo}–{hi} per kilo hai."

    if lang == "en":
        return "I'm not sure. Can you repeat the material and the weight?"
    if lang == "hi":
        return "मुझे पक्का नहीं पता। क्या आप दोबारा बता सकते हैं — कौन सा सामान और कितने किलो?"
    return "Mujhe pakka nahi pata. Kya aap dobara bata sakte hain — kaun sa material aur kitne kilo?"


@app.post("/api/voice/intent")
async def intent(payload: IntentRequest, request: Request):
    _rate_limit(_client_ip(request), limit=40)
    raw = payload.text.strip()
    text = raw.lower()
    lang = payload.lang if payload.lang in {"hi", "hinglish", "en"} else "hinglish"

    status_match = re.search(r"(lg-\d{3,6})", text)
    if status_match or any(w in text for w in ["status", "kahan", "track", "where is"]):
        slots = {"listing_id": status_match.group(1).upper() if status_match else "LG-1043", "pending_task": payload.pending_task}
        return {
            "intent": "get_status",
            "confidence": 0.9,
            "slots": slots,
            "tools": ["get_status"],
            "reply": _reply("get_status", slots, lang, 0.9),
        }

    material, sample, price = _find_material(text)

    # Bare confirmation tokens (e.g. "haan", "theek") when no specific material is declared
    if not material:
        confirm_tokens = set(re.sub(r"[.,!?।]", "", text).split())
        if confirm_tokens and len(text.split()) <= 6 and confirm_tokens & {"haan", "ha", "confirm", "theek", "ok", "accept", "हाँ", "ठीक"}:
            slots = {"pending_task": payload.pending_task}
            return {
                "intent": "confirm_pickup",
                "confidence": 0.88 if payload.pending_task else 0.4,
                "slots": slots,
                "tools": ["confirm_pickup", "append_ledger"] if payload.pending_task else [],
                "reply": _reply("confirm_pickup", slots, lang, 0.88 if payload.pending_task else 0.4),
            }

    qty = _find_qty(text)
    bulk_defaults = {"almirah": 50.0, "sofa": 40.0, "mattress": 30.0, "fridge": 40.0, "washing_machine": 25.0, "ac": 45.0, "tv_crt": 22.0, "cycle": 15.0}
    if material and not qty and sample in bulk_defaults:
        qty = bulk_defaults[sample]
    locality = _find_locality(text)
    when = _find_when(text)
    hazard = sample in {"ewaste", "battery", "fridge", "ac", "tv_crt"}
    band = (round(price * 0.85, 1), round(price * 1.15, 1)) if price and not hazard else None

    if any(w in text for w in ["kaise", "why", "explain", "bin", "sort", "कैसे", "कौन सा"]) and material:
        slots = {"material": material, "sample": sample, "band": band, "hazard": hazard}
        return {
            "intent": "explain_item",
            "confidence": 0.8,
            "slots": slots,
            "tools": ["explain_item"],
            "reply": _reply("explain_item", slots, lang, 0.8),
        }

    if material and qty:
        confidence = 0.92 if locality and when != "as soon as possible" else 0.85 if locality else 0.72
        slots = {
            "material": material,
            "sample": sample,
            "qty_kg": qty,
            "locality": locality or "Green Park",
            "when": when,
            "price_per_kg": 0 if hazard else price,
            "band": band,
            "hazard": hazard,
            "pending_task": payload.pending_task,
        }
        return {
            "intent": "create_listing",
            "confidence": confidence,
            "slots": slots,
            "tools": ["create_listing", "get_matches"],
            "reply": _reply("create_listing", slots, lang, confidence),
        }

    confidence = 0.45 if material else 0.2
    slots = {"material": material, "qty_kg": qty, "locality": locality, "when": when, "band": band}
    return {
        "intent": "clarify",
        "confidence": confidence,
        "slots": slots,
        "tools": [],
        "reply": _reply("clarify", slots, lang, confidence),
    }


@app.get("/api/voice/health")
def health():
    provider = "mock" if MOCK else ("elevenlabs" if API_KEY else "unconfigured")
    return {
        "ok": True,
        "configured": bool(API_KEY) or MOCK,
        "provider": provider,
        "tts": bool(API_KEY) or MOCK,
        "stt": bool(API_KEY) or MOCK,
        "voice_id": VOICE_ID,
        "tts_model": TTS_MODEL,
        "stt_model": STT_MODEL,
        "daily_char_cap": DAILY_CHAR_CAP,
        "used_today": _usage["chars"] if _usage["day"] == date.today() else 0,
    }


@app.get("/")
def root():
    return {"service": "LoopGrid Awaaz voice gateway", "docs": "/docs", "health": "/api/voice/health"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("voice_api:app", host="127.0.0.1", port=8000, reload=False)
