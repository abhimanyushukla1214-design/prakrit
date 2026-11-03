/* =========================================================
   LoopGrid — app logic
   Vanilla JS, no build step. All data is demo/modelled data.
   ========================================================= */
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? Math.min(ms, 80) : ms));

  /* ---------------------------------------------------------
     State
     --------------------------------------------------------- */
  const state = {
    page: 'home',
    role: 'household',
    points: 3120,
    carbon: 128.4,
    saved: new Set(),
    onboard: [true, false, false],
    listings: [],
    market: { q: '', category: 'all', sort: 'match', verified: true },
    sample: 'pet',
    lastResult: null,
    cameraOn: false,
    routeOptimized: false,
    skipLow: true,
    sensorsPinged: 0,
    lot: null,
    voice: {
      lang: 'hi',
      base: '',
      mode: 'text',
      consent: false,
      recording: false,
      busy: false,
      pending: null,
      last: null,
      created: 0,
      streak: { months: 2, handoffs: 3, lastDay: '' }
    }
  };

  /* localStorage can throw in private/file contexts — never let that break the demo. */
  function store(key, value) {
    try {
      if (value === undefined) return localStorage.getItem(key) || '';
      localStorage.setItem(key, value);
    } catch (_) { /* ignore */ }
    return value;
  }
  state.voice.base = store('lg.voiceApi').trim();

  const fmt = (n, decimals = 0) =>
    Number(n).toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  /* Keep narrow price bands readable: ₹1.7–2.3 for cheap streams, ₹19–25 above ₹10. */
  const bandEdge = (v) => (v < 10 ? v.toFixed(1).replace(/\.0$/, '') : String(Math.round(v)));

  const esc = (str) => String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* Never reuse a listing id, whether the row came from a scan or from Awaaz. */
  function nextListingId() {
    const used = new Set(
      state.listings
        .map((l) => Number(String(l.id || '').replace(/\D/g, '')))
        .filter((n) => Number.isFinite(n) && n > 0)
    );
    let n = 1043;
    while (used.has(n)) n += 1;
    return `LG-${n}`;
  }

  /* ---------------------------------------------------------
     Data — materials
     --------------------------------------------------------- */
  /* Conformal prediction at 90% coverage. `set` is the returned class set:
     one class → auto-route, several → ask the user, empty → human review.
     `p` is the temperature-scaled top probability, not a raw softmax score. */
  const SAMPLES = {
    pet: {
      name: 'PET bottle', emoji: '🧴', category: 'Plastic', thumb: 'plastic',
      bin: 'Blue bin — dry recyclable', binClass: 'blue',
      set: ['PET'], p: 0.91, grade: 'A', contamination: ['clean'],
      price: 22, points: 40, co2: 1.9, co2Band: [1.4, 2.2], mrs: 88,
      tip: 'Empty and rinse the bottle, remove the cap and label. Bale with other PET — clean PET fetches roughly 30% more per kilo.'
    },
    cardboard: {
      name: 'Cardboard', emoji: '📦', category: 'Paper', thumb: 'paper',
      bin: 'Blue bin — dry recyclable', binClass: 'blue',
      set: ['Paper / cardboard'], p: 0.89, grade: 'A', contamination: ['clean'],
      price: 14, points: 25, co2: 1.1, co2Band: [0.9, 1.4], mrs: 84,
      tip: 'Flatten and keep it bone dry. One wet corner drops the whole bundle to "mixed" and kills the resale price.'
    },
    food: {
      name: 'Food scraps', emoji: '🍌', category: 'Organics', thumb: 'organics',
      bin: 'Green bin — wet / organic', binClass: 'green',
      set: ['Organics'], p: 0.93, grade: 'B', contamination: ['food residue', 'wet'],
      price: 4, points: 15, co2: 0.7, co2Band: [0.5, 0.9], mrs: 76,
      tip: 'No plastic bags, no oil sachets. This stream goes to the society composter and comes back as garden soil in 6 weeks.'
    },
    textile: {
      name: 'Textile offcuts', emoji: '🧵', category: 'Textile', thumb: 'textile',
      bin: 'White sack — reuse / recycling', binClass: 'grey',
      set: ['Textile'], p: 0.87, grade: 'A', contamination: ['clean'],
      price: 18, points: 30, co2: 3.6, co2Band: [2.8, 4.4], mrs: 86,
      tip: 'Keep dry and bag by fibre type. Cotton and denim have the strongest buyer demand; mixed synthetics are downcycled.'
    },
    ewaste: {
      name: 'E-waste', emoji: '🔌', category: 'E-waste', thumb: 'ewaste',
      bin: 'E-waste drop-off — hazardous', binClass: 'red',
      set: ['E-waste'], p: 0.92, grade: 'A', contamination: ['clean'], hazard: true,
      price: 65, points: 0, co2: 4.2, co2Band: [3.4, 5.1], mrs: 93,
      tip: 'Never put this in a dry bin. Wipe your data, keep the charger with the device, and hand it to a CPCB-registered recycler.'
    },
    glass: {
      name: 'Glass jar', emoji: '🫙', category: 'Glass', thumb: 'glass',
      bin: 'Blue bin — glass crate', binClass: 'blue',
      set: ['Glass'], p: 0.90, grade: 'A', contamination: ['clean'],
      price: 3, points: 20, co2: 0.9, co2Band: [0.7, 1.2], mrs: 80,
      tip: 'Rinse and remove the metal lid. Wrap broken glass in paper before placing it — collectors handle this stream by hand.'
    },
    mixed: {
      name: 'Mixed bag', emoji: '🗑️', category: 'Contaminated', thumb: 'organics',
      bin: 'Needs sorting first', binClass: 'red',
      set: ['Multilayer packaging', 'PP / mixed plastic', 'Paper / cardboard'], p: 0.41, grade: 'reject',
      contamination: ['food residue', 'mixed material'], warn: true,
      price: 0, points: 0, co2: 0, co2Band: [0, 0], mrs: 34,
      tip: 'The 90% set has three materials, so LoopGrid will not route or list it. Split dry, wet and hazardous into three bags first.'
    },
    multilayer: {
      name: 'Multilayer wrapper', emoji: '🍟', category: 'Multilayer', thumb: 'plastic',
      bin: 'Reject — no local recycling stream', binClass: 'red',
      set: ['Multilayer packaging'], p: 0.88, grade: 'reject', contamination: ['mixed material'],
      price: 0, points: 0, co2: 0, co2Band: [0, 0], mrs: 18, warn: true,
      tip: 'Chip and biscuit wrappers are foil laminated to plastic. Delhi has no viable stream for them, so the honest answer is "reject", not "recycle".'
    },
    tetrapak: {
      name: 'Tetra Pak carton', emoji: '🥛', category: 'Multilayer', thumb: 'paper',
      bin: 'Special stream — named buyers only', binClass: 'grey',
      set: ['Tetra Pak', 'Multilayer packaging'], p: 0.72, grade: 'C', contamination: ['food residue'],
      price: 2, points: 5, co2: 0.4, co2Band: [0.2, 0.6], mrs: 30,
      tip: 'Rinse, flatten and keep separate. Only a few Delhi buyers take cartons, so LoopGrid holds it until a standing order exists.'
    },
    thermocol: {
      name: 'Thermocol', emoji: '🧊', category: 'Reject', thumb: 'plastic',
      bin: 'Reject — no local buyer', binClass: 'red',
      set: ['Thermocol'], p: 0.85, grade: 'reject', contamination: ['mixed material'],
      price: 0, points: 0, co2: 0, co2Band: [0, 0], mrs: 12, warn: true,
      tip: 'Fragile and almost impossible to densify locally. Do not put it in the dry bin — it shatters into pieces that contaminate the whole load.'
    },
    battery: {
      name: 'Battery', emoji: '🔋', category: 'Hazardous', thumb: 'ewaste',
      bin: 'Certified handler only', binClass: 'red',
      set: ['Batteries'], p: 0.94, grade: 'A', contamination: ['hazardous present'], hazard: true,
      price: 0, points: 0, co2: 0, co2Band: [0, 0], mrs: 95,
      tip: 'Lithium cells can catch fire in a truck. No points are awarded for hazardous disposal — that would reward unsafe handling.'
    },
    sanitary: {
      name: 'Sanitary waste', emoji: '🩹', category: 'Hazardous', thumb: 'ewaste',
      bin: 'Certified handler only', binClass: 'red',
      set: ['Sanitary / biomedical'], p: 0.90, grade: 'reject', contamination: ['hazardous present'],
      hazard: true, price: 0, points: 0, co2: 0, co2Band: [0, 0], mrs: 0,
      tip: 'Wrap and hand to a biomedical waste handler. It must never enter a dry or wet bin, and it is never listed for sale.'
    },
    unknown: {
      name: 'Unrecognised item', emoji: '❓', category: 'Unknown', thumb: 'organics',
      bin: 'Needs human review', binClass: 'grey',
      set: [], p: 0.22, grade: 'unknown', contamination: [], unknown: true,
      price: 0, points: 0, co2: 0, co2Band: [0, 0], mrs: 0,
      tip: 'The conformal set is empty, so the model is out of its depth. Nothing is routed automatically — pick the material manually.'
    }
  };

  /* Clean-grade reference price. Contaminated samples show the live discount. */
  SAMPLES.food.cleanPrice = 6;
  SAMPLES.tetrapak.cleanPrice = 3;
  Object.values(SAMPLES).forEach((s) => {
    if (s.price && !s.cleanPrice) s.cleanPrice = s.price;
  });

  const MAT_META = {
    'PET bottles': { category: 'Plastic', emoji: '🧴', thumb: 'plastic' },
    'Cardboard': { category: 'Paper', emoji: '📦', thumb: 'paper' },
    'Textile offcuts': { category: 'Textile', emoji: '🧵', thumb: 'textile' },
    'Food scraps': { category: 'Organics', emoji: '🍌', thumb: 'organics' },
    'E-waste': { category: 'E-waste', emoji: '🔌', thumb: 'ewaste' },
    'Glass jars': { category: 'Glass', emoji: '🫙', thumb: 'glass' }
  };

  /* Lot-level verification. Households never scan routine waste: one photo
     per bag or bin at pickup checks purity and contamination. */
  const LOTS = {
    clean: {
      name: 'Clean dry lot', emoji: '🛍️', classes: ['PET', 'Cardboard'],
      purity: 96, contamination: 2, reject: 0, weight: '38–44 kg',
      qty: 40, price: 22, co2: 1.9, points: 40,
      material: 'PET bottles', category: 'Plastic', emoji2: '🧴', thumb: 'plastic',
      verdict: 'Accept', tone: 'accept',
      note: 'One wet corner and a greasy box were pulled at the gate. The rest can be listed as mixed dry paper and plastic.'
    },
    mixed: {
      name: 'Mixed bag', emoji: '🗑️', classes: ['Food residue', 'Multilayer wrapper', 'PET'],
      purity: 71, contamination: 14, reject: 6, weight: '22–28 kg',
      qty: 0, price: 0, co2: 0, points: 0,
      verdict: 'Reject · resort', tone: 'warn',
      note: 'Food waste is touching the dry fraction. The bag is not listed; split dry, wet and reject before checking again.'
    },
    hazard: {
      name: 'Hazard in lot', emoji: '🔋', classes: ['Battery', 'E-waste'],
      purity: 0, contamination: 0, reject: 100, weight: '—',
      qty: 0, price: 0, co2: 0, points: 0,
      verdict: 'Isolate · certified handler', tone: 'danger',
      note: 'A lithium battery is in the bag. The lot is isolated, no points are awarded, and a CPCB-registered handler collects it.'
    }
  };

  const seedListings = [
    { id: 'LG-1042', material: 'PET bottles', category: 'Plastic', emoji: '🧴', thumb: 'plastic', qty: 120, price: 22, locality: 'Green Park', distance: 1.2, seller: 'Green Park Society', verified: true, score: 94, posted: '12 min ago', status: 'Listed', co2: 228, note: 'Rinsed, caps removed, baled in 3 bundles.' },
    { id: 'LG-1041', material: 'Cardboard (OCC)', category: 'Paper', emoji: '📦', thumb: 'paper', qty: 340, price: 14, locality: 'Okhla Phase 2', distance: 6.4, seller: 'Okhla Print Works', verified: true, score: 91, posted: '38 min ago', status: 'Pickup accepted', co2: 374, note: 'Dry, flattened, 12 bundles. Loading bay access from the rear lane.' },
    { id: 'LG-1039', material: 'Textile offcuts', category: 'Textile', emoji: '🧵', thumb: 'textile', qty: 85, price: 18, locality: 'Malviya Nagar', distance: 3.1, seller: 'Aarohi Tailoring Unit', verified: true, score: 87, posted: '1 h ago', status: 'Listed', co2: 310, note: 'Cotton blends, clean, sorted by colour.' },
    { id: 'LG-1038', material: 'Food scraps', category: 'Organics', emoji: '🍌', thumb: 'organics', qty: 210, price: 4, locality: 'Hauz Khas', distance: 2.3, seller: 'Hauz Khas Café', verified: false, score: 74, posted: '2 h ago', status: 'Listed', co2: 92, note: 'Veg prep waste only. Daily pickup preferred before 11am.' },
    { id: 'LG-1036', material: 'E-waste (mixed)', category: 'E-waste', emoji: '🔌', thumb: 'ewaste', qty: 46, price: 65, locality: 'Saket', distance: 4.8, seller: 'Saket Coworking', verified: true, score: 96, posted: '3 h ago', status: 'Listed', co2: 138, note: 'Chargers, keyboards, 4 monitors. Registered recycler only.' },
    { id: 'LG-1034', material: 'Glass jars', category: 'Glass', emoji: '🫙', thumb: 'glass', qty: 150, price: 3, locality: 'Vasant Kunj', distance: 5.2, seller: 'Vasant Kunj RWA', verified: true, score: 82, posted: '5 h ago', status: 'Collected', co2: 60, note: 'Clear glass only, lids removed, crated.' },
    { id: 'LG-1032', material: 'Newspaper', category: 'Paper', emoji: '📰', thumb: 'paper', qty: 260, price: 12, locality: 'IIT Delhi', distance: 2.9, seller: 'IIT Delhi Hostel 4', verified: true, score: 89, posted: '6 h ago', status: 'Listed', co2: 286, note: 'Bundle tied, stored dry in the hostel store.' },
    { id: 'LG-1030', material: 'HDPE containers', category: 'Plastic', emoji: '🪣', thumb: 'plastic', qty: 95, price: 28, locality: 'Dwarka Sec 12', distance: 9.6, seller: 'Dwarka Co-op', verified: false, score: 78, posted: '8 h ago', status: 'Listed', co2: 171, note: 'Rinsed, labels removed. Some paint residue on 6 units.' }
  ];
  state.listings = seedListings.map((l) => ({ ...l }));

  const BINS = [
    { id: 'b1', name: 'Green Park A Block', x: 96, y: 318, fill: 72 },
    { id: 'b2', name: 'Hauz Khas Market', x: 186, y: 236, fill: 34 },
    { id: 'b3', name: 'IIT Gate 2', x: 330, y: 172, fill: 88 },
    { id: 'b4', name: 'Saket Plaza', x: 250, y: 356, fill: 22 },
    { id: 'b5', name: 'Malviya Nagar', x: 392, y: 300, fill: 61 },
    { id: 'b6', name: 'Okhla Phase 2', x: 520, y: 252, fill: 79 },
    { id: 'b7', name: 'Vasant Kunj', x: 238, y: 104, fill: 18 },
    { id: 'b8', name: 'Dwarka Sec 12', x: 96, y: 172, fill: 45 }
  ];
  const BASE_ORDER = [0, 1, 2, 3, 4, 5, 6, 7];
  const OPT_ORDER = [0, 3, 4, 5, 2, 1, 6, 7];

  const ROLE_DATA = {
    household: {
      carbon: 128.4, diverted: 96, value: 1840, pickups: 18, goal: 200, points: 3120,
      note: 'Ananya R. · Green Park Society · last 90 days',
      bars: [[4, 9], [6, 8], [5, 9], [8, 7], [9, 6], [7, 6], [11, 5], [12, 5], [13, 4], [14, 4]],
      mix: [34, 28, 18, 10, 6, 4]
    },
    society: {
      carbon: 3840, diverted: 2910, value: 58400, pickups: 96, goal: 5000, points: 48200,
      note: 'Green Park Society · 240 households · last 90 days',
      bars: [[180, 220], [210, 210], [190, 205], [240, 190], [260, 180], [230, 175], [300, 160], [320, 150], [340, 140], [380, 130]],
      mix: [31, 33, 16, 9, 7, 4]
    },
    business: {
      carbon: 11260, diverted: 8400, value: 186000, pickups: 214, goal: 13000, points: 126400,
      note: 'Green Park Retail LLP · 3 outlets · last 90 days',
      bars: [[520, 600], [610, 580], [580, 560], [700, 540], [760, 520], [720, 500], [840, 470], [880, 450], [910, 430], [980, 410]],
      mix: [38, 30, 10, 12, 5, 5]
    }
  };

  const MIX_META = [
    { label: 'Plastic', color: '#1B5E20' },
    { label: 'Paper', color: '#2E7D32' },
    { label: 'Organics', color: '#00897B' },
    { label: 'Textile', color: '#4DB6AC' },
    { label: 'Glass', color: '#A5D6A7' },
    { label: 'E-waste', color: '#B7791F' }
  ];

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct'];

  const ACTIVITY = [
    { icon: '📦', text: '<b>LG-1042</b> PET matched to 3 verified buyers', time: '12 min ago' },
    { icon: '🛻', text: 'Rafiq collected <b>120 kg</b> from A Block', time: '48 min ago' },
    { icon: '⚠️', text: 'IIT Gate 2 bin crossed <b>85%</b> fill', time: '1 h ago' },
    { icon: '🌿', text: 'You earned <b>40 green points</b> for sorting', time: '2 h ago' }
  ];

  const LEADERS = [
    { name: 'Hauz Khas Enclave', sub: '312 households', value: '3.42', s: 1 },
    { name: 'Vasant Kunj RWA', sub: '480 households', value: '3.18', s: .93 },
    { name: 'Green Park Society', sub: '240 households · you', value: '2.96', s: .87, me: true },
    { name: 'Saket Community', sub: '196 households', value: '2.74', s: .8 },
    { name: 'IIT Delhi Hostel 4', sub: '128 residents', value: '2.51', s: .73 },
    { name: 'Dwarka Co-op', sub: '540 households', value: '2.30', s: .67 }
  ];

  /* Source-level quality score: score = 100 − contamination%×1.5 − reject%×2.0. */
  const SOURCES = [
    { name: 'Hauz Khas Enclave', sub: '312 households · 4,180 kg', contamination: 3.2, rejects: 1.1 },
    { name: 'Green Park Society', sub: '240 households · 2,960 kg · you', contamination: 6.4, rejects: 2.8, me: true },
    { name: 'Vasant Kunj RWA', sub: '480 households · 5,240 kg', contamination: 8.1, rejects: 3.4 },
    { name: 'Saket Community', sub: '196 households · 1,880 kg', contamination: 11.6, rejects: 4.9 },
    { name: 'Dwarka Co-op', sub: '540 households · 4,020 kg', contamination: 16.3, rejects: 7.2 }
  ];

  const LEDGER = [
    { title: 'Pickup co-signed', meta: 'Rafiq K. + Ananya R. · 118.4 kg · 18 Oct, 11:05', hash: '0x5be7…c190', sigs: ['Rafiq K.', 'Ananya R.'], done: true },
    { title: 'Delivery co-signed', meta: 'Rafiq K. + Okhla Recyclers · QR at gate · 18 Oct, 14:40', hash: '0x9d02…44ae', sigs: ['Rafiq K.', 'Okhla Recyclers'], done: true },
    { title: 'Buyer acceptance co-signed', meta: 'Okhla Recyclers + Green Park Society · 18 Oct, 15:02', hash: '0x2f88…b31c', sigs: ['Okhla Recyclers', 'Green Park Society'], done: true },
    { title: 'Processing co-signed', meta: 'Okhla Recyclers + Shree Paper Mills · 18 Oct, 16:20', hash: '0x7c1a…9e04', sigs: ['Okhla Recyclers', 'Shree Paper Mills'], done: true }
  ];

  const MERKLE = {
    root: '0x8f3c…a71d',
    day: '18 Oct 2026',
    commit: 'a71d9c2',
    rows: LEDGER.length
  };

  /* ---------------------------------------------------------
     Tiny helpers
     --------------------------------------------------------- */
  function icon(name, cls = '') {
    return `<svg class="icon ${cls}"><use href="#i-${name}"/></svg>`;
  }

  function countTo(el, to, { decimals = 0, duration = 800 } = {}) {
    if (!el) return;
    const from = Number(el.dataset.val || 0);
    if (reduceMotion) {
      el.textContent = fmt(to, decimals);
      el.dataset.val = to;
      return;
    }
    const start = performance.now();
    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = fmt(from + (to - from) * eased, decimals);
      if (p < 1) requestAnimationFrame(tick);
      else el.dataset.val = to;
    };
    requestAnimationFrame(tick);
  }

  function toast(title, message = '', tone = 'success') {
    const stack = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    el.innerHTML = `
      <span class="toast-icon">${icon(tone === 'warn' ? 'alert' : 'check')}</span>
      <div><b>${esc(title)}</b>${message ? `<p>${esc(message)}</p>` : ''}</div>`;
    stack.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => {
      el.classList.remove('in');
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, 4200);
  }

  function popIcon(node) {
    if (!node) return;
    node.classList.remove('icon-active');
    void node.getBoundingClientRect();
    node.classList.add('icon-active');
    setTimeout(() => node.classList.remove('icon-active'), 340);
  }

  /* ---------------------------------------------------------
     Navigation
     --------------------------------------------------------- */
  const PAGE_TITLES = { home: 'Overview', scan: 'Sort & verify', market: 'Marketplace', routes: 'Routes & bins', impact: 'Impact', awaaz: 'Awaaz · voice' };

  function navigate(page, force = false) {
    if (!PAGE_TITLES[page]) return;
    const leaving = state.page;
    const current = $('.page.is-active');
    const target = $(`.page[data-page="${page}"]`);
    if (!target) return;
    if (current === target && !force) return;

    state.page = page;
    if (current) {
      current.classList.remove('is-active', 'page-enter', 'active');
    }
    target.classList.add('is-active');
    if (!reduceMotion) {
      target.classList.add('page-enter');
      target.style.willChange = 'transform, opacity';
      void target.offsetWidth;
      requestAnimationFrame(() => target.classList.add('active'));
      setTimeout(() => {
        target.classList.remove('page-enter', 'active');
        target.style.willChange = '';
      }, 380);
    }
    if (leaving === 'scan' && page !== 'scan') stopCamera();
    if (leaving === 'awaaz' && page !== 'awaaz') stopVoiceCapture();

    $('#crumbLabel').textContent = PAGE_TITLES[page];
    $$('.side-link[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === page));
    $$('.tab[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === page));
    closeSidebar();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function enterApp(page = 'home') {
    $('#landing').style.display = 'none';
    const app = $('#app');
    app.hidden = false;
    document.body.classList.add('in-app');
    navigate(page, true);
    window.scrollTo(0, 0);
  }

  function exitApp() {
    stopCamera();
    $('#app').hidden = true;
    $('#landing').style.display = '';
    document.body.classList.remove('in-app');
    closeModal();
    window.scrollTo(0, 0);
  }

  function openSidebar() {
    $('.sidebar').classList.add('open');
    $('.sidebar-scrim').classList.add('open');
  }
  function closeSidebar() {
    $('.sidebar').classList.remove('open');
    $('.sidebar-scrim').classList.remove('open');
  }

  /* ---------------------------------------------------------
     Modals
     --------------------------------------------------------- */
  let modalTimer = null;

  function openModal(id) {
    const layer = $('#modalLayer');
    clearTimeout(modalTimer);
    $$('.modal').forEach((m) => { m.hidden = true; m.classList.remove('open'); });
    const modal = $('#' + id);
    if (!modal) return;
    layer.hidden = false;
    modal.hidden = false;
    modal.style.willChange = 'transform, opacity';
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => requestAnimationFrame(() => modal.classList.add('open')));
    const focusable = modal.querySelector('button, input, textarea, select');
    if (focusable) setTimeout(() => focusable.focus({ preventScroll: true }), 120);
  }

  function closeModal() {
    const open = $('.modal.open');
    if (!open) return;
    open.classList.remove('open');
    document.body.style.overflow = '';
    modalTimer = setTimeout(() => {
      open.hidden = true;
      open.style.willChange = '';
      if (!$$('.modal.open').length) $('#modalLayer').hidden = true;
    }, reduceMotion ? 0 : 240);
  }

  /* ---------------------------------------------------------
     Selects & toggles
     --------------------------------------------------------- */
  function closeSelects(except) {
    $$('.select.open').forEach((s) => {
      if (s === except) return;
      s.classList.remove('open');
      const t = s.querySelector('.select-trigger');
      if (t) t.setAttribute('aria-expanded', 'false');
    });
  }

  function initSelects() {
    $$('.select').forEach((select) => {
      const trigger = select.querySelector('.select-trigger');
      const label = select.querySelector('[data-select-label]');
      const selected = select.querySelector('.select-menu button.selected') || select.querySelector('.select-menu button');
      if (selected) {
        select.dataset.value = selected.dataset.value;
        if (label) label.textContent = selected.textContent.trim();
      }

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = select.classList.contains('open');
        closeSelects();
        if (!isOpen) {
          select.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          const menu = select.querySelector('.select-menu');
          if (menu && menu.getBoundingClientRect().right > window.innerWidth - 12) menu.classList.add('align-right');
        }
      });

      select.querySelectorAll('.select-menu button').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const value = btn.dataset.value;
          select.querySelectorAll('.select-menu button').forEach((b) => b.classList.remove('selected'));
          btn.classList.add('selected');
          if (label) label.textContent = btn.textContent.trim();
          select.dataset.value = value;
          closeSelects();
          select.dispatchEvent(new CustomEvent('select:change', { detail: { value, name: select.dataset.select } }));
        });
      });
    });

    document.addEventListener('click', () => closeSelects());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSelects(); });
  }

  /* ---------------------------------------------------------
     Landing: reveal + counters
     --------------------------------------------------------- */
  function initReveals() {
    const items = $$('.reveal');
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: .12, rootMargin: '0px 0px -40px 0px' });
    items.forEach((el) => io.observe(el));

    const counters = $$('[data-count]');
    const cio = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        const to = Number(el.dataset.count);
        const suffix = el.dataset.suffix || '';
        if (reduceMotion) {
          el.textContent = fmt(to) + suffix;
        } else {
          const start = performance.now();
          const dur = 1200;
          const tick = (now) => {
            const p = Math.min(1, (now - start) / dur);
            const eased = 1 - Math.pow(1 - p, 3);
            el.textContent = fmt(Math.round(to * eased)) + suffix;
            if (p < 1) requestAnimationFrame(tick);
            else el.textContent = fmt(to) + suffix;
          };
          requestAnimationFrame(tick);
        }
        cio.unobserve(el);
      });
    }, { threshold: .4 });
    counters.forEach((el) => cio.observe(el));
  }

  /* ---------------------------------------------------------
     Home
     --------------------------------------------------------- */
  function rolePercent() {
    const d = ROLE_DATA[state.role];
    return Math.min(99, Math.round((d.carbon / d.goal) * 100));
  }

  function updateHomeStats() {
    const d = ROLE_DATA[state.role];
    const carbonEl = $('#homeCarbon');
    const pointsEl = $('#homePoints');
    if (carbonEl) carbonEl.textContent = fmt(d.carbon, d.carbon < 1000 ? 1 : 0);
    if (pointsEl) pointsEl.textContent = fmt(state.role === 'household' ? state.points : d.points);

    const pct = rolePercent();
    const ring = $('#homeRing');
    if (ring) ring.style.setProperty('--p', (pct / 100).toFixed(3));
    const ringText = $('.ring-center strong');
    if (ringText) ringText.textContent = pct + '%';

    const sideCarbon = $('#sideCarbon');
    if (sideCarbon) sideCarbon.textContent = fmt(d.carbon, d.carbon < 1000 ? 1 : 0);
    const sideBar = $('#sideCarbonBar');
    if (sideBar) sideBar.style.setProperty('--s', (pct / 100).toFixed(3));

    const pts = state.role === 'household' ? state.points : d.points;
    const meter = $('#pointsMeter');
    if (meter) meter.style.setProperty('--s', Math.min(1, pts / 4000).toFixed(3));
    const nextRow = $('.points-next-row b');
    const nextLabel = $('.points-next-row span');
    if (state.role === 'household') {
      if (nextRow) nextRow.textContent = `${fmt(pts)} / 4,000`;
      if (nextLabel) nextLabel.textContent = 'Next reward · ₹150 at Green Park Market';
    } else {
      if (nextRow) nextRow.textContent = 'Ledger verified';
      if (nextLabel) nextLabel.textContent = 'Wallet · redeemable against collection fees';
      if (meter) meter.style.setProperty('--s', '1');
    }

    const sideCount = $('#sideMarketCount');
    if (sideCount) sideCount.textContent = String(state.listings.length);
    const mCount = $('#mstatListings');
    if (mCount) mCount.textContent = String(state.listings.filter((l) => l.status === 'Listed').length);
  }

  function renderHomeBins() {
    const host = $('#homeBins');
    if (!host) return;
    const picks = [BINS[0], BINS[2], BINS[5]];
    host.innerHTML = picks.map((b) => {
      const level = b.fill >= 80 ? 'high' : b.fill >= 55 ? 'mid' : 'ok';
      const label = level === 'high' ? 'Overflow risk' : level === 'mid' ? 'Filling' : 'Healthy';
      const iconEmoji = level === 'high' ? '⚠️' : '🗑️';
      return `
        <div class="bin-row">
          <span class="bin-icon">${iconEmoji}</span>
          <div class="bin-main"><b>${b.name}</b><small>Last ping ${2 + (b.fill % 7)} min ago · dry + wet</small></div>
          <div class="bin-fill"><div class="meter"><i style="--s:${b.fill / 100}"></i></div><small>${b.fill}% full</small></div>
          <span class="bin-status ${level}">${label}</span>
        </div>`;
    }).join('');
  }

  function renderActivity() {
    const host = $('#homeActivity');
    if (!host) return;
    host.innerHTML = ACTIVITY.map((a) => `
      <li>
        <span class="act-icon">${a.icon}</span>
        <div><p>${a.text}</p><small>${a.time}</small></div>
      </li>`).join('');
  }

  function renderOnboard() {
    const steps = $$('.onboard-step');
    steps.forEach((step, i) => {
      const done = state.onboard[i];
      step.classList.toggle('done', done);
      const check = step.querySelector('.step-check');
      check.innerHTML = done ? icon('check') : `<span>${i + 1}</span>`;
      const stateEl = step.querySelector('.step-state');
      stateEl.innerHTML = done ? 'Done' : `Start ${icon('arrow')}`;
    });
    const count = $('#onboardDone');
    if (count) count.textContent = String(state.onboard.filter(Boolean).length);
  }

  function markOnboard(i) {
    if (state.onboard[i]) return;
    state.onboard[i] = true;
    renderOnboard();
  }

  /* ---------------------------------------------------------
     Scan
     --------------------------------------------------------- */
  function setSample(key, { silent = false } = {}) {
    const s = SAMPLES[key];
    if (!s) return;
    state.sample = key;
    state.pick = null;
    $$('.sample').forEach((b) => b.classList.toggle('active', b.dataset.sample === key));
    const item = $('#vfItem');
    if (item) {
      item.classList.add('swap');
      setTimeout(() => {
        item.textContent = s.emoji;
        item.classList.remove('swap');
      }, reduceMotion ? 10 : 160);
    }
    const cap = $('#vfCaption');
    if (cap) cap.textContent = `${s.name} · hold steady inside the frame`;
    const tag = $('#vfTag');
    if (tag) tag.textContent = 'READY';
    if (!silent) {
      const body = $('#resultBody');
      if (body && !body.hidden) {
        body.hidden = true;
        $('#resultEmpty').hidden = false;
        state.lastResult = null;
      }
    }
  }

  async function classify() {
    const btn = $('#classifyBtn');
    if (btn.disabled) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner light"></span> Classifying…`;
    $('#resultEmpty').hidden = true;
    $('#resultBody').hidden = true;
    const loading = $('#resultLoading');
    loading.hidden = false;
    const tag = $('#vfTag');
    if (tag) tag.textContent = 'SCANNING';

    await wait(950);

    loading.hidden = true;
    btn.disabled = false;
    btn.innerHTML = original;
    if (tag) tag.textContent = 'MATCH FOUND';
    renderScanResult(state.sample);
  }

  function renderScanResult(key) {
    const s = SAMPLES[key];
    state.lastResult = key;
    state.scanKey = key;
    const body = $('#resultBody');
    body.hidden = false;

    const set = s.set || [];
    const size = set.length;
    const picked = state.pick && set.includes(state.pick) ? state.pick : null;
    const band = s.price ? `₹${bandEdge(s.price * 0.85)}–${bandEdge(s.price * 1.15)}` : '—';
    const co2 = s.co2Band && s.co2Band[1]
      ? `−${(s.co2Band[0] * 25).toFixed(0)}–${(s.co2Band[1] * 25).toFixed(0)} kg`
      : '—';

    const setNote = s.unknown
      ? 'Empty set — the item is outside the model’s known classes. Nothing is routed automatically.'
      : s.warn
        ? size === 1
          ? 'One class in the set, but this material has no viable Delhi recycling stream. Nothing is listed.'
          : `${size} possible materials, and the bag is contaminated. The pick is logged, but the listing stays blocked until it is sorted.`
        : size === 1
          ? 'One class in the set — safe to route automatically.'
          : `${size} possible materials. Pick the one you are holding; the choice is logged for review.`;

    const dirty = s.price > 0 && s.cleanPrice > s.price;
    const drop = dirty ? Math.round((1 - s.price / s.cleanPrice) * 100) : 0;

    body.innerHTML = `
      <div class="result-head">
        <div class="result-cat">
          <span class="result-emoji">${s.emoji}</span>
          <div>
            <h2>${s.name}</h2>
            <p>${s.category} · grade ${s.grade}${s.contamination.length ? ' · ' + s.contamination.join(', ') : ''}</p>
          </div>
        </div>
        <span class="set-badge ${size === 1 ? '' : 'warn'}">90% set · ${size} ${size === 1 ? 'class' : 'classes'}</span>
      </div>

      <div class="set-block">
        <div class="set-label"><span>Conformal prediction set</span><span>90% coverage</span></div>
        <div class="set-row">
          ${size
            ? set.map((c) => `<button class="set-chip ${picked === c || size === 1 ? 'on' : ''}" data-pick="${c}" ${size === 1 ? 'disabled' : ''}>${c}</button>`).join('')
            : '<span class="set-chip empty">∅ no confident class</span>'}
        </div>
        <p class="set-note">${setNote}</p>
      </div>

      <div class="bin-pill ${s.binClass}">♻️ ${s.bin}</div>

      <div class="result-grid">
        <div class="result-cell"><span>Resale band</span><b class="good">${band}${s.price ? '/kg' : ''}</b></div>
        <div class="result-cell"><span>Green points</span><b class="good">${s.points ? '+' + s.points : '—'}</b></div>
        <div class="result-cell"><span>CO₂e / 25 kg</span><b>${co2}</b></div>
      </div>

      ${dirty ? `<div class="price-feedback">${icon('trend')}<span><b>−${drop}% for ${s.contamination.join(' + ')}.</b> Clean grade pays ₹${s.cleanPrice}/kg; your band is ${band}/kg. This is the price signal, not a penalty.</span></div>` : ''}

      <p class="weight-note">Weight 18–32 kg estimated from the photo · settled on the collector’s scale at pickup.</p>
      <p class="co2-note">Factor v2026.10 · counted on additional diversion only, never on total collected kg.</p>

      <div class="mrs-row">
        <span class="mrs-label">Material recovery</span>
        <div class="meter"><i style="--s:${s.mrs / 100}"></i></div>
        <b>${s.mrs}</b>
      </div>

      ${s.hazard ? `<div class="hazard-banner">${icon('alert')}<span><b>Hazardous stream.</b> No marketplace listing and no points — this goes to a CPCB-certified handler only.</span></div>` : ''}

      <div class="tip-box ${s.warn ? 'warn' : ''}">
        ${icon(s.warn ? 'alert' : 'spark')}
        <span>${s.tip}</span>
      </div>

      <div class="result-actions">
        <button class="btn btn-ghost" data-scan-listen><svg class="icon"><use href="#i-volume"/></svg> Sunnein</button>
        <button class="btn btn-outline" data-scan-retake>Scan again</button>
        <button class="btn btn-primary" data-scan-confirm ${size > 1 && !picked ? 'disabled' : ''}>${
          s.hazard ? 'Request certified pickup'
          : s.unknown ? 'Needs review'
          : s.warn ? 'Sort first'
          : size > 1 && !picked ? 'Pick a material'
          : 'Confirm &amp; list'
        }</button>
      </div>
    `;
  }

  function resetScan() {
    $('#resultBody').hidden = true;
    $('#resultEmpty').hidden = false;
    $('#resultLoading').hidden = true;
    state.lastResult = null;
    state.pick = null;
    const tag = $('#vfTag');
    if (tag) tag.textContent = 'READY';
  }

  /* ---------------------------------------------------------
     Lot verification — the routine path.
     One photo per bag/bin at pickup; households only scan exceptions.
     --------------------------------------------------------- */
  function lotSource() {
    return SOURCES.find((s) => s.me) || SOURCES[0];
  }

  function lotScore(contamination, rejects) {
    return Math.max(0, Math.min(100, Math.round(100 - contamination * 1.5 - rejects * 2.0)));
  }

  function lotHash() {
    return `0x${Math.random().toString(16).slice(2, 6)}…${Math.random().toString(16).slice(2, 6)}`;
  }

  function renderLotCheck(key) {
    const lot = LOTS[key];
    const body = $('#lotResultBody');
    const empty = $('#lotEmpty');
    if (!lot || !body || !empty) return;
    const src = lotSource();
    const before = lotScore(src.contamination, src.rejects);
    const nextContam = +(src.contamination * 0.8 + lot.contamination * 0.2).toFixed(1);
    const nextReject = +(src.rejects * 0.8 + lot.reject * 0.2).toFixed(1);
    const after = lotScore(nextContam, nextReject);
    const hazard = lot.tone === 'danger';
    const delta = hazard ? 'held for review' : `${before} → ${after}`;
    state.lot = { key, lot, src, before, after, nextContam, nextReject, logged: false };

    empty.hidden = true;
    body.hidden = false;
    body.innerHTML = `
      <div class="lot-verdict ${lot.tone}">
        <span class="lot-verdict-badge">${lot.verdict}</span>
        <div><b>${lot.purity ? `${lot.purity}% purity · ${lot.qty} kg` : 'Hazard found'}</b><small>${lot.classes.join(' · ')}</small></div>
      </div>
      <div class="purity-meter ${lot.tone}"><i style="--s:${lot.purity / 100}"></i></div>
      <div class="lot-facts">
        <div><span>Purity</span><b>${lot.purity}%</b></div>
        <div><span>Contamination</span><b>${lot.contamination}%</b></div>
        <div><span>Source score</span><b>${delta}</b></div>
      </div>
      <p class="lot-note">${lot.note}</p>
      <div class="tool-row">
        <span class="tool-chip">lot_check()</span>
        <span class="tool-chip">source_score()</span>
        <span class="tool-chip">${hazard ? 'route_hazard()' : 'append_ledger()'}</span>
      </div>
      <p class="fine">Collector-confirmed weight: ${lot.weight}. The photo estimate is never used for settlement.</p>
      <div class="lot-actions">
        <button class="btn btn-primary btn-sm" data-lot-log>${lot.tone === 'accept' ? 'Accept · list to buyer' : lot.tone === 'warn' ? 'Reject · log' : 'Isolate &amp; log'}</button>
        <button class="btn btn-ghost btn-sm" data-lot-reset>Clear</button>
      </div>`;
    body.classList.remove('voice-in');
    void body.offsetWidth;
    body.classList.add('voice-in');
  }

  function clearLotCheck() {
    state.lot = null;
    const body = $('#lotResultBody');
    if (body) { body.hidden = true; body.innerHTML = ''; }
    const empty = $('#lotEmpty');
    if (empty) empty.hidden = false;
    $$('[data-lot]').forEach((b) => b.classList.remove('active'));
  }

  function logLotCheck() {
    const record = state.lot;
    if (!record) return;
    if (record.logged) {
      toast('Already logged', 'This lot check is already in the ledger.');
      return;
    }
    const { lot, src, nextContam, nextReject } = record;
    const stamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const hazard = lot.tone === 'danger';

    if (!hazard) {
      src.contamination = nextContam;
      src.rejects = nextReject;
      renderSourceScore();
    }

    /* A clean lot is already sorted: we skip the item scan and go straight to
       buyer matching + listing creation = the chain. */
    let listing = null;
    if (lot.tone === 'accept') {
      listing = {
        id: nextListingId(),
        material: lot.material || lot.classes[0] || 'Sorted lot',
        category: lot.category || 'Mixed',
        emoji: lot.emoji2 || lot.emoji,
        thumb: lot.thumb || 'plastic',
        qty: lot.qty,
        price: lot.price,
        locality: 'Green Park',
        distance: 0.4,
        seller: 'Green Park Society',
        verified: true,
        score: 92,
        posted: 'Just now',
        fresh: Date.now(),
        status: 'Listed',
        co2: Math.round(lot.qty * lot.co2),
        note: `From lot check · ${lot.name} · ${lot.purity}% purity`
      };
      state.listings.unshift(listing);
      state.points += lot.points;
      ROLE_DATA.household.carbon = +(ROLE_DATA.household.carbon + lot.qty * lot.co2).toFixed(1);
      state.carbon = ROLE_DATA.household.carbon;
      ACTIVITY.unshift({ icon: '📦', text: `Lot check → <b>${listing.id}</b> · ${listing.material} ${lot.qty} kg`, time: 'Just now' });
      updateHomeStats();
      renderActivity();
      renderMarket();
      renderImpact(state.role);
      markOnboard(1);
      if (state.onboard[0]) markOnboard(0);
    }

    const title = lot.tone === 'accept'
      ? 'Buyer chain created'
      : lot.tone === 'warn'
        ? 'Lot check rejected'
        : 'Hazard isolated';

    LEDGER.unshift({
      title,
      meta: `Rafiq K. + Ananya R. · ${lot.weight} · ${lot.purity}% purity · ${stamp}`,
      hash: lotHash(),
      sigs: ['Rafiq K.', 'Ananya R.'],
      done: true,
      pendingAnchor: true
    });
    MERKLE.rows += 1;
    MERKLE.pending = (MERKLE.pending || 0) + 1;
    record.logged = true;
    renderLedger();

    const btn = $('[data-lot-log]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = lot.tone === 'accept' ? 'Listed · chain live' : lot.tone === 'warn' ? 'Rejected' : 'Isolated';
    }

    if (lot.tone === 'accept' && listing) {
      toast('Buyer chain created', `${listing.id} · ${listing.material} · ${lot.qty} kg · 3 verified buyers · listing live in Marketplace.`);
    } else {
      toast(title, hazard ? 'Certified handler requested. No points for hazardous waste.' : `${lot.purity}% purity · queued for the next daily anchor.`, hazard ? 'warn' : 'success');
    }
  }

  async function confirmScan() {
    const key = state.lastResult;
    if (!key) return;
    const s = SAMPLES[key];

    if (s.unknown) {
      toast('Needs human review', 'The prediction set is empty, so nothing is auto-routed. Pick the material from the manual list below.', 'warn');
      return;
    }
    if (s.hazard) {
      toast('Certified pickup requested', `${s.name} · no points awarded. A CPCB-registered handler will collect within 24 h.`, 'warn');
      ACTIVITY.unshift({ icon: '☣️', text: `<b>${s.name}</b> routed to a certified handler`, time: 'Just now' });
      renderActivity();
      const hb = $('[data-scan-confirm]');
      if (hb) {
        hb.disabled = true;
        hb.innerHTML = `${icon('check')} Pickup requested`;
      }
      return;
    }
    if (s.warn) {
      const mixed = s.name === 'Mixed bag';
      toast(
        mixed ? 'Sort this bag first' : 'No recycling stream',
        mixed
          ? 'Dry, wet and hazardous material are touching, so the bag cannot be listed as one lot. Split it into three bags and scan again.'
          : `${s.name} is rejected — there is no viable Delhi buyer. Keep it out of the dry bin so it cannot contaminate the load.`,
        'warn'
      );
      return;
    }
    if (s.set.length > 1 && !state.pick) {
      toast('Pick the material', 'The 90% set has more than one class. Choose the one you are holding so the override can be logged.', 'warn');
      return;
    }

    const btn = $('[data-scan-confirm]');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = `<span class="spinner light"></span> Creating listing…`;
    }

    await wait(700);

    const material = state.pick || s.name;
    const listing = {
      id: nextListingId(),
      material: material === 'PET bottle' ? 'PET bottles' : material,
      category: s.category,
      emoji: s.emoji,
      thumb: s.thumb,
      qty: 25,
      price: s.price,
      locality: 'Green Park',
      distance: 0.4,
      seller: 'Green Park Society',
      verified: true,
      score: s.mrs,
      posted: 'Just now',
      fresh: Date.now(),
      status: 'Listed',
      co2: Math.round(25 * s.co2),
      note: state.pick
        ? `Override: user picked ${material} from the 90% set. Logged for review.`
        : 'Added from a camera scan. Rinsed and sorted.'
    };
    state.listings.unshift(listing);
    state.points += s.points;
    ROLE_DATA.household.carbon = +(ROLE_DATA.household.carbon + s.co2).toFixed(1);
    state.carbon = ROLE_DATA.household.carbon;

    ACTIVITY.unshift({ icon: '📸', text: `Scanned <b>${material}</b> → ${listing.id} created`, time: 'Just now' });

    updateHomeStats();
    renderActivity();
    renderMarket();
    renderImpact(state.role);
    markOnboard(1);
    if (state.onboard[0]) markOnboard(0);

    if (btn) {
      btn.innerHTML = `${icon('check')} Listed · ${listing.id}`;
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-soft');
    }
    toast(
      state.pick ? 'Listing created · override logged' : 'Listing created',
      `${material} · 25 kg · ${listing.id}. Matched to 3 verified buyers.`
    );
    state.pick = null;
    setTimeout(() => navigate('market'), 900);
  }

  function stopCamera() {
    if (!state.cameraOn) return;
    const video = $('#camera');
    if (video && video.srcObject) video.srcObject.getTracks().forEach((track) => track.stop());
    if (video) { video.srcObject = null; video.hidden = true; }
    state.cameraOn = false;
    const scene = $('#vfScene');
    if (scene) { scene.style.opacity = ''; scene.style.pointerEvents = ''; }
    const btn = $('#cameraBtn');
    if (btn) btn.innerHTML = `${icon('camera')} Enable camera`;
    const hint = $('#stageHint');
    if (hint) hint.textContent = 'Demo classifier · 7 sample items';
  }

  async function enableCamera() {
    const video = $('#camera');
    if (state.cameraOn) {
      toast('Camera already on', 'Point it at an item, then classify. This demo still maps to sample labels.');
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      toast('Camera not available', 'This browser has no camera API. Use the sample items instead.', 'warn');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      video.srcObject = stream;
      video.hidden = false;
      $('#vfScene').style.opacity = '0';
      $('#vfScene').style.pointerEvents = 'none';
      state.cameraOn = true;
      $('#cameraBtn').innerHTML = `${icon('check')} Camera on`;
      $('#stageHint').textContent = 'Live camera · demo classifier';
      toast('Camera on', 'Live preview is active. Classification still uses the sample set.');
    } catch (err) {
      toast('Camera permission blocked', 'Use the sample items — they run the same demo classifier.', 'warn');
    }
  }

  /* ---------------------------------------------------------
     Marketplace
     --------------------------------------------------------- */
  function listingCard(l, index) {
    const saved = state.saved.has(l.id);
    return `
      <article class="listing-card" data-listing="${l.id}" tabindex="0" role="button" aria-label="${esc(l.material)} listing" style="animation-delay:${Math.min(index * 30, 240)}ms">
        <div class="listing-thumb thumb-${l.thumb}">
          <span>${l.emoji}</span>
          <span class="listing-score"><i class="dot"></i>${l.score}% fit</span>
          <button class="listing-save ${saved ? 'saved' : ''}" data-save="${l.id}" aria-label="Save listing" aria-pressed="${saved}">${icon('heart')}</button>
        </div>
        <div class="listing-body">
          <div class="listing-top">
            <div><h3>${esc(l.material)}</h3><small>${esc(l.locality)} · ${l.distance} km away</small></div>
            <span class="listing-price">₹${l.price}<span>/kg</span></span>
          </div>
          <div class="listing-meta">
            <span class="chip">${l.qty} kg</span>
            <span class="chip">${l.category}</span>
            <span class="chip ${l.status === 'Listed' ? 'good' : 'blue'}">${l.status}</span>
          </div>
          <div class="listing-foot">
            <span class="listing-seller ${l.verified ? '' : 'unverified'}">${icon(l.verified ? 'shield' : 'clock')} ${esc(l.seller)}</span>
            <span>${l.posted}</span>
          </div>
        </div>
      </article>`;
  }

  function filteredListings() {
    const { q, category, sort, verified } = state.market;
    let rows = state.listings.filter((l) => {
      if (verified && !l.verified) return false;
      if (category !== 'all' && l.category !== category) return false;
      if (q) {
        const hay = `${l.material} ${l.locality} ${l.seller} ${l.category}`.toLowerCase();
        if (!hay.includes(q.toLowerCase())) return false;
      }
      return true;
    });
    const sorters = {
      // A just-published listing sits at the top, then the rest rank by match score.
      match: (a, b) => (b.fresh || 0) - (a.fresh || 0) || b.score - a.score,
      distance: (a, b) => a.distance - b.distance,
      price: (a, b) => b.price - a.price,
      qty: (a, b) => b.qty - a.qty
    };
    return rows.sort(sorters[sort] || sorters.match);
  }

  function renderMarket() {
    const host = $('#marketGrid');
    if (!host) return;
    const rows = filteredListings();
    host.innerHTML = rows.map(listingCard).join('');
    $('#marketEmpty').hidden = rows.length > 0;
    const count = $('#sideMarketCount');
    if (count) count.textContent = String(state.listings.length);
    const mCount = $('#mstatListings');
    if (mCount) mCount.textContent = String(state.listings.filter((l) => l.status === 'Listed').length);
  }

  function qrGrid(seed) {
    let h = 2166136261;
    for (const ch of seed) h = (h ^ ch.charCodeAt(0)) * 16777619 >>> 0;
    const cells = [];
    for (let i = 0; i < 49; i++) {
      h = (h * 1664525 + 1013904223) >>> 0;
      cells.push((h >>> 17) & 1);
    }
    [[0, 0], [0, 5], [5, 0]].forEach(([r, c]) => {
      for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) cells[(r + i) * 7 + (c + j)] = 1;
    });
    return cells.map((on) => `<i class="${on ? 'on' : ''}"></i>`).join('');
  }

  function timelineFor(status) {
    const events = ['Listed', 'Pickup accepted', 'Collected', 'Delivered', 'Accepted by buyer', 'Processing confirmed'];
    const doneCount = Math.max(1, events.indexOf(status) + 1 || 1);
    return events.map((ev, i) => {
      const done = i < doneCount;
      return `
        <div class="tl-item ${done ? '' : 'pending'}">
          <span class="tl-dot ${done ? 'done' : ''}">${done ? icon('check') : ''}</span>
          <div class="tl-main"><b>${ev}</b><small>${done ? 'Logged with hash' : 'Awaiting event'}</small></div>
        </div>`;
    }).join('');
  }

  function openListing(id) {
    const l = state.listings.find((x) => x.id === id);
    if (!l) return;
    $('#listingTitle').textContent = l.material;
    $('#listingBody').innerHTML = `
      <div class="detail-hero">
        <span class="detail-thumb thumb-${l.thumb}">${l.emoji}</span>
        <div><h3>${esc(l.material)}</h3><p>${esc(l.seller)} · ${esc(l.locality)}</p></div>
        <div class="detail-price"><b>₹${l.price}/kg</b><small>${l.qty} kg available</small></div>
      </div>

      <div class="detail-grid">
        <div class="detail-cell"><span>Recovery score</span><b>${l.score} / 100</b></div>
        <div class="detail-cell"><span>Distance</span><b>${l.distance} km</b></div>
        <div class="detail-cell"><span>Est. value</span><b>₹${fmt(l.qty * l.price)}</b></div>
        <div class="detail-cell"><span>CO₂e avoided</span><b>${l.co2} kg</b></div>
      </div>

      <div class="tip-box">${icon('spark')}<span>${esc(l.note || 'No seller notes. Ask for a photo of the current load before accepting.')}</span></div>

      <div class="detail-section">
        <h4>Pickup traceability</h4>
        <div class="qr-block">
          <div class="qr-grid">${qrGrid(l.id)}</div>
          <div class="qr-copy">
            <b>${l.id} · QR sealed at collection</b>
            <small>Each scan appends a hash to the ledger. Buyers can verify the weight and the pickup time before payment releases.</small>
          </div>
        </div>
      </div>

      <div class="detail-section">
        <h4>Status</h4>
        <div class="timeline">${timelineFor(l.status)}</div>
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" data-close-modal>Close</button>
        <button class="btn btn-primary" data-accept="${l.id}">${l.status === 'Listed' ? 'Accept pickup' : 'View pickup'}</button>
      </div>
    `;
    openModal('modalListing');
  }

  function acceptPickup(id) {
    const l = state.listings.find((x) => x.id === id);
    if (!l) return;
    l.status = 'Pickup accepted';
    toast('Pickup accepted', `${l.id} · collector assigned. A QR is generated at collection.`);
    closeModal();
    renderMarket();
  }

  function publishListing(form) {
    const data = new FormData(form);
    const material = $('.select[data-select="newMaterial"]').dataset.value || 'PET bottles';
    const meta = MAT_META[material] || MAT_META['PET bottles'];
    const qty = Math.max(1, Number(data.get('qty')) || 1);
    const price = Math.max(0, Number(data.get('price')) || 0);
    const locality = (data.get('locality') || 'Green Park').toString().trim();
    const note = (data.get('notes') || '').toString().trim();
    const listing = {
      id: 'LG-' + (1100 + state.listings.length),
      material,
      category: meta.category,
      emoji: meta.emoji,
      thumb: meta.thumb,
      qty,
      price,
      locality,
      distance: +(1 + Math.random() * 6).toFixed(1),
      seller: state.role === 'household' ? 'Green Park Society' : 'Green Park Retail LLP',
      verified: true,
      score: 90 + Math.round(Math.random() * 8),
      posted: 'Just now',
      fresh: Date.now(),
      status: 'Listed',
      co2: Math.round(qty * 1.6),
      note: note || 'Freshly listed from the app.'
    };
    state.listings.unshift(listing);
    ACTIVITY.unshift({ icon: '📦', text: `New listing <b>${listing.id}</b> · ${qty} kg ${material.toLowerCase()}`, time: 'Just now' });
    state.points += 50;
    markOnboard(2);
    renderMarket();
    renderActivity();
    updateHomeStats();
    closeModal();
    form.reset();
    navigate('market');
    toast('Listing published', `${qty} kg of ${material.toLowerCase()} is live. Buyers matching this grade are being notified.`);
  }

  /* ---------------------------------------------------------
     Routes
     --------------------------------------------------------- */
  function routeStats() {
    const { routeOptimized, skipLow } = state;
    const distance = routeOptimized ? (skipLow ? 9.6 : 11.4) : (skipLow ? 12.6 : 14.2);
    const stops = skipLow ? 5 : 8;
    const fuel = +(distance * 0.345).toFixed(1);
    const co2 = +(fuel * 2.68).toFixed(1);
    return { distance, stops, fuel, co2 };
  }

  function activeOrder() {
    const order = state.routeOptimized ? OPT_ORDER : BASE_ORDER;
    const rows = order.map((i) => ({ ...BINS[i], index: i }));
    const active = state.skipLow ? rows.filter((b) => b.fill >= 40) : rows;
    const skipped = state.skipLow ? rows.filter((b) => b.fill < 40) : [];
    return { active, skipped };
  }

  function renderMap() {
    const { active, skipped } = activeOrder();
    const mapBins = $('#mapBins');
    const mapRoute = $('#mapRoute');
    if (!mapBins || !mapRoute) return;

    mapRoute.innerHTML = active.length
      ? `<path class="route-line" d="${active.map((b, i) => `${i === 0 ? 'M' : 'L'}${b.x} ${b.y}`).join(' ')}"/>`
      : '';

    mapBins.innerHTML = BINS.map((b, i) => {
      const isSkipped = state.skipLow && b.fill < 40;
      const color = b.fill >= 80 ? '#D14B3A' : b.fill >= 55 ? '#E0A32E' : '#3E9142';
      return `
        <g class="map-node ${isSkipped ? 'skipped' : ''}" data-bin="${b.id}" transform="translate(${b.x} ${b.y})">
          <circle class="node-halo" r="24" fill="${color}" opacity=".14"/>
          <circle r="16" fill="#fff" stroke="${color}" stroke-width="3" filter="url(#pinShadow)"/>
          <text class="node-fill" text-anchor="middle" dy="3.5">${b.fill}</text>
          <text class="node-label" text-anchor="middle" y="31">${b.name.split(' ')[0]}${b.name.split(' ')[1] ? ' ' + b.name.split(' ')[1] : ''}</text>
        </g>`;
    }).join('');

    const wrap = $('.map-wrap');
    const tooltip = $('#mapTooltip');
    $$('.map-node', mapBins).forEach((node) => {
      const bin = BINS.find((b) => b.id === node.dataset.bin);
      node.addEventListener('mouseenter', () => {
        const r = node.getBoundingClientRect();
        const wr = wrap.getBoundingClientRect();
        tooltip.hidden = false;
        tooltip.style.left = `${r.left - wr.left + r.width / 2}px`;
        tooltip.style.top = `${r.top - wr.top}px`;
        tooltip.innerHTML = `<b>${bin.name}</b><small>${bin.fill}% full · ${bin.fill >= 80 ? 'overflow risk' : bin.fill >= 40 ? 'collect today' : 'skip · under 40%'}</small>`;
      });
      node.addEventListener('mouseleave', () => { tooltip.hidden = true; });
    });

    const badge = $('#mapBadge');
    if (badge) badge.innerHTML = `${icon('truck')}<span>${state.routeOptimized ? 'Optimised route · ' + routeStats().distance + ' km' : 'Baseline route · 14.2 km'}</span>`;
  }

  function renderStops() {
    const { active, skipped } = activeOrder();
    const host = $('#stopList');
    if (!host) return;
    host.innerHTML = active.map((b, i) => `
      <li class="stop-item" style="animation-delay:${i * 40}ms">
        <span class="stop-index">${i + 1}</span>
        <div class="stop-main"><b>${b.name}</b><small>${b.fill}% full · dry + wet</small></div>
        <span class="stop-fill ${b.fill >= 80 ? 'high' : b.fill >= 55 ? 'mid' : 'ok'}">${b.fill}%</span>
      </li>`).join('') + skipped.map((b) => `
      <li class="stop-item skipped">
        <span class="stop-index">—</span>
        <div class="stop-main"><b>${b.name}</b><small>Skipped · under 40%</small></div>
        <span class="stop-fill skip">skip</span>
      </li>`).join('');
    const sub = $('#stopsSub');
    if (sub) sub.textContent = `${active.length} stops · ${skipped.length} skipped`;
  }

  function renderRoute() {
    const { distance, stops, fuel, co2 } = routeStats();
    const chip = $('#routeChip');
    if (chip) chip.textContent = `${distance} km`;
    $('#rmDistance').textContent = distance.toFixed(1);
    $('#rmStops').textContent = stops;
    $('#rmFuel').textContent = fuel.toFixed(1);
    $('#rmCo2').textContent = co2.toFixed(1);
    const sub = $('#routeSub');
    if (sub) sub.textContent = state.routeOptimized ? 'Optimised loop · sensors respected' : 'Baseline municipal loop';
    const mapSub = $('#mapSub');
    if (mapSub) mapSub.textContent = `${stops} bins · ${state.routeOptimized ? 'optimised' : 'baseline'} route ${distance.toFixed(1)} km`;
    const save = $('#routeSave');
    if (save) {
      save.innerHTML = state.routeOptimized
        ? `${icon('spark')}<span>Optimised. Saving <b>4.6 km</b> and <b>1.6 L</b> of diesel per run versus baseline.</span>`
        : `${icon('spark')}<span>Optimise to save <b>4.6 km</b> and <b>1.6 L</b> of diesel per run.</span>`;
    }
    renderMap();
    renderStops();
  }

  async function optimiseRoute() {
    const btn = $('#optimizeBtn');
    if (btn.disabled) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner light"></span> Optimising…`;
    await wait(900);
    state.routeOptimized = true;
    state.skipLow = true;
    $('#skipToggle').setAttribute('aria-checked', 'true');
    renderRoute();
    btn.disabled = false;
    btn.innerHTML = original;
    const t = $('#mapUpdated');
    if (t) t.textContent = 'Updated just now';
    toast('Route optimised', 'OR-Tools style solver dropped 3 low-fill bins. 14.2 km → 9.6 km, 1.6 L diesel saved.');
  }

  async function pingSensors() {
    const btn = $('#pingSensors');
    if (btn.disabled) return;
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> Pinging…`;
    await wait(800);
    BINS.forEach((b) => {
      b.fill = Math.max(8, Math.min(97, b.fill + Math.round(Math.random() * 12 - 5)));
    });
    state.sensorsPinged += 1;
    renderRoute();
    renderHomeBins();
    btn.disabled = false;
    btn.innerHTML = original;
    const t = $('#mapUpdated');
    if (t) t.textContent = `Updated just now · sweep #${state.sensorsPinged}`;
    toast('Sensor sweep complete', '8 bins reported over HTTPS. Fill predictions recalculated for the next 24 hours.');
  }

  /* ---------------------------------------------------------
     Impact
     --------------------------------------------------------- */
  function renderBars(role) {
    const host = $('#barChart');
    if (!host) return;
    const data = ROLE_DATA[role].bars;
    const max = Math.max(...data.map(([r, l]) => r + l));
    host.innerHTML = data.map(([r, l], i) => `
      <div class="bar-col">
        <div class="bar-stack">
          <div class="bar grey" style="height:${(l / max) * 96}%;--d:${i * 40}ms"></div>
          <div class="bar green" style="height:${(r / max) * 96}%;--d:${i * 40 + 40}ms"></div>
        </div>
        <span class="bar-label">${MONTHS[i]}</span>
      </div>`).join('');
  }

  function renderDonut(role) {
    const mix = ROLE_DATA[role].mix;
    const total = mix.reduce((a, b) => a + b, 0);
    const C = 2 * Math.PI * 62;
    let offset = 0;
    const rings = mix.map((v, i) => {
      const len = (v / total) * C;
      const seg = `<circle class="seg-ring" cx="80" cy="80" r="62" stroke="${MIX_META[i].color}" stroke-dasharray="${Math.max(0, len - 2)} ${C - Math.max(0, len - 2)}" stroke-dashoffset="${-offset}"/>`;
      offset += len;
      return seg;
    }).join('');
    const svg = $('#donut');
    svg.innerHTML = `<circle cx="80" cy="80" r="62" stroke="#EDF2ED"/>${rings}`;
    const center = $('#donutTotal');
    if (center) center.textContent = fmt(ROLE_DATA[role].diverted);
    const legend = $('#donutLegend');
    if (legend) {
      legend.innerHTML = mix.map((v, i) => `
        <li><i style="background:${MIX_META[i].color}"></i>${MIX_META[i].label}<b>${v}%</b></li>`).join('');
    }
  }

  function renderSourceScore() {
    const host = $('#sourceList');
    if (!host) return;
    host.innerHTML = SOURCES.map((s) => {
      const score = Math.max(0, Math.min(100, Math.round(100 - s.contamination * 1.5 - s.rejects * 2.0)));
      return `
        <div class="source-row ${s.me ? 'me' : ''}">
          <span class="source-name"><b>${s.name}</b><small>${s.sub}</small></span>
          <span class="source-contam">contam. <b>${s.contamination.toFixed(1)}%</b></span>
          <span class="source-bar"><i style="--s:${score / 100}"></i></span>
          <span class="source-score-val">${score}<small>/100</small></span>
        </div>`;
    }).join('');
  }

  function renderLeaderboard() {
    const host = $('#leaderList');
    if (!host) return;
    host.innerHTML = LEADERS.map((l, i) => `
      <li class="${l.me ? 'me' : ''}">
        <span class="rank">${String(i + 1).padStart(2, '0')}</span>
        <span class="leader-name"><b>${l.name}</b><small>${l.sub}</small></span>
        <span class="leader-bar"><i style="--s:${l.s}"></i></span>
        <span class="leader-value">${l.value} kg</span>
      </li>`).join('');
  }

  function renderLedger() {
    const host = $('#ledgerList');
    if (!host) return;
    host.innerHTML = LEDGER.map((e) => `
      <div class="ledger-item ${e.done ? '' : 'pending'}">
        <span class="ledger-dot">${e.done ? icon('check') : ''}</span>
        <div class="ledger-main">
          <b>${e.title}</b>
          <small>${e.meta}</small>
          <div class="sig-row">
            ${e.sigs.map((s) => `<span class="sig-chip">${icon('check')} ${s}</span>`).join('')}
            <span class="sig-badge">2-of-2</span>
            ${e.pendingAnchor ? '<span class="ledger-pending">next anchor</span>' : ''}
          </div>
          <span class="ledger-hash">${e.hash}</span>
        </div>
      </div>`).join('');

    const anchor = $('#merkleAnchor');
    if (anchor) {
      anchor.innerHTML = `
        <div class="merkle-main">
          <span class="merkle-label">Daily Merkle root · ${MERKLE.day}</span>
          <b>${MERKLE.root}</b>
          <small>Public repo commit ${MERKLE.commit} + OpenTimestamps</small>
          ${MERKLE.pending ? `<small class="merkle-pending">${MERKLE.pending} row${MERKLE.pending === 1 ? '' : 's'} queued for the next daily anchor — not in this root yet.</small>` : ''}
        </div>
        <button class="btn btn-soft btn-sm" data-verify-anchor>${icon('shield')} Verify anchor</button>`;
    }
  }

  function renderImpact(role) {
    const d = ROLE_DATA[role];
    countTo($('#imCarbon'), d.carbon, { decimals: d.carbon < 1000 ? 1 : 0 });
    countTo($('#imDiverted'), d.diverted);
    countTo($('#imValue'), d.value);
    countTo($('#imPickups'), d.pickups);
    const note = $('#impactNote');
    if (note) note.textContent = d.note;
    renderBars(role);
    renderDonut(role);
    renderSourceScore();
    renderLeaderboard();
    renderLedger();
  }

  function setRole(role) {
    if (!ROLE_DATA[role]) return;
    state.role = role;
    $$('.role-btn').forEach((b) => b.classList.toggle('active', b.dataset.role === role));
    $$('.seg').forEach((b) => b.classList.toggle('active', b.dataset.impact === role));
    updateHomeStats();
    renderImpact(role);
  }

  function downloadReport() {
    const d = ROLE_DATA[state.role];
    const rows = [
      ['event_id', 'listing_id', 'material', 'weight_kg', 'buyer', 'co2e_kg', 'hash', 'timestamp'],
      ['E-9041', 'LG-1042', 'PET', '118.4', 'Okhla Recyclers', '225.0', '0x7c1a9e04', '2026-10-18T16:20:00+05:30'],
      ['E-9040', 'LG-1041', 'Cardboard', '338.0', 'Shree Paper Mills', '371.8', '0x2f88b31c', '2026-10-18T15:02:00+05:30'],
      ['E-9039', 'LG-1039', 'Textile', '84.2', 'Panipat Fibres', '303.1', '0x9d0244ae', '2026-10-17T14:40:00+05:30'],
      ['E-9038', 'LG-1036', 'E-waste', '45.6', 'EcoReco Delhi', '136.8', '0x5be7c190', '2026-10-16T11:05:00+05:30'],
      ['E-9037', 'LG-1034', 'Glass', '149.0', 'Hindustan Glass', '59.6', '0x81cc7d2f', '2026-10-15T09:30:00+05:30']
    ];
    const csv = [
      `LoopGrid ESG export — ${state.role} — generated ${new Date().toISOString().slice(0, 10)}`,
      `CO2e avoided (kg),${d.carbon}`,
      `Material diverted (kg),${d.diverted}`,
      `Pickups verified,${d.pickups}`,
      '',
      ...rows.map((r) => r.map((c) => `"${c}"`).join(','))
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `loopgrid-esg-${state.role}-2026-10.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('ESG report exported', 'CSV includes the hash chain for every pickup in this period.');
  }

  /* ---------------------------------------------------------
     Awaaz — voice layer
     Intent parsing mirrors voice_api.py and stays deterministic:
     no LLM sits between a transcript and a safety rule.
     --------------------------------------------------------- */
  const VOICE_MATERIALS = [
    { material: 'PET bottles', sample: 'pet', price: 22, aliases: ['pet', 'paani ki bottle', 'water bottle', 'plastic bottle', 'बोतल', 'पीईटी'] },
    { material: 'Glass jars', sample: 'glass', price: 3, aliases: ['glass', 'kaanch', 'काँच', 'कांच', 'jar'] },
    { material: 'Cardboard', sample: 'cardboard', price: 14, aliases: ['cardboard', 'carton', 'kagaz', 'card board', 'कार्डबोर्ड', 'गत्ता'] },
    { material: 'Textile offcuts', sample: 'textile', price: 18, aliases: ['textile', 'kapda', 'cloth', 'fabric', 'कपड़ा'] },
    { material: 'E-waste', sample: 'ewaste', price: 65, aliases: ['e-waste', 'ewaste', 'electronic', 'charger', 'ई-कचरा'] },
    { material: 'Battery', sample: 'battery', price: 0, aliases: ['battery', 'बैटरी'] },
    { material: 'Food scraps', sample: 'food', price: 4, aliases: ['food', 'wet', 'geela', 'banana', 'compost', 'गीला', 'खाना'] },
    { material: 'Mixed plastic', sample: 'mixed', price: 0, aliases: ['plastic', 'wrapper', 'polythene', 'प्लास्टिक'] }
  ];

  const VOICE_NUM_WORDS = {
    ek: 1, do: 2, teen: 3, char: 4, paanch: 5, panch: 5, chhah: 6, chah: 6,
    saat: 7, aath: 8, nau: 9, das: 10, bees: 20, pachees: 25, tees: 30,
    chalis: 40, pachas: 50, saath: 60, sau: 100, एक: 1, दो: 2, तीन: 3,
    चार: 4, पांच: 5, छह: 6, सात: 7, आठ: 8, नौ: 9, दस: 10,
    बीस: 20, पच्चीस: 25, तीस: 30, चालीस: 40, पचास: 50, साठ: 60
  };

  const VOICE_LOCALITIES = ['sector 12', 'sector 21', 'green park', 'hauz khas', 'saket', 'dwarka', 'vasant kunj', 'okhla', 'iit delhi'];

  const VOICE_LABELS = {
    create_listing: 'Pickup draft', get_status: 'Pickup status',
    confirm_pickup: 'Confirm handoff', explain_item: 'Sorting help', clarify: 'Need one detail'
  };

  function voiceFindMaterial(text) {
    for (const item of VOICE_MATERIALS) {
      if (item.aliases.some((a) => text.includes(a))) return item;
    }
    return null;
  }

  function voiceFindQty(text) {
    const match = text.match(/(\d+(?:\.\d+)?)\s*(?:kilo|kgs?|kg|किलो)/);
    if (match) return Number(match[1]);
    for (const [word, value] of Object.entries(VOICE_NUM_WORDS)) {
      if (new RegExp(`\\b${word}\\b`).test(text)) return value;
    }
    return null;
  }

  function voiceFindLocality(text) {
    if (['sector 12', 'sector 21', 'green park', 'hauz khas', 'saket', 'dwarka', 'vasant kunj', 'okhla', 'iit delhi'].some((w) => text.includes(w))) {
      const locality = VOICE_LOCALITIES.find((w) => text.includes(w));
      if (locality === 'sector 12') return 'Sector 12';
      if (locality === 'iit delhi') return 'IIT Delhi';
      return locality.replace(/\b\w/g, (c) => c.toUpperCase());
    }
    const match = text.match(/sector\s*(\d+)/);
    return match ? `Sector ${match[1]}` : null;
  }

  function voiceFindWhen(text) {
    let day = '';
    if (/\b(kal|tomorrow)\b/.test(text) || text.includes('कल')) day = 'tomorrow';
    else if (/\b(aaj|today)\b/.test(text) || text.includes('आज')) day = 'today';
    const clock = text.match(/(\d{1,2})\s*(?:baje|bje|am|pm|बजे)/);
    const hour = clock ? clock[1] : '';
    if (day && hour) return `${day} ${hour}:00`;
    if (day) return day;
    if (hour) return `${hour}:00`;
    return 'as soon as possible';
  }

  function voiceWhenLabel(when) {
    if (!when) return '—';
    return when
      .replace('tomorrow', 'kal')
      .replace('today', 'aaj')
      .replace('as soon as possible', 'jaldi');
  }

  function voiceBand(price) {
    return price ? [Number((price * 0.85).toFixed(1)), Number((price * 1.15).toFixed(1))] : null;
  }

  function voiceReply(intent, slots) {
    const lang = state.voice.lang;
    const material = slots.material || '';
    const qty = Number(slots.qty_kg || 0);
    const locality = slots.locality || '';
    const when = slots.when || '';
    const band = slots.band || [0, 0];
    const total = [Math.round(band[0] * qty), Math.round(band[1] * qty)];

    if (intent === 'create_listing') {
      if (slots.hazard) {
        if (lang === 'en') return `This is a hazardous stream: ${qty} kg of ${material}. I will request a certified handler. No marketplace listing and no points.`;
        if (lang === 'hi') return `यह खतरनाक कचरा है: ${qty} किलो ${material}. मैं प्रमाणित हैंडलर को अनुरोध भेजूँगा। कोई मार्केटप्लेस लिस्टिंग नहीं और कोई पॉइंट नहीं।`;
        return `Yeh hazardous waste hai: ${qty} kilo ${material}. Main certified handler ko request bhejunga. Koi listing nahi, koi points nahi.`;
      }
      if (lang === 'en') {
        return `${qty} kg of ${material} from ${locality}, ${when}. The band is ₹${bandEdge(band[0])}–${bandEdge(band[1])} per kg, about ₹${fmt(total[0])}–${fmt(total[1])}. Shall I create the pickup?`;
      }
      if (lang === 'hi') {
        return `${qty} किलो ${material}, ${locality}, ${voiceWhenLabel(when)}. भाव ₹${bandEdge(band[0])}–${bandEdge(band[1])} प्रति किलो, कुल ₹${fmt(total[0])}–${fmt(total[1])}. क्या मैं पिकअप बना दूँ?`;
      }
      return `${qty} kilo ${material}, ${locality}, ${voiceWhenLabel(when)}. Rate ₹${bandEdge(band[0])}–${bandEdge(band[1])} per kilo, total ₹${fmt(total[0])}–${fmt(total[1])}. Pickup bana doon?`;
    }

    if (intent === 'get_status') {
      const id = slots.listing_id || 'LG-1043';
      if (lang === 'en') return `${id} was collected at 11:05, delivered at 14:40 and accepted by the buyer at 15:02. The ledger row is intact.`;
      if (lang === 'hi') return `${id} सुबह 11:05 पर उठाया गया, 14:40 पर पहुँचा और 15:02 पर खरीदार ने स्वीकार किया। लेजर पंक्ति सही है।`;
      return `${id} 11:05 baje uthaya gaya, 14:40 par pahuncha aur 15:02 par buyer ne accept kiya. Ledger row intact hai.`;
    }

    if (intent === 'confirm_pickup') {
      if (!slots.pending_task) {
        if (lang === 'en') return 'There is no pickup waiting to confirm. Tell me the material and weight first.';
        if (lang === 'hi') return 'अभी कोई पिकअप पुष्टि के लिए तैयार नहीं है। पहले सामान और वजन बताइए।';
        return 'Abhi koi pickup confirm karne ke liye ready nahi hai. Pehle material aur weight bataiye.';
      }
      if (lang === 'en') return 'Confirmed. I have written the spoken receipt to the ledger.';
      if (lang === 'hi') return 'पुष्टि हो गई। बोली हुई रसीद लेजर में दर्ज कर दी है।';
      return 'Confirm ho gaya. Bola hua receipt ledger mein darj kar diya.';
    }

    if (intent === 'explain_item') {
      if (slots.hazard) {
        if (lang === 'en') return 'This is a hazardous stream. Do not put it in the dry bin. Hand it to a CPCB-registered handler.';
        if (lang === 'hi') return 'यह खतरनाक कचरा है। सूखे कचरे में न डालें। सीपीसीबी पंजीकृत हैंडलर को दें।';
        return 'Yeh hazardous waste hai. Dry bin mein mat daalein. CPCB-registered handler ko dein.';
      }
      if (material) {
        if (lang === 'en') return `${material}: keep it clean and dry. The current band is ₹${bandEdge(band[0])}–${bandEdge(band[1])} per kg.`;
        if (lang === 'hi') return `${material}: साफ और सूखा रखें। अभी भाव ₹${bandEdge(band[0])}–${bandEdge(band[1])} प्रति किलो है।`;
        return `${material}: saaf aur sookha rakhein. Abhi rate ₹${bandEdge(band[0])}–${bandEdge(band[1])} per kilo hai.`;
      }
    }

    if (lang === 'en') return "I'm not sure. Can you repeat the material and the weight?";
    if (lang === 'hi') return 'मुझे पक्का नहीं पता। क्या आप दोबारा बता सकते हैं — कौन सा सामान और कितने किलो?';
    return 'Mujhe pakka nahi pata. Kya aap dobara bata sakte hain — kaun sa material aur kitne kilo?';
  }

  function parseVoiceIntent(raw) {
    const lang = state.voice.lang;
    const text = String(raw || '').trim().toLowerCase();
    const pendingTask = Boolean(state.voice.pending);

    const statusMatch = text.match(/(lg-\d{3,6})/);
    if (statusMatch || ['status', 'kahan', 'track', 'where is'].some((w) => text.includes(w))) {
      const slots = { listing_id: statusMatch ? statusMatch[1].toUpperCase() : 'LG-1043', pending_task: pendingTask };
      return { intent: 'get_status', confidence: 0.9, slots, tools: ['get_status'], reply: voiceReply('get_status', slots) };
    }

    const confirmTokens = new Set(['haan', 'ha', 'confirm', 'theek', 'ok', 'accept', 'हाँ', 'ठीक']);
    const words = text.replace(/[.,!?।]/g, '').split(/\s+/).filter(Boolean);
    if (words.length <= 6 && words.some((w) => confirmTokens.has(w))) {
      const slots = { pending_task: pendingTask };
      return {
        intent: 'confirm_pickup',
        confidence: pendingTask ? 0.88 : 0.4,
        slots,
        tools: pendingTask ? ['confirm_pickup', 'append_ledger'] : [],
        reply: voiceReply('confirm_pickup', slots)
      };
    }

    const found = voiceFindMaterial(text);
    const qty = voiceFindQty(text);
    const locality = voiceFindLocality(text);
    const when = voiceFindWhen(text);
    const hazard = Boolean(found && (found.sample === 'ewaste' || found.sample === 'battery'));
    const band = found && !hazard ? voiceBand(found.price) : null;

    if (found && ['kaise', 'why', 'explain', 'bin', 'sort', 'कैसे', 'कौन सा'].some((w) => text.includes(w))) {
      const slots = { material: found.material, sample: found.sample, band, hazard };
      return { intent: 'explain_item', confidence: 0.8, slots, tools: ['explain_item'], reply: voiceReply('explain_item', slots) };
    }

    if (found && qty) {
      const confidence = locality && when !== 'as soon as possible' ? 0.92 : locality ? 0.85 : 0.72;
      const slots = {
        material: found.material,
        sample: found.sample,
        qty_kg: qty,
        locality: locality || 'Green Park',
        when,
        price_per_kg: hazard ? 0 : found.price,
        band,
        hazard,
        pending_task: pendingTask
      };
      return {
        intent: 'create_listing',
        confidence,
        slots,
        tools: ['create_listing', 'get_matches'],
        reply: voiceReply('create_listing', slots)
      };
    }

    const confidence = found ? 0.45 : 0.2;
    const slots = { material: found ? found.material : null, qty_kg: qty, locality, when, band, pending_task: pendingTask };
    return { intent: 'clarify', confidence, slots, tools: [], reply: voiceReply('clarify', slots) };
  }

  /* ---- status + provider ---------------------------------- */
  function voiceProviderLabel() {
    if (state.voice.mode === 'elevenlabs') return 'ElevenLabs ready';
    if (state.voice.mode === 'mock') return 'Mock voice API';
    if (state.voice.mode === 'server-missing') return 'Server key missing';
    if (state.voice.mode === 'offline') return 'Gateway offline';
    return 'Browser voice';
  }

  function voiceRestoreStatus() {
    const live = state.voice.mode === 'elevenlabs' || state.voice.mode === 'mock';
    voiceSetStatus(live ? 'live' : 'fallback', voiceProviderLabel());
  }

  function voiceSetStatus(kind, label) {
    const el = $('#voiceStatus');
    if (!el) return;
    el.className = `voice-status${kind ? ' ' + kind : ''}`;
    const span = el.querySelector('span');
    if (span) span.textContent = label;
  }

  function voiceNormalizeBase(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  async function fetchWithTimeout(url, options = {}, ms = 6000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function checkVoiceHealth(manual = false) {
    const base = voiceNormalizeBase(state.voice.base);
    if (!base) {
      state.voice.mode = 'browser';
      voiceSetStatus('fallback', 'Browser voice');
      const note = $('#voiceConfigNote');
      if (note) note.textContent = 'No gateway set. Falling back to the browser voice, then to text.';
      if (manual) toast('Browser voice', 'Add a FastAPI gateway URL to use ElevenLabs. The key must stay on that server.', 'warn');
      return;
    }
    try {
      const res = await fetchWithTimeout(`${base}/api/voice/health`, {}, 5000);
      const data = await res.json();
      if (data.configured) {
        state.voice.mode = data.provider === 'mock' ? 'mock' : 'elevenlabs';
        voiceSetStatus('live', voiceProviderLabel());
        const note = $('#voiceConfigNote');
        if (note) {
          note.textContent = `Connected · ${data.tts_model || 'TTS'} + ${data.stt_model || 'STT'} · ${fmt(data.daily_char_cap || 0)} chars/day cap.`;
        }
        if (manual) toast('Voice gateway ready', `${data.provider === 'mock' ? 'Mock mode' : 'ElevenLabs'} · key stays server-side.`);
      } else {
        state.voice.mode = 'server-missing';
        voiceSetStatus('fallback', 'Server key missing');
        const note = $('#voiceConfigNote');
        if (note) note.textContent = 'The gateway is running without ELEVENLABS_API_KEY. Set it on the server and restart.';
        if (manual) toast('No server key', 'Set ELEVENLABS_API_KEY on the FastAPI host. Never put it in this page.', 'warn');
      }
    } catch (_) {
      state.voice.mode = 'offline';
      voiceSetStatus('fallback', 'Gateway offline');
      const note = $('#voiceConfigNote');
      if (note) note.textContent = 'Could not reach the gateway. Browser voice is used instead.';
      if (manual) toast('Gateway unreachable', 'Start it with: uvicorn voice_api:app --port 8000', 'warn');
    }
  }

  /* ---- speaking ------------------------------------------- */
  let currentAudio = null;
  let currentUtterance = null;

  function stopSpeaking() {
    if (currentAudio) {
      try { currentAudio.pause(); } catch (_) { /* ignore */ }
      currentAudio = null;
    }
    if ('speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch (_) { /* ignore */ }
    }
    currentUtterance = null;
  }

  function browserSpeak(text, lang) {
    if (!('speechSynthesis' in window)) return false;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = lang === 'en' ? 'en-IN' : 'hi-IN';
      utter.rate = 0.98;
      utter.pitch = 1;
      const voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
      const exact = voices.find((v) => (v.lang || '').toLowerCase() === utter.lang.toLowerCase());
      const near = voices.find((v) => (v.lang || '').toLowerCase().startsWith(lang === 'en' ? 'en' : 'hi'));
      if (exact || near) utter.voice = exact || near;
      currentUtterance = utter;
      utter.onend = () => { currentUtterance = null; };
      window.speechSynthesis.speak(utter);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function voiceSpeak(text, lang = state.voice.lang, quality = 'flash') {
    const clean = String(text || '').trim();
    if (!clean) return false;
    stopSpeaking();
    const base = voiceNormalizeBase(state.voice.base);

    if (base) {
      try {
        const res = await fetchWithTimeout(`${base}/api/voice/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: clean, lang: lang === 'en' ? 'en' : 'hi', quality })
        }, 30000);
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 0) {
            const url = URL.createObjectURL(blob);
            const audio = new Audio(url);
            currentAudio = audio;
            audio.addEventListener('ended', () => { URL.revokeObjectURL(url); currentAudio = null; });
            try {
              await audio.play();
              return true;
            } catch (_) {
              URL.revokeObjectURL(url);
              currentAudio = null;
            }
          }
        }
      } catch (_) { /* fall through to browser */ }
    }
    return browserSpeak(clean, lang);
  }

  /* ---- recording + transcription -------------------------- */
  let mediaRecorder = null;
  let mediaStream = null;
  let recordedChunks = [];
  let recordTimer = null;
  let browserRecognition = null;

  function voiceHintText() {
    return state.voice.lang === 'en'
      ? 'English mode. Audio is processed on the server and never stored.'
      : 'Hindi, Hinglish ya English. Audio server par store nahi hota.';
  }

  function voiceRecordingUI(on) {
    const btn = $('#micBtn');
    const wave = $('#voiceWave');
    const label = $('#micLabel');
    const hint = $('#voiceHint');
    if (btn) btn.setAttribute('aria-pressed', String(on));
    if (wave) wave.classList.toggle('active', on);
    if (label) label.textContent = on ? 'Sun rahe hain…' : 'Tap to speak';
    if (hint) hint.textContent = on ? 'Bolna shuru karein. 12 second tak.' : voiceHintText();
  }

  function stopVoiceCapture() {
    if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; }
    if (browserRecognition) {
      try { browserRecognition.stop(); } catch (_) { /* ignore */ }
      return;
    }
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      try { mediaRecorder.stop(); } catch (_) { /* ignore */ }
    }
  }

  function startBrowserRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      state.voice.recording = false;
      voiceRecordingUI(false);
      toast('No microphone API', 'Type the request instead. The gateway route still works.', 'warn');
      const input = $('#voiceText');
      if (input) input.focus();
      return;
    }
    try {
      const rec = new SR();
      browserRecognition = rec;
      state.voice.recording = true;
      voiceRecordingUI(true);
      rec.lang = state.voice.lang === 'en' ? 'en-IN' : 'hi-IN';
      rec.interimResults = true;
      rec.continuous = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        let interim = '';
        let final = '';
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const chunk = event.results[i][0].transcript;
          if (event.results[i].isFinal) final += chunk;
          else interim += chunk;
        }
        const input = $('#voiceText');
        if (input) input.value = (final || interim).trim();
      };
      rec.onerror = (event) => {
        state.voice.recording = false;
        voiceRecordingUI(false);
        browserRecognition = null;
        const denied = event.error === 'not-allowed' || event.error === 'service-not-allowed';
        toast(denied ? 'Microphone blocked' : 'Did not catch that', denied ? 'Allow microphone access, or type the request.' : 'Try again, or type the request.', 'warn');
      };
      rec.onend = () => {
        const wasRecording = state.voice.recording;
        state.voice.recording = false;
        voiceRecordingUI(false);
        browserRecognition = null;
        const input = $('#voiceText');
        const text = input ? input.value.trim() : '';
        if (wasRecording && text) runVoiceIntent(text);
      };
      rec.start();
    } catch (_) {
      state.voice.recording = false;
      voiceRecordingUI(false);
      toast('Microphone unavailable', 'Type the request instead.', 'warn');
    }
  }

  async function transcribeAndRun(blob) {
    const base = voiceNormalizeBase(state.voice.base);
    if (!base) { startBrowserRecognition(); return; }
    voiceSetStatus('live', 'Transcribing…');
    try {
      const form = new FormData();
      form.append('audio', blob, 'voice.webm');
      form.append('lang', state.voice.lang);
      const res = await fetchWithTimeout(`${base}/api/voice/stt`, { method: 'POST', body: form }, 45000);
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.text) throw new Error('stt');
      const input = $('#voiceText');
      if (input) input.value = data.text;
      voiceSetStatus('live', data.provider === 'mock' ? 'Mock transcript' : 'ElevenLabs Scribe');
      runVoiceIntent(data.text);
    } catch (_) {
      state.voice.recording = false;
      voiceRecordingUI(false);
      voiceSetStatus('fallback', voiceProviderLabel());
      toast('Could not transcribe', 'Type the same sentence below — the intent parser still runs.', 'warn');
      const input = $('#voiceText');
      if (input) input.focus();
    }
  }

  async function startMediaRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
      startBrowserRecognition();
      return;
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      recordedChunks = [];
      const mime = window.MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      mediaRecorder = mime ? new MediaRecorder(mediaStream, { mimeType: mime }) : new MediaRecorder(mediaStream);
      mediaRecorder.ondataavailable = (event) => { if (event.data && event.data.size) recordedChunks.push(event.data); };
      mediaRecorder.onstop = () => {
        if (recordTimer) { clearTimeout(recordTimer); recordTimer = null; }
        if (mediaStream) {
          mediaStream.getTracks().forEach((track) => track.stop());
          mediaStream = null;
        }
        state.voice.recording = false;
        voiceRecordingUI(false);
        const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        mediaRecorder = null;
        if (blob.size > 0) transcribeAndRun(blob);
        else toast('Nothing recorded', 'Hold the mic a little longer, or type the request.', 'warn');
      };
      mediaRecorder.start();
      state.voice.recording = true;
      voiceRecordingUI(true);
      recordTimer = setTimeout(stopVoiceCapture, 12000);
    } catch (_) {
      toast('Microphone blocked', 'Allow access, or use the browser/typed fallback.', 'warn');
      startBrowserRecognition();
    }
  }

  function voiceToggleMic() {
    if (state.voice.recording) { stopVoiceCapture(); return; }
    if (!state.voice.consent) {
      toast('Consent needed', 'Tick the DPDP consent box before speaking. The transcript is kept; the audio is not.', 'warn');
      const box = $('#voiceConsent');
      if (box) box.focus();
      return;
    }
    if (voiceNormalizeBase(state.voice.base)) startMediaRecording();
    else startBrowserRecognition();
  }

  /* ---- result rendering + tools --------------------------- */
  function voiceSlotRows(data) {
    const slots = data.slots || {};
    if (data.intent === 'get_status') {
      return [['Listing', slots.listing_id || 'LG-1043'], ['Ledger', 'Co-signed · intact']];
    }
    const rows = [
      ['Material', slots.material || '—'],
      ['Weight', slots.qty_kg ? `${slots.qty_kg} kg` : '—'],
      ['Locality', slots.locality || '—'],
      ['When', voiceWhenLabel(slots.when)]
    ];
    if (slots.band && slots.band[1]) rows.push(['Rate band', `₹${bandEdge(slots.band[0])}–${bandEdge(slots.band[1])}/kg`]);
    return rows;
  }

  function renderVoiceResult(data, extra = {}) {
    const body = $('#voiceResultBody');
    const empty = $('#voiceEmpty');
    if (!body || !empty) return;
    empty.hidden = true;
    body.hidden = false;

    const low = (data.confidence || 0) < 0.7;
    const warn = low || data.intent === 'clarify' || data.slots?.hazard;
    const pct = Math.round((data.confidence || 0) * 100);
    const created = extra.created || null;
    const receipt = extra.receipt || null;

    const actions = [];
    if (data.intent === 'create_listing' && !created && !low) {
      actions.push(`<button class="btn btn-primary" data-voice-create>${icon('check')} Create pickup</button>`);
    }
    if (data.intent === 'get_status') {
      actions.push(`<button class="btn btn-outline" data-nav="impact">${icon('shield')} Open ledger</button>`);
    }
    if (state.voice.pending && !receipt) {
      actions.push(`<button class="btn btn-primary" data-voice-confirm>${icon('shield')} Co-sign &amp; ledger it</button>`);
    }
    if (!receipt) {
      actions.push(`<button class="btn btn-ghost" data-voice-say>${icon('volume')} Say it back</button>`);
    }

    body.innerHTML = `
      <div class="voice-result-head">
        <span class="intent-badge ${warn ? 'warn' : ''}">${VOICE_LABELS[data.intent] || 'Result'}</span>
        <span class="conf-badge ${low ? 'low' : ''}">${pct}% confidence · gate 70%</span>
      </div>
      <p class="voice-reply ${warn ? 'warn' : ''}">${esc(data.reply)}</p>
      ${low ? `<p class="status-line">${icon('alert')} Below the confidence gate. Nothing was created or routed — repeat the material and weight.</p>` : ''}
      ${data.slots?.hazard ? `<p class="status-line">${icon('alert')} Hazardous routing is decided by LoopGrid’s rule engine, not by the voice model. No marketplace listing.</p>` : ''}
      ${created ? `<p class="status-line">${icon('check')} ${esc(created.label)}</p>` : ''}
      <div class="slot-grid">
        ${voiceSlotRows(data).map(([k, v]) => `<div class="slot"><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}
      </div>
      <div class="tool-row">
        ${(data.tools || []).map((t) => `<span class="tool-chip">${esc(t)}()</span>`).join('') || '<span class="tool-chip">no tool called</span>'}
        <span class="tool-chip">rule-based</span>
      </div>
      <div class="status-line">${icon('shield')} Transcript only. No raw audio is written to disk, and a low-confidence result never guesses.</div>
      ${receipt ? `
        <div class="receipt" id="voiceReceipt">
          <div class="receipt-head"><b>Spoken receipt</b><span class="chip good">Ledger row</span></div>
          <p>${esc(receipt.text)}</p>
          <code class="receipt-hash">sha256 0x${receipt.hash.slice(0, 10)}…${receipt.hash.slice(-6)}</code>
          <p class="receipt-note">Only this receipt <b>text</b> is hashed and ledgered. The audio is never hashed or stored. Queued for the next daily anchor, not today’s root.</p>
        </div>` : ''}
      ${actions.length ? `<div class="voice-actions">${actions.join('')}</div>` : ''}
    `;
    body.classList.remove('voice-in');
    void body.offsetWidth;
    body.classList.add('voice-in');
  }

  async function sha256Hex(text) {
    try {
      if (window.crypto && window.crypto.subtle && window.TextEncoder) {
        const bytes = new TextEncoder().encode(text);
        const digest = await window.crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) { /* fall through */ }
    let a = 0x811c9dc5;
    let b = 0x01000193;
    const out = [];
    for (let i = 0; i < 32; i += 1) {
      a ^= text.charCodeAt(i % Math.max(1, text.length)) || i;
      a = Math.imul(a, 16777619) >>> 0;
      b = Math.imul(b ^ a, 2246822519) >>> 0;
      out.push(((a ^ b) >>> 0).toString(16).padStart(8, '0'));
    }
    return out.join('').slice(0, 64);
  }

  async function runVoiceIntent(raw) {
    const text = String(raw || '').trim();
    if (!text) {
      toast('Kuch likhein', 'Type a request such as “40 kilo PET Sector 12 kal 6 baje”.', 'warn');
      return;
    }
    if (state.voice.busy) return;
    state.voice.busy = true;
    const send = $('#voiceSend');
    if (send) { send.disabled = true; send.innerHTML = '<span class="spinner light"></span> Samajh rahe hain…'; }
    try {
      await wait(320);
      const data = parseVoiceIntent(text);
      state.voice.last = data;
      renderVoiceResult(data);
      const spoke = await voiceSpeak(data.reply);
      if (!spoke) {
        voiceSetStatus('fallback', 'Transcript only');
        const note = $('#voiceConfigNote');
        if (note) note.textContent = 'No audio output available. The caption above is the full reply.';
      }
      /* "Haan" is an instruction, not just a sentence. Execute it only when a
         pending pickup exists and the parser crosses the same 70% gate. */
      if (data.intent === 'confirm_pickup' && data.confidence >= 0.7 && state.voice.pending) {
        await wait(600);
        await voiceConfirmHandoff();
      }
    } finally {
      state.voice.busy = false;
      voiceRestoreStatus();
      if (send) { send.disabled = false; send.innerHTML = `${icon('spark')} Samjho`; }
    }
  }

  function voiceCreateListing() {
    const data = state.voice.last;
    if (!data || data.intent !== 'create_listing') return;
    if ((data.confidence || 0) < 0.7) {
      toast('Below the gate', 'Confidence is under 70%, so nothing is created. Repeat the material and weight.', 'warn');
      return;
    }
    if (state.voice.pending) {
      toast('Pickup already open', `${state.voice.pending.listingId} is waiting for the handoff confirmation.`, 'warn');
      return;
    }
    const s = data.slots;
    const sample = SAMPLES[s.sample];
    state.voice.created += 1;
    const id = nextListingId();
    const hazard = Boolean(s.hazard);

    if (hazard) {
      state.voice.pending = {
        listingId: id, kind: 'hazard', material: s.material, qty: s.qty_kg,
        locality: s.locality, when: s.when, band: s.band
      };
      ACTIVITY.unshift({ icon: '☣️', text: `Voice request <b>${id}</b> · ${s.material} routed to a certified handler`, time: 'Just now' });
      renderActivity();
      renderVoiceResult(data, { created: { label: `${id} · certified pickup requested. No points, no marketplace listing.` } });
      toast('Certified pickup requested', `${s.material} · ${s.qty_kg} kg. A CPCB-registered handler handles this stream.`, 'warn');
      voiceSpeak(`Certified pickup ${id} requested for ${s.qty_kg} kilos of ${s.material}. No marketplace listing.`, 'en');
      return;
    }

    const meta = MAT_META[s.material] || { category: sample?.category || 'Plastic', emoji: sample?.emoji || '♻️', thumb: sample?.thumb || 'plastic' };
    const price = Number(s.price_per_kg || 0);
    const listing = {
      id,
      material: s.material,
      category: meta.category,
      emoji: meta.emoji,
      thumb: meta.thumb,
      qty: Number(s.qty_kg),
      price,
      locality: s.locality,
      distance: 0.4,
      seller: 'Green Park Society',
      verified: true,
      score: sample?.mrs || 88,
      posted: 'Just now',
      fresh: Date.now(),
      status: 'Listed',
      co2: Math.round(Number(s.qty_kg) * (sample?.co2 || 0)),
      note: `Created by Awaaz · ${textSafe(data.reply)}`
    };
    state.listings.unshift(listing);
    const earned = sample?.points || 20;
    state.points += earned;
    ROLE_DATA.household.carbon = +(ROLE_DATA.household.carbon + (sample?.co2 || 0)).toFixed(1);
    state.carbon = ROLE_DATA.household.carbon;
    ACTIVITY.unshift({ icon: '🎙️', text: `Voice request → <b>${id}</b> · ${s.material} ${s.qty_kg} kg`, time: 'Just now' });

    state.voice.pending = {
      listingId: id, kind: 'handoff', material: s.material, qty: s.qty_kg,
      locality: s.locality, when: s.when, band: s.band, points: earned
    };

    updateHomeStats();
    renderActivity();
    renderMarket();
    renderImpact(state.role);
    markOnboard(1);
    if (state.onboard[0]) markOnboard(0);

    renderVoiceResult(data, { created: { label: `${id} created · ${s.qty_kg} kg · 3 verified buyer matches · +${earned} points.` } });
    toast('Pickup created', `${id} · ${s.material} · ${s.qty_kg} kg. Confirm the handoff to co-sign the ledger.`);
    voiceSpeak(`${id} created. ${s.qty_kg} kilos of ${s.material}, ${s.locality}. Three verified buyer matches. Say haan to confirm the handoff.`, state.voice.lang);
  }

  function textSafe(str) {
    return String(str || '').replace(/\s+/g, ' ').slice(0, 180);
  }

  async function voiceConfirmHandoff() {
    const p = state.voice.pending;
    if (!p) {
      toast('Nothing to confirm', 'Create a pickup first, then say “haan”.', 'warn');
      return;
    }
    const label = p.kind === 'hazard' ? 'Certified pickup' : 'Handoff';
    const stamp = new Date().toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const receiptText = `${label} ${p.listingId} · ${p.material} · ${p.qty} kg · ${p.locality} · ${voiceWhenLabel(p.when)} · co-signed by Ananya R. and Rafiq K. · ${stamp}`;
    const hash = await sha256Hex(receiptText);
    const compact = `0x${hash.slice(0, 4)}…${hash.slice(-4)}`;

    LEDGER.unshift({
      title: p.kind === 'hazard' ? 'Certified pickup co-signed' : 'Voice handoff co-signed',
      meta: `Ananya R. + Rafiq K. · ${p.qty} kg ${p.material} · ${stamp}`,
      hash: compact,
      sigs: ['Ananya R.', 'Rafiq K.'],
      done: true,
      pendingAnchor: true,
      receipt: receiptText
    });
    MERKLE.rows += 1;
    MERKLE.pending = (MERKLE.pending || 0) + 1;

    if (p.kind !== 'hazard') {
      const today = new Date().toISOString().slice(0, 10);
      const streak = state.voice.streak;
      if (streak.lastDay !== today) {
        streak.lastDay = today;
        streak.handoffs = Math.min(4, streak.handoffs + 1);
        const monthJustCompleted = streak.handoffs >= 4 && streak.months < 3;
        if (monthJustCompleted) streak.months += 1;
        renderStreak();
        if (monthJustCompleted) {
          toast('Monthly streak met', `4 verified handoffs. Month ${streak.months} pilot reward unlocked — paid from the capped pool.`);
        } else {
          toast('Verified handoff counted', `${streak.handoffs}/4 this month. One handoff per day counts.`);
        }
      }
    }

    state.voice.pending = null;
    renderLedger();

    const data = state.voice.last || { intent: 'confirm_pickup', confidence: 0.88, slots: {}, tools: ['confirm_pickup', 'append_ledger'], reply: voiceReply('confirm_pickup', { pending_task: true }) };
    const lang = state.voice.lang;
    const reply = p.kind === 'hazard'
      ? (lang === 'en'
        ? 'Certified pickup confirmed. The receipt is in the ledger; no points are awarded for hazardous waste.'
        : lang === 'hi'
          ? 'प्रमाणित पिकअप की पुष्टि हो गई। रसीद लेजर में है; खतरनाक कचरे पर कोई पॉइंट नहीं मिलता।'
          : 'Certified pickup confirm ho gaya. Receipt ledger mein hai; hazardous waste par koi points nahi.')
      : (lang === 'en'
        ? 'Haan. Handoff confirmed by both sides and the spoken receipt is in the ledger.'
        : lang === 'hi'
          ? 'हाँ। दोनों पक्षों ने हस्ताक्षर किए और बोली हुई रसीद लेजर में दर्ज है।'
          : 'Haan. Dono taraf ne sign kiya aur bola hua receipt ledger mein darj hai.');
    renderVoiceResult({
      ...data,
      intent: 'confirm_pickup',
      confidence: 0.88,
      slots: { ...data.slots, listing_id: p.listingId },
      tools: ['confirm_pickup', 'append_ledger'],
      reply
    }, { receipt: { text: receiptText, hash } });

    toast('Ledger row co-signed', `${p.listingId} · ${compact}. Queued for the next daily anchor.`);
    voiceSpeak(receiptText, 'en');
  }

  /* ---- coach, bin voices, story --------------------------- */
  const COACH = {
    pet: {
      hi: 'यह पीईटी बोतल है। ढक्कन अलग करें, अंदर से धोएं और सुखाएं। नीली बिन में डालें। भाव ₹22 प्रति किलो।',
      hinglish: 'Yeh PET bottle hai. Cap alag karein, andar se dho kar sukha lein. Blue bin. ₹22/kg.',
      en: 'This is a PET bottle. Remove the cap, rinse and dry it, then put it in the blue bin. About ₹22 per kg.'
    },
    cardboard: {
      hi: 'यह कार्डबोर्ड है। चपटा करें और सूखा रखें। गीला कार्डबोर्ड पूरा बंडल “मिक्स” कर देता है। नीली बिन।',
      hinglish: 'Yeh cardboard hai. Chapta karein aur sookha rakhein. Geela cardboard poora bundle mix kar deta hai. Blue bin.',
      en: 'This is cardboard. Flatten it and keep it dry. One wet corner downgrades the whole bundle. Blue bin.'
    },
    food: {
      hi: 'यह गीला कचरा है। प्लास्टिक थैली निकालें। हरी बिन में डालें। छह हफ्ते में खाद बनता है।',
      hinglish: 'Yeh geela kachra hai. Plastic thaili nikaalein. Green bin. Chhah hafte mein compost banta hai.',
      en: 'This is food waste. Remove the plastic bag and use the green bin. It becomes compost in about six weeks.'
    },
    glass: {
      hi: 'यह कांच की बोतल है। ढक्कन हटाएं और धोएं। टूटा कांच कागज में लपेटें। नीली बिन।',
      hinglish: 'Yeh kaanch ki bottle hai. Lid hataayein aur dho lein. Toota kaanch kagaz mein lapetein. Blue bin.',
      en: 'This is glass. Remove the lid, rinse it, and wrap broken pieces in paper before the blue bin.'
    },
    ewaste: {
      hi: 'यह ई-कचरा है। सूखे कचरे में न डालें। डेटा मिटाएं और सीपीसीबी पंजीकृत हैंडलर को दें। कोई पॉइंट नहीं।',
      hinglish: 'Yeh e-waste hai. Dry bin mein mat daalein. Data wipe karein aur CPCB-registered handler ko dein. No points.',
      en: 'This is e-waste. Never put it in the dry bin. Wipe your data and hand it to a CPCB-registered handler. No points.'
    },
    textile: {
      hi: 'यह कपड़े का कतरन है। सूखा रखें और रेशे के हिसाब से अलग करें। सफेद बोरी में डालें।',
      hinglish: 'Yeh kapde ka katran hai. Sookha rakhein aur fibre ke hisaab se alag karein. White sack.',
      en: 'This is textile offcut. Keep it dry and sort by fibre. It goes in the white sack, not the wet bin.'
    }
  };

  const BIN_VOICE = {
    dry: {
      hi: 'यह सूखी बिन है। साफ, सूखा प्लास्टिक, कागज और कांच यहाँ। गीला कचरा नहीं।',
      hinglish: 'Yeh dry bin hai. Saaf, sookha plastic, paper aur glass yahan. Geela kachra nahi.',
      en: 'This is the dry bin. Clean, dry plastic, paper and glass only. No wet waste.'
    },
    wet: {
      hi: 'यह गीली बिन है। खाने का कचरा यहाँ। प्लास्टिक की थैली नहीं।',
      hinglish: 'Yeh wet bin hai. Khane ka kachra yahan. Plastic ki thaili nahi.',
      en: 'This is the wet bin. Food waste only. No plastic bags.'
    },
    hazard: {
      hi: 'खतरा। बैटरी, ई-कचरा और सैनिटरी कचरा यहाँ नहीं। प्रमाणित हैंडलर को दें।',
      hinglish: 'Khatra. Battery, e-waste aur sanitary kachra yahan nahi. Certified handler ko dein.',
      en: 'Hazardous waste. Batteries, e-waste and sanitary waste do not go here. Use a certified handler.'
    }
  };

  function coachText(key) {
    const entry = COACH[key];
    if (!entry) return COACH.pet[state.voice.lang] || COACH.pet.hinglish;
    return entry[state.voice.lang] || entry.hinglish;
  }

  function renderCoach() {
    const pick = $('#coachPick');
    const line = $('#coachLine');
    if (!pick || !line) return;
    line.textContent = coachText(pick.value);
  }

  function scanGuideText(key) {
    if (COACH[key]) return coachText(key);
    const s = SAMPLES[key] || SAMPLES.unknown;
    if (s.hazard) {
      if (state.voice.lang === 'hi') return `${s.name} खतरनाक है। सूखे कचरे में न डालें। सीपीसीबी पंजीकृत हैंडलर को दें। कोई पॉइंट नहीं।`;
      if (state.voice.lang === 'en') return `${s.name} is hazardous. Keep it out of the dry bin and hand it to a CPCB-registered handler. No points.`;
      return `${s.name} hazardous hai. Dry bin mein mat daalein. CPCB-registered handler ko dein. No points.`;
    }
    if (s.warn) {
      if (state.voice.lang === 'hi') return `${s.name} के लिए दिल्ली में कोई भरोसेमंद रीसाइक्लिंग स्ट्रीम नहीं है। सूखी बिन में न डालें।`;
      if (state.voice.lang === 'en') return `${s.name} has no viable Delhi recycling stream. Keep it out of the dry bin.`;
      return `${s.name} ke liye Delhi mein koi viable stream nahi hai. Dry bin mein mat daalein.`;
    }
    if (s.unknown) {
      if (state.voice.lang === 'hi') return 'यह वस्तु पहचान में नहीं आई। कुछ भी अपने आप रूट नहीं होगा। सामग्री खुद चुनें।';
      if (state.voice.lang === 'en') return 'This item is outside the known classes. Nothing is routed automatically. Pick the material manually.';
      return 'Yeh item pehchan mein nahi aaya. Kuch bhi auto-route nahi hoga. Material khud chunein.';
    }
    return state.voice.lang === 'en' ? `${s.name}. ${s.bin}. ${s.tip}` : `${s.name}. ${s.bin}.`;
  }

  async function playScanGuide() {
    const key = state.scanKey || state.lastResult;
    if (!key) return;
    const line = scanGuideText(key);
    toast('Awaaz', line);
    await voiceSpeak(line, state.voice.lang);
  }

  function storyText() {
    const d = ROLE_DATA[state.role];
    const carbon = state.role === 'household' ? fmt(d.carbon, 1) : fmt(d.carbon);
    if (state.voice.lang === 'en') {
      return `This quarter, ${d.note.split('·')[0].trim()} diverted ${fmt(d.diverted)} kilos, avoided ${carbon} kilos of CO2 equivalent, and completed ${fmt(d.pickups)} verified pickups. Every row is co-signed by both sides.`;
    }
    if (state.voice.lang === 'hi') {
      return `इस तिमाही ${fmt(d.diverted)} किलो कचरा डायवर्ट हुआ, ${carbon} किलो CO2e बचा, और ${fmt(d.pickups)} वेरिफाइड पिकअप पूरे हुए। हर पंक्ति दोनों पक्षों के हस्ताक्षर से जुड़ी है।`;
    }
    return `Is quarter ${fmt(d.diverted)} kilo waste divert hua, ${carbon} kilo CO2e bacha, aur ${fmt(d.pickups)} verified pickups poore hue. Har row dono taraf ke signature se judi hai.`;
  }

  async function playStory() {
    const line = storyText();
    const caption = $('#storyCaption');
    if (caption) { caption.hidden = false; caption.textContent = line; }
    toast('Awaaz · monthly story', line);
    await voiceSpeak(line, state.voice.lang, 'high');
  }

  function renderStreak() {
    const s = state.voice.streak;
    const count = $('#streakCount');
    const label = $('#streakMonthsLabel');
    if (count) count.textContent = `${Math.min(4, s.handoffs)}/4`;
    if (label) label.textContent = `${s.months} month${s.months === 1 ? '' : 's'} completed`;
    $$('#streakMonths span').forEach((el, i) => el.classList.toggle('on', i < s.months));
  }

  function initVoice() {
    const api = $('#voiceApi');
    if (api) api.value = state.voice.base;
    state.voice.consent = Boolean($('#voiceConsent')?.checked);
    renderCoach();
    renderStreak();
    voiceSetStatus('', 'Checking voice…');
    checkVoiceHealth(false);
  }

  /* ---------------------------------------------------------
     Events
     --------------------------------------------------------- */
  function bindEvents() {
    document.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) {
        e.preventDefault();
        navigate(nav.dataset.nav);
        return;
      }
      if (e.target.closest('[data-enter-app]')) {
        closeModal();
        enterApp('home');
        setTimeout(() => toast('Demo mode', 'Classifier and sensors are simulated. Every other screen is interactive.'), 600);
        return;
      }
      if (e.target.closest('[data-exit-app]')) { exitApp(); return; }
      if (e.target.closest('[data-open-sidebar]')) { openSidebar(); return; }
      if (e.target.closest('[data-close-sidebar]')) { closeSidebar(); return; }
      if (e.target.closest('[data-close-modal]')) { closeModal(); return; }
      if (e.target.closest('[data-tour]')) { openModal('modalTour'); return; }
      if (e.target.closest('[data-open-listing]')) { openModal('modalNew'); return; }
      if (e.target.closest('[data-streak-info]')) { openModal('modalStreak'); return; }
      if (e.target.closest('[data-story]')) { playStory(); return; }
      if (e.target.closest('[data-scan-listen]')) { playScanGuide(); return; }
      if (e.target.closest('[data-voice-create]')) { voiceCreateListing(); return; }
      if (e.target.closest('[data-voice-confirm]')) { voiceConfirmHandoff(); return; }
      if (e.target.closest('[data-voice-say]')) {
        const last = state.voice.last;
        if (last) voiceSpeak(last.reply, state.voice.lang);
        return;
      }

      const voiceSample = e.target.closest('[data-voice-sample]');
      if (voiceSample) {
        const input = $('#voiceText');
        if (input) input.value = voiceSample.dataset.voiceSample;
        runVoiceIntent(voiceSample.dataset.voiceSample);
        return;
      }

      const voiceLang = e.target.closest('[data-voice-lang]');
      if (voiceLang) {
        state.voice.lang = voiceLang.dataset.voiceLang;
        $$('[data-voice-lang]').forEach((b) => b.classList.toggle('active', b === voiceLang));
        const hint = $('#voiceHint');
        if (hint) hint.textContent = voiceHintText();
        renderCoach();
        if (state.voice.recording) stopVoiceCapture();
        return;
      }

      const binVoice = e.target.closest('[data-bin-voice]');
      if (binVoice) {
        const key = binVoice.dataset.binVoice;
        const line = (BIN_VOICE[key] || BIN_VOICE.dry)[state.voice.lang] || (BIN_VOICE[key] || BIN_VOICE.dry).hinglish;
        const host = $('#binVoiceLine');
        if (host) host.textContent = line;
        $$('[data-bin-voice]').forEach((b) => b.classList.toggle('active', b === binVoice));
        voiceSpeak(line, state.voice.lang);
        return;
      }

      const saveBtn = e.target.closest('[data-save]');
      if (saveBtn) {
        e.stopPropagation();
        const id = saveBtn.dataset.save;
        if (state.saved.has(id)) {
          state.saved.delete(id);
          saveBtn.classList.remove('saved');
          saveBtn.setAttribute('aria-pressed', 'false');
          toast('Removed from saved', 'This listing will no longer appear in your shortlist.');
        } else {
          state.saved.add(id);
          saveBtn.classList.add('saved');
          saveBtn.setAttribute('aria-pressed', 'true');
          popIcon(saveBtn.querySelector('.icon'));
          toast('Saved', 'We will alert you if the price or pickup window changes.');
        }
        return;
      }

      const card = e.target.closest('[data-listing]');
      if (card) { openListing(card.dataset.listing); return; }

      const accept = e.target.closest('[data-accept]');
      if (accept) { acceptPickup(accept.dataset.accept); return; }

      const lotBtn = e.target.closest('[data-lot]');
      if (lotBtn) {
        $$('[data-lot]').forEach((b) => b.classList.toggle('active', b === lotBtn));
        renderLotCheck(lotBtn.dataset.lot);
        return;
      }
      if (e.target.closest('[data-lot-log]')) { logLotCheck(); return; }
      if (e.target.closest('[data-lot-reset]')) { clearLotCheck(); return; }

      const chip = e.target.closest('[data-pick]');
      if (chip) {
        state.pick = chip.dataset.pick;
        renderScanResult(state.scanKey || state.lastResult);
        return;
      }

      if (e.target.closest('[data-scan-confirm]')) { confirmScan(); return; }
      if (e.target.closest('[data-scan-retake]')) { resetScan(); classify(); return; }

      if (e.target.closest('[data-redeem]')) {
        const btn = e.target.closest('[data-redeem]');
        if (state.points >= 3000) {
          state.points -= 3000;
          updateHomeStats();
          popIcon(btn);
          toast('Reward unlocked', '₹150 voucher sent to your phone. Show the code at Green Park Market.');
          btn.textContent = 'Redeemed';
          setTimeout(() => { btn.textContent = 'Redeem'; }, 2400);
        } else {
          toast('Keep sorting', `${fmt(3000 - state.points)} points to your next reward.`, 'warn');
        }
        return;
      }

      if (e.target.closest('[data-notify]')) {
        const btn = e.target.closest('[data-notify]');
        popIcon(btn.querySelector('.icon'));
        const dot = btn.querySelector('.notif-dot');
        if (dot) dot.remove();
        toast('2 new updates', 'IIT Gate 2 is at 88% and your PET listing got a third buyer match.');
        return;
      }

      if (e.target.closest('[data-verify-anchor]')) {
        const btn = e.target.closest('[data-verify-anchor]');
        popIcon(btn.querySelector('.icon'));
        toast('Anchor verified', `Root ${MERKLE.root} matches public commit ${MERKLE.commit} · ${MERKLE.rows} co-signed handoffs${MERKLE.pending ? `, ${MERKLE.pending} queued for tomorrow’s anchor` : ''}.`);
        return;
      }

      if (e.target.closest('[data-collector-payout]')) {
        const btn = e.target.closest('[data-collector-payout]');
        popIcon(btn);
        toast('₹1,240 released', 'UPI transfer to Rafiq K. triggered on QR confirmation. Demo only — no money moves.');
        return;
      }

      const onboard = e.target.closest('[data-onboard]');
      if (onboard) {
        const i = Number(onboard.dataset.onboard);
        if (i === 0) {
          toast('Society added', 'Green Park Society is linked. Invite neighbours to climb the leaderboard.');
        }
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeModal();
        closeSidebar();
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const card = document.activeElement && document.activeElement.closest('[data-listing]');
        if (card && e.target === card) {
          e.preventDefault();
          openListing(card.dataset.listing);
        }
      }
    });

    ['#samples', '#samplesHard'].forEach((sel) => {
      const host = $(sel);
      if (!host) return;
      host.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-sample]');
        if (btn) setSample(btn.dataset.sample);
      });
    });

    $('#classifyBtn').addEventListener('click', classify);
    $('#cameraBtn').addEventListener('click', enableCamera);

    $('#manualBtn').addEventListener('click', () => {
      const select = $('.select[data-select="manual"]');
      const value = select.dataset.value;
      if (!value) {
        toast('Pick a material first', 'Choose one from the dropdown, then show guidance.', 'warn');
        return;
      }
      state.sample = value;
      $$('.sample').forEach((b) => b.classList.toggle('active', b.dataset.sample === value));
      setSample(value, { silent: true });
      $('#resultEmpty').hidden = true;
      $('#resultBody').hidden = true;
      $('#resultLoading').hidden = false;
      wait(650).then(() => {
        $('#resultLoading').hidden = true;
        renderScanResult(value);
      });
    });

    $$('[data-select]').forEach((select) => {
      select.addEventListener('select:change', (e) => {
        const { name, value } = e.detail;
        if (name === 'category') { state.market.category = value; renderMarket(); }
        if (name === 'sort') { state.market.sort = value; renderMarket(); }
      });
    });

    $('#marketSearch').addEventListener('input', (e) => {
      state.market.q = e.target.value.trim();
      renderMarket();
    });

    $('#clearFilters').addEventListener('click', () => {
      state.market = { q: '', category: 'all', sort: 'match', verified: true };
      $('#marketSearch').value = '';
      $('#verifiedToggle').setAttribute('aria-checked', 'true');
      const cat = $('.select[data-select="category"]');
      cat.dataset.value = 'all';
      cat.querySelector('[data-select-label]').textContent = 'All categories';
      cat.querySelectorAll('.select-menu button').forEach((b) => b.classList.toggle('selected', b.dataset.value === 'all'));
      const sort = $('.select[data-select="sort"]');
      sort.dataset.value = 'match';
      sort.querySelector('[data-select-label]').textContent = 'Best match';
      sort.querySelectorAll('.select-menu button').forEach((b) => b.classList.toggle('selected', b.dataset.value === 'match'));
      renderMarket();
    });

    $('#verifiedToggle').addEventListener('click', (e) => {
      const t = e.currentTarget;
      const next = t.getAttribute('aria-checked') !== 'true';
      t.setAttribute('aria-checked', String(next));
      state.market.verified = next;
      renderMarket();
    });

    $('#skipToggle').addEventListener('click', (e) => {
      const t = e.currentTarget;
      const next = t.getAttribute('aria-checked') !== 'true';
      t.setAttribute('aria-checked', String(next));
      state.skipLow = next;
      renderRoute();
      toast(next ? 'Skipping low-fill bins' : 'Visiting every bin', next ? 'Stops under 40% are removed from the run.' : 'Route now includes all 8 bins.');
    });

    $('#optimizeBtn').addEventListener('click', optimiseRoute);
    $('#pingSensors').addEventListener('click', pingSensors);
    $('#resetRoute').addEventListener('click', () => {
      state.routeOptimized = false;
      state.skipLow = true;
      $('#skipToggle').setAttribute('aria-checked', 'true');
      renderRoute();
      toast('Route reset', 'Back to the baseline municipal loop for comparison.');
    });

    $$('.role-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        setRole(btn.dataset.role);
        toast('View switched', `Now viewing ${btn.textContent.trim()} data.`);
      });
    });

    $$('.seg').forEach((btn) => {
      btn.addEventListener('click', () => {
        setRole(btn.dataset.impact);
      });
    });

    $('#downloadReport').addEventListener('click', downloadReport);

    const micBtn = $('#micBtn');
    if (micBtn) micBtn.addEventListener('click', voiceToggleMic);

    const voiceSend = $('#voiceSend');
    if (voiceSend) voiceSend.addEventListener('click', () => runVoiceIntent($('#voiceText')?.value || ''));

    const voiceText = $('#voiceText');
    if (voiceText) {
      voiceText.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          runVoiceIntent(voiceText.value);
        }
      });
    }

    const voiceConsent = $('#voiceConsent');
    if (voiceConsent) {
      voiceConsent.addEventListener('change', () => {
        state.voice.consent = voiceConsent.checked;
        if (voiceConsent.checked) toast('Consent recorded', 'Transcript fields are kept; raw audio is discarded after transcription.');
      });
    }

    const voiceApi = $('#voiceApi');
    if (voiceApi) {
      voiceApi.addEventListener('change', () => {
        state.voice.base = voiceNormalizeBase(voiceApi.value);
        store('lg.voiceApi', state.voice.base);
        checkVoiceHealth(false);
      });
    }

    const voiceTest = $('#voiceTest');
    if (voiceTest) {
      voiceTest.addEventListener('click', () => {
        const input = $('#voiceApi');
        state.voice.base = voiceNormalizeBase(input ? input.value : '');
        store('lg.voiceApi', state.voice.base);
        checkVoiceHealth(true);
      });
    }

    const coachPick = $('#coachPick');
    if (coachPick) coachPick.addEventListener('change', renderCoach);

    const coachPlay = $('#coachPlay');
    if (coachPlay) {
      coachPlay.addEventListener('click', async () => {
        const pick = $('#coachPick');
        if (!pick) return;
        const line = coachText(pick.value);
        const host = $('#coachLine');
        if (host) host.textContent = line;
        await voiceSpeak(line, state.voice.lang);
      });
    }

    $('#newListingForm').addEventListener('submit', (e) => {
      e.preventDefault();
      publishListing(e.currentTarget);
    });

    $('#modalLayer').addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-backdrop')) closeModal();
    });

    document.addEventListener('scroll', () => {
      const nav = $('.site-nav');
      if (!nav) return;
      nav.style.boxShadow = window.scrollY > 12 ? '0 8px 24px -18px rgba(11,31,58,.4)' : 'none';
    }, { passive: true });
  }

  /* ---------------------------------------------------------
     Init
     --------------------------------------------------------- */
  function init() {
    // Greeting by local time
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const h1 = $('.page[data-page="home"] .page-head h1');
    if (h1) h1.textContent = `${greeting}, Ananya.`;

    initSelects();
    bindEvents();
    renderHomeBins();
    renderActivity();
    renderOnboard();
    updateHomeStats();
    renderMarket();
    renderRoute();
    renderImpact(state.role);
    renderLedger();
    setSample('pet', { silent: true });
    initVoice();
    initReveals();

    // Keep an active page for the app shell
    $('.page[data-page="home"]').classList.add('is-active');
    $$('.side-link[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === 'home'));

    // Update landing points chip
    const chip = $('.chip-b');
    if (chip) chip.innerHTML = '<span class="dot teal"></span> 3,120 green points';

    // Make select menus close when clicking outside, keep them above cards
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.select')) closeSelects();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
