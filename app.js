/* ==========================================================================
   The Profanity Index — SNARP analysis dashboard
   Plain vanilla JavaScript. No framework, no build step for this file.
   Loads build/snarp-data.json (produced by scripts/build.py) and renders
   the whole dashboard. Edit freely.
   ========================================================================== */

"use strict";

/* ---- palette (mirrors the CSS custom properties) ------------------------- */
const TIER_COLOR = {
  mild: "#c9ad6e", strong: "#dd8a3c", severe: "#c4351c",
  slurRace: "#79386f", slurSex: "#a23d62", context: "#b3a896",
};

/* map the raw category keys used in the data to our short tier keys */
const CAT_TO_TIER = {
  mild_profanity: "mild", strong_profanity: "strong", severe_profanity: "severe",
  identity_slur_race: "slurRace", identity_slur_sexuality: "slurSex",
  identity_context_needed: "context",
};

/* the single source of UI state */
const state = {
  sortKey: "perMin",   // perMin | total | severe | minutes | slurs
  normalize: false,    // false = absolute counts, true = share of each video
  activeTerm: null,    // a word clicked in the lexicon, used to filter the ranking
  selected: null,      // idx of the video shown in the drawer
  search: "",          // transcript search query
};

let DATA = null;       // { videos:[...], transcripts:{...} }
let COMPUTED = null;   // derived aggregates (see build())

/* ==========================================================================
   1. LOAD
   ========================================================================== */
