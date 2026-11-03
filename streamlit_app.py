"""LoopGrid on Streamlit.

Streamlit is a Python data-app framework and cannot render this static site on
its own, so this module wraps the existing HTML/CSS/JS instead of rewriting it:

1. `sync_site()` copies `index.html` and `assets/` into `./static`, which
   Streamlit serves at `/app/static/...` (`server.enableStaticServing`).
2. `st.iframe` embeds that page full-viewport. Streamlit's own chrome is hidden,
   so the site behaves exactly as it does when opened directly.

`st.iframe` sandboxes the frame with `allow-scripts`, `allow-same-origin`,
`allow-downloads` and grants camera access, so the classifier preview, the
localStorage-free state and the CSV export all keep working.

The static site stays the single source of truth. Edit `index.html`,
`assets/styles.css` or `assets/app.js` and restart Streamlit.

Run locally:
    streamlit run streamlit_app.py
"""

from __future__ import annotations

import shutil
from pathlib import Path

import streamlit as st

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
SITE_FILES = ("index.html", "assets/styles.css", "assets/app.js")


def sync_site() -> str:
    """Mirror the site into Streamlit's static folder.

    Returns a cache-busting token derived from the newest source mtime.
    """
    newest = 0.0
    for rel in SITE_FILES:
        src = ROOT / rel
        if not src.is_file():
            raise FileNotFoundError(f"Missing site file: {src}")

        dst = STATIC_DIR / rel
        dst.parent.mkdir(parents=True, exist_ok=True)

        mtime = src.stat().st_mtime
        newest = max(newest, mtime)
        if not dst.is_file() or dst.stat().st_mtime < mtime:
            shutil.copy2(src, dst)

    return str(int(newest))


TOKEN = sync_site()

st.set_page_config(
    page_title="LoopGrid — smart waste exchange",
    page_icon="♻️",
    layout="wide",
    initial_sidebar_state="collapsed",
)

# Streamlit adds a header, toolbar, footer and page padding around every app.
# The site is already a complete page, so strip all of it and let the frame own
# the viewport.
st.markdown(
    """
    <style>
      #MainMenu,
      header[data-testid="stHeader"],
      [data-testid="stToolbar"],
      [data-testid="stDecoration"],
      [data-testid="stStatusWidget"],
      [data-testid="stSidebarCollapsedControl"],
      footer {
        display: none !important;
      }

      html, body {
        height: 100%;
        overflow: hidden !important;
      }

      [data-testid="stAppViewContainer"],
      [data-testid="stMain"] {
        overflow: hidden !important;
      }

      [data-testid="stAppViewContainer"] > .main,
      [data-testid="stMain"] {
        padding: 0 !important;
      }

      .block-container,
      [data-testid="stMainBlockContainer"] {
        max-width: 100% !important;
        padding: 0 !important;
      }

      [data-testid="stVerticalBlock"] {
        gap: 0 !important;
      }

      [data-testid="stIFrame"] {
        position: fixed;
        inset: 0;
        width: 100vw !important;
        height: 100vh !important;
        height: 100dvh !important;
        border: 0;
        z-index: 2147483000;
        background: #f5f8f4;
      }
    </style>
    """,
    unsafe_allow_html=True,
)

st.iframe(
    f"/app/static/index.html?v={TOKEN}",
    width="stretch",
    height="stretch",
    alt="LoopGrid — smart waste exchange",
)