async function load() {
  try {
    const res = await fetch("build/snarp-data.json", { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    DATA = await res.json();
  } catch (err) {
    console.error("Could not load build/snarp-data.json.", err);
    showLoadError();
    return;
  }
  build();
  renderStatic();
  renderRanking();
  renderLexicon();
  renderPrograms();
  renderIncidents();
  renderSearch();
  wireEvents();
}

function showLoadError() {
  document.querySelector(".wrap").innerHTML =
    '<div class="loaderr"><b>Couldn’t load the data file.</b>' +
    '<p>Run <code>python scripts/build.py</code> to generate <code>build/snarp-data.json</code>, ' +
    "then serve over HTTP — on GitHub Pages it just works, or locally run " +
    "<code>python -m http.server</code> and open <code>localhost:8000</code>. " +
    "Opening the file directly (file://) won’t work because browsers block fetch.</p></div>";
}

/* ==========================================================================
   2. BUILD — derive every aggregate the views need, once
   ========================================================================== */

/* Resolve censored spellings (f**k, f***) back to a canonical word so the
   lexicon doesn't split one term across many asterisk variants. */
const CANON_WORDS = [
  "motherfucking","motherfuckers","motherfucker","fuckhole","fucking","fuckers",
  "fucked","fucker","fucks","fuck","bullshits","bullshit","shitty","shits","shit",
  "assholes","asshole","bitches","bitching","bitch","dickheads","dickhead","dicks",
  "dick","pussies","pussy","asses","ass","crap","damn","hell","piss","sucks","suck",
  "gay","faggots","faggot","fags","fag","niggas","nigga","niggers","nigger",
];
function canon(term) {
  const t = String(term).toLowerCase().trim();
  if (!t.includes("*")) return t;
  for (const w of CANON_WORDS) {
    if (w.length !== t.length) continue;
    let ok = true;
    for (let i = 0; i < w.length; i++) {
      if (t[i] !== "*" && t[i] !== w[i]) { ok = false; break; }
    }
    if (ok) return w;
  }
  return t.replace(/\*/g, "") || t;
}

function build() {
  const V = DATA.videos;

  // tier totals across all videos
  const totals = { mild:0, strong:0, severe:0, slurRace:0, slurSex:0, context:0 };
  V.forEach(v => {
    totals.mild += v.mild; totals.strong += v.strong; totals.severe += v.severe;
    totals.slurRace += v.slurRace; totals.slurSex += v.slurSex; totals.context += v.context;
  });

  const totalCurses = V.reduce((a, v) => a + v.total, 0);
  const peak = Math.max(...V.map(v => v.perMin));
  const slurVideos = V.filter(v => v.slurRace + v.slurSex > 0).length;
  const maxTotal = Math.max(...V.map(v => v.total));

  // aggregate the term breakdown into a per-tier lexicon, and remember each
  // word's highest-severity tier + which videos contain it
  const agg = { mild:{}, strong:{}, severe:{}, slurRace:{}, slurSex:{}, context:{} };
  const vocabTier = {};
  const sev = { severe:6, slurRace:5, slurSex:4, strong:3, mild:2, context:1 };
  V.forEach(v => {
    const set = new Set();
    Object.entries(v.terms || {}).forEach(([cat, obj]) => {
      const tier = CAT_TO_TIER[cat];
      if (!tier) return;
      Object.entries(obj).forEach(([term, c]) => {
        const cw = canon(term);
        if (/[a-z]/.test(cw)) set.add(cw);
        agg[tier][cw] = (agg[tier][cw] || 0) + c;
        if (!(cw in vocabTier) || sev[tier] > sev[vocabTier[cw]]) vocabTier[cw] = tier;
      });
    });
    v._set = set;  // words present in this video (for the lexicon cross-filter)
  });

  const lexByTier = {};
  Object.keys(agg).forEach(t => {
    lexByTier[t] = Object.entries(agg[t])
      .map(([word, count]) => ({ word, count }))
      .sort((a, b) => b.count - a.count);
  });

  // a regex of every distinct word, used to find curse "hits" in transcripts
  const vocabWords = Object.keys(vocabTier)
    .filter(w => /^[a-z]+$/.test(w) && w.length >= 2)
    .sort((a, b) => b.length - a.length);
  const vocabRe = new RegExp(
    "\\b(" + vocabWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b",
    "gi");

  // per-video list of {time, word, tier} for the drawer timeline
  const hits = {};
  Object.entries(DATA.transcripts || {}).forEach(([vid, tr]) => {
    const list = [];
    (tr.segments || []).forEach(seg => {
      let m; vocabRe.lastIndex = 0;
      while ((m = vocabRe.exec(seg.t)) !== null) {
        const w = m[1].toLowerCase();
        list.push({ time: seg.s, word: w, tier: vocabTier[w] || "mild" });
      }
    });
    hits[vid] = list;
  });

  // school aggregates (a video credits each of its schools)
  // const sch = {};
  // V.forEach(v => v.schools.forEach(s => {
  //   const o = sch[s] || (sch[s] = { name:s, videos:0, total:0, slur:0, perMinSum:0 });
  //   o.videos++; o.total += v.total; o.slur += v.slurRace + v.slurSex; o.perMinSum += v.perMin;
  // }));
  // const schools = Object.values(sch)
  //   .map(o => ({ ...o, avgPerMin: o.perMinSum / o.videos }))
  //   .sort((a, b) => b.total - a.total);
  // OLD — credited every school the full total (the 1.9× double-count)
  // V.forEach(v => v.schools.forEach(s => { ... o.total += v.total ... }));

  const sch = {};
  V.forEach(v => {
    const s = v.target;            // <-- target gets the curses; troll gets nothing
    if (!s) return;                // null-target compilations skip the board
    const o = sch[s] || (sch[s] = { name:s, videos:0, total:0, slur:0, minutes:0 });
    o.videos++; o.total += v.total; o.slur += v.slurRace + v.slurSex; o.minutes += v.minutes;
  });
  const schools = Object.values(sch)
    .map(o => ({ ...o, avgPerMin: +(o.total / o.minutes).toFixed(2) }))  // pooled rate
    .sort((a, b) => b.avgPerMin - a.avgPerMin);

  // slur incidents
  const incidents = V.filter(v => v.slurRace + v.slurSex > 0).map(v => {
    const terms = [];
    ["identity_slur_race", "identity_slur_sexuality"].forEach(k => {
      const obj = v.terms && v.terms[k];
      if (obj) Object.entries(obj).forEach(([term, c]) =>
        terms.push({ term, c, kind: k === "identity_slur_race" ? "race" : "sex" }));
    });
    return { v, terms, slurTotal: v.slurRace + v.slurSex };
  }).sort((a, b) => b.slurTotal - a.slurTotal);

  COMPUTED = { totals, totalCurses, peak, slurVideos, maxTotal, lexByTier, vocabTier, hits, schools, incidents };
}

/* ==========================================================================
   3. RENDER — small helpers
   ========================================================================== */
const $  = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[c]));
const yt  = (id, sec) => "https://www.youtube.com/watch?v=" + id + (sec != null ? "&t=" + Math.max(0, Math.floor(sec) - 1) + "s" : "");
const mmss = sec => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
const byIdx = idx => DATA.videos.find(v => v.idx === idx);

/* ---- header stats + legend ---------------------------------------------- */
function renderStatic() {
  const c = COMPUTED, V = DATA.videos;
  $("#stat-count").textContent = V.length;
  $("#stats").innerHTML = [
    ["Videos", V.length, ""],
    ["Curses counted", c.totalCurses.toLocaleString(), ""],
    ["Peak rate", c.peak.toFixed(2) + '<small> /min</small>', ""],
    ["Videos w/ slurs", c.slurVideos, "color:" + TIER_COLOR.slurRace],
  ].map(([lab, num, style]) =>
    `<div class="stat"><div class="lab">${lab}</div><div class="num" style="${style}">${num}</div></div>`
  ).join("");

  const legend = [
    ["Mild", TIER_COLOR.mild, c.totals.mild],
    ["Strong", TIER_COLOR.strong, c.totals.strong],
    ["Severe", TIER_COLOR.severe, c.totals.severe],
    ["Racial slur", TIER_COLOR.slurRace, c.totals.slurRace],
    ["Sexuality slur", TIER_COLOR.slurSex, c.totals.slurSex],
    ["Context-flagged", TIER_COLOR.context, c.totals.context],
  ];
  $("#legend").innerHTML = legend.map(([lab, col, n]) =>
    `<div class="item"><span class="sw" style="background:${col}"></span><span style="font-weight:600">${lab}</span><span class="n">${n}</span></div>`
  ).join("");
}

/* ---- ranking ------------------------------------------------------------- */
const SORTS = [
  ["perMin", "Rate / min"], ["total", "Total curses"],
  ["severe", "Severe"], ["minutes", "Length"], ["slurs", "Slurs"],
];
const SORT_FN = {
  perMin: v => v.perMin, total: v => v.total, severe: v => v.severe,
  minutes: v => v.minutes, slurs: v => (v.slurRace + v.slurSex) * 100 + v.context,
};
const SEG_TIERS = [["mild","mild"],["strong","strong"],["severe","severe"],["slurRace","slurRace"],["slurSex","slurSex"],["context","context"]];

function renderRanking() {
  // sort controls
  $("#sort-buttons").innerHTML = SORTS.map(([k, l]) =>
    `<button class="sortbtn ${state.sortKey === k ? "on" : ""}" data-sort="${k}">${l}</button>`
  ).join("");
  $("#norm-toggle").textContent = state.normalize ? "view: share of each video" : "view: absolute counts";

  // active-term filter bar
  $("#filter-bar").innerHTML = state.activeTerm
    ? `<div class="filterbar"><span class="lab">filtered to videos containing</span>` +
      `<span class="chip">${esc(state.activeTerm)}</span>` +
      `<button class="clearbtn" id="clear-filter">clear ✕</button></div>`
    : "";

  const sorted = [...DATA.videos].sort((a, b) => SORT_FN[state.sortKey](b) - SORT_FN[state.sortKey](a));
  $("#ranking").innerHTML = sorted.map((v, i) => {
    const denom = state.normalize ? (v.total || 1) : COMPUTED.maxTotal;
    const bar = SEG_TIERS.map(([f, t]) => {
      const w = (v[f] / denom) * 100;
      return w > 0 ? `<span style="width:${w}%;background:${TIER_COLOR[t]}"></span>` : "";
    }).join("");
    const dim = state.activeTerm && !v._set.has(state.activeTerm) ? 0.24 : 1;
    const hasTr = !!DATA.transcripts[v.id];
    return `<div class="row" data-idx="${v.idx}" style="opacity:${dim}">
      <div class="r-rank">${i + 1}</div>
      <div>
        <div class="r-title"><span class="t">${esc(v.title)}</span>
          ${v.slurRace + v.slurSex > 0 ? '<span class="dot" title="contains slur"></span>' : ""}
          ${hasTr ? '<span class="txt-badge" title="transcript available">TXT</span>' : ""}
        </div>
        <div class="r-sch">${v.schools.length ? esc(v.schools.join("  ·  ")) : "school unlisted"}</div>
      </div>
      <div class="bar">${bar}</div>
      <div class="r-rate"><div class="big">${v.perMin.toFixed(2)}</div><div class="sub">${v.total} total</div></div>
    </div>`;
  }).join("");
}

/* ---- lexicon ------------------------------------------------------------- */
const LEX_META = [
  ["severe", "Severe", TIER_COLOR.severe], ["strong", "Strong", TIER_COLOR.strong],
  ["mild", "Mild", TIER_COLOR.mild], ["slurRace", "Racial slur", TIER_COLOR.slurRace],
  ["slurSex", "Sexuality slur", TIER_COLOR.slurSex], ["context", "Context-flagged", TIER_COLOR.context],
];
function renderLexicon() {
  $("#lexicon").innerHTML = LEX_META.map(([tier, label, color]) => {
    const arr = (COMPUTED.lexByTier[tier] || []).slice(0, 14);
    const mx = arr.length ? arr[0].count : 1;
    const total = COMPUTED.totals[tier];
    const terms = arr.map(o => `
      <div class="term ${state.activeTerm === o.word ? "on" : ""}" data-term="${esc(o.word)}">
        <div class="lab"><span class="w">${esc(o.word)}</span><span class="c">${o.count}</span></div>
        <div class="meter"><span style="width:${(o.count / mx) * 100}%;background:${color}"></span></div>
      </div>`).join("");
    return `<div class="lex-col">
      <h3 style="border-color:${color}">${label}<span class="ct">${total}</span></h3>${terms}
    </div>`;
  }).join("");
}

/* ---- programs ------------------------------------------------------------ */
function renderPrograms() {
  const max = Math.max(...COMPUTED.schools.map(o => o.total));
  $("#programs").innerHTML = COMPUTED.schools.map(o => `
    <div class="prog">
      <div>
        <div class="name">${esc(o.name)}${o.slur > 0 ? '<span class="dot"></span>' : ""}</div>
        <div class="vids">${o.videos} videos</div>
      </div>
      <div class="track"><span style="width:${(o.total / max) * 100}%"></span></div>
      <div class="val">${o.total}<small> curses</small></div>
      <div class="val">${o.avgPerMin.toFixed(2)}<small>/min</small></div>
    </div>`).join("");
}

/* ---- incidents ----------------------------------------------------------- */
function renderIncidents() {
  $("#incidents").innerHTML = COMPUTED.incidents.map(({ v, terms }) => {
    const tags = terms.map(t =>
      `<span class="tag" style="background:${t.kind === "race" ? TIER_COLOR.slurRace : TIER_COLOR.slurSex}">${esc(t.term)} ×${t.c}</span>`
    ).join("");
    return `<div class="inc" data-idx="${v.idx}">
      <div class="t">${esc(v.title)}</div>
      <div class="s">${esc(v.schools.join(" · "))}</div>
      <div class="tags">${tags}</div>
    </div>`;
  }).join("");
}

/* ---- transcript search (KWIC) ------------------------------------------- */
function renderSearch() {
  $("#search-count").textContent = Object.keys(DATA.transcripts || {}).length;
  $("#search-input").value = state.search;
  const q = state.search.trim().toLowerCase();
  const box = $("#kwic-results");

  if (q.length < 2) {
    box.innerHTML = '<div class="empty">Awaiting query — results appear here.</div>';
    return;
  }

  const rows = [];
  Object.entries(DATA.transcripts).forEach(([vid, tr]) => {
    (tr.segments || []).forEach(seg => {
      const low = seg.t.toLowerCase();
      if (low.includes(q) && rows.length < 80) {
        // highlight every occurrence of the query in the line
        let html = "", last = 0, p = low.indexOf(q);
        while (p >= 0) {
          html += esc(seg.t.slice(last, p)) + "<mark>" + esc(seg.t.slice(p, p + q.length)) + "</mark>";
          last = p + q.length; p = low.indexOf(q, last);
        }
        html += esc(seg.t.slice(last));
        rows.push(`<div class="kwic">
          <a class="time" href="${yt(vid, seg.s)}" target="_blank" rel="noopener" title="open in YouTube">${mmss(seg.s)} ↗</a>
          <span class="vid">${esc(tr.title)}</span>
          <span class="line">${html}</span>
        </div>`);
      }
    });
  });

  box.innerHTML = `<div class="kwic-meta">${rows.length} matching lines</div>` + rows.join("");
}

/* ==========================================================================
   4. DRAWER — per-video detail
   ========================================================================== */
const TIMELINE_H = { severe:30, strong:22, mild:14, slurRace:34, slurSex:34, context:10 };

function buildTimelineSVG(v) {
  const tr = DATA.transcripts[v.id];
  if (!tr) return "";
  const W = 760, H = 66, pad = 10;
  const dur = tr.duration || v.minutes * 60;
  const hits = COMPUTED.hits[v.id] || [];
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block">`;
  s += `<line x1="${pad}" x2="${W - pad}" y1="${H - 20}" y2="${H - 20}" stroke="#ddd5c4" stroke-width="1"/>`;
  hits.forEach(ht => {
    const x = pad + (ht.time / dur) * (W - 2 * pad);
    const g = TIMELINE_H[ht.tier] || 14;
    s += `<a href="${yt(v.id, ht.time)}" target="_blank" rel="noopener">
      <line x1="${x}" x2="${x}" y1="${H - 20 - g}" y2="${H - 20}" stroke="${TIER_COLOR[ht.tier]}" stroke-width="2" stroke-opacity="0.78" style="cursor:pointer"><title>${esc(ht.word)} · ${mmss(ht.time)} — open in YouTube</title></line>
      <line x1="${x}" x2="${x}" y1="${H - 20 - g}" y2="${H - 20}" stroke="transparent" stroke-width="7"/></a>`;
  });
  [0, .25, .5, .75, 1].forEach((f, i) => {
    const x = pad + f * (W - 2 * pad);
    const anchor = i === 0 ? "start" : i === 4 ? "end" : "middle";
    s += `<text x="${x}" y="${H - 6}" text-anchor="${anchor}" font-family="IBM Plex Mono, monospace" font-size="10" fill="#948a7a">${mmss(f * dur)}</text>`;
  });
  return s + "</svg>";
}

const DRAWER_GROUPS = [
  ["identity_slur_race", "Racial slur", TIER_COLOR.slurRace],
  ["identity_slur_sexuality", "Sexuality slur", TIER_COLOR.slurSex],
  ["severe_profanity", "Severe", TIER_COLOR.severe],
  ["strong_profanity", "Strong", TIER_COLOR.strong],
  ["mild_profanity", "Mild", TIER_COLOR.mild],
  ["identity_context_needed", "Context-flagged", TIER_COLOR.context],
];

function renderDrawer() {
  const root = $("#drawer-root");
  if (state.selected == null) { root.innerHTML = ""; return; }
  const v = byIdx(state.selected);
  const tr = DATA.transcripts[v.id];

  const groups = DRAWER_GROUPS.map(([cat, label, color]) => {
    const obj = v.terms && v.terms[cat];
    if (!obj || !Object.keys(obj).length) return "";
    const arr = Object.entries(obj).map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count);
    const mx = arr[0].count;
    const rows = arr.map(o => `<div class="gt">
      <span class="word">${esc(o.word)}</span>
      <span class="meter"><span style="width:${(o.count / mx) * 100}%;background:${color}"></span></span>
      <span class="num">${o.count}</span></div>`).join("");
    return `<div class="tgroup"><div class="gh"><span class="sw" style="background:${color}"></span>${label}</div>${rows}</div>`;
  }).join("");

  const stats = [
    ["Rate", v.perMin.toFixed(2)], ["Total", v.total],
    ["Length", v.minutes], ["Words", v.words],
  ].map(([l, val]) => `<div class="c"><div class="l">${l}</div><div class="v">${val}</div></div>`).join("");

  const timeline = tr
    ? `<div class="d-sub">Timeline of hits · ${(COMPUTED.hits[v.id] || []).length} flagged</div>
       <div class="timeline-box">${buildTimelineSVG(v)}</div>`
    : `<div class="no-tr">Transcript not yet loaded for this video — counts only.</div>`;

  root.innerHTML = `<div class="scrim" id="scrim"><div class="drawer" id="drawer">
    <button class="x" id="drawer-close">✕</button>
    <div class="eyebrow">Video detail</div>
    <h3>${esc(v.title)}</h3>
    <div class="d-sch">${v.schools.length ? esc(v.schools.join("  ·  ")) : "school unlisted"}</div>
    <a class="yt" href="${yt(v.id)}" target="_blank" rel="noopener"><span class="play"><i></i></span>Watch on YouTube</a>
    <div class="d-stats">${stats}</div>
    ${timeline}
    <div class="d-sub">Term breakdown</div>
    ${groups}
  </div></div>`;

  $("#scrim").addEventListener("click", () => set({ selected: null }));
  $("#drawer").addEventListener("click", e => e.stopPropagation());
  $("#drawer-close").addEventListener("click", () => set({ selected: null }));
}

/* ==========================================================================
   5. EVENTS + STATE
   ========================================================================== */
function set(patch) {
  Object.assign(state, patch);
  // re-render only what each change can affect
  renderRanking();
  renderLexicon();
  renderSearch();
  renderDrawer();
}

function wireEvents() {
  // sort buttons + clear-filter (delegated, survives re-render)
  $("#sort-buttons").addEventListener("click", e => {
    const b = e.target.closest("[data-sort]");
    if (b) set({ sortKey: b.dataset.sort });
  });
  $("#norm-toggle").addEventListener("click", () => set({ normalize: !state.normalize }));
  $("#filter-bar").addEventListener("click", e => {
    if (e.target.id === "clear-filter") set({ activeTerm: null, search: "" });
  });

  // open drawer from a ranking row or an incident card
  document.body.addEventListener("click", e => {
    const row = e.target.closest(".row, .inc");
    if (row && row.dataset.idx != null) set({ selected: Number(row.dataset.idx) });
  });

  // lexicon term -> filter ranking + seed search
  $("#lexicon").addEventListener("click", e => {
    const t = e.target.closest("[data-term]");
    if (!t) return;
    const next = state.activeTerm === t.dataset.term ? null : t.dataset.term;
    set({ activeTerm: next, search: next || "" });
  });

  // transcript search
  $("#search-input").addEventListener("input", e => {
    state.search = e.target.value;
    state.activeTerm = null;
    renderSearch();
    renderLexicon();
    renderRanking();
  });

  // Esc closes the drawer
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && state.selected != null) set({ selected: null });
  });
}

load();
