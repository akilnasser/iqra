const DATA_URL = "../data/quran.json?v=qarai";
const WBW_URL = (n) => `../data/wbw/${n}.json?v=2`;
const BOOKMARK_KEY = "iqra:bookmark";
const PROGRESS_KEY = "iqra:progress";
const PROGRESS_KEEP_DAYS = 30;
const LONG_PRESS_MS = 480;
const SWIPE_MIN_X = 40;
const AR_SIZE = "2.6rem";
const EN_SIZE = "1.4rem";
const DEFAULT_BOOKMARK = { surah: 1, ayah: 1 };
const WEEKDAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const app = document.getElementById("app");

/** @type {null | {surahs: any[], rukus: any[], attribution: object}} */
let data = null;
/** @type {null | {surah: number, ayah: number}} */
let bookmark = null;
/** @type {number[] | null} prefix sums: index before surah n (1-based surah → offset) */
let ayahOffsets = null;
/** @type {Map<number, Record<string, string[][]>>} */
const wbwCache = new Map();
/** @type {number | null} */
let readerSurah = null;
/** @type {null | {ayah: number, offset: number}} */
let pendingWbwExitAnchor = null;
/** Skip opening a surah when edge-back is forcing home from English. */
let suppressReaderRoute = false;

document.documentElement.style.setProperty("--ar-size", AR_SIZE);
document.documentElement.style.setProperty("--en-size", EN_SIZE);

window.addEventListener("hashchange", route);
window.addEventListener("popstate", () => {
  if (!document.body.classList.contains("is-reading")) return;
  const swipe = document.getElementById("reader-swipe");
  // Edge-swipe back while in WBW → English, stay on this surah.
  if (swipe && swipe.dataset.mode === "wbw") {
    const anchor = pendingWbwExitAnchor || captureVerseAnchor("wbw");
    pendingWbwExitAnchor = null;
    swipe.dataset.mode = "en";
    updateSwipeHint("en");
    syncSwipeHeight();
    restoreAfterSwipe("en", anchor);
    return;
  }
  // Edge-swipe back on English → always home (never previous surah).
  suppressReaderRoute = true;
  history.replaceState(null, "", `${location.pathname}${location.search}#/`);
  renderHome();
});
document.querySelector(".brand")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (location.hash === "#/" || location.hash === "" || location.hash === "#") {
    renderHome();
    return;
  }
  location.hash = "#/";
});
init();

async function init() {
  app.innerHTML = `<p class="loading">Loading…</p>`;
  try {
    const quranRes = await fetch(DATA_URL);
    if (!quranRes.ok) throw new Error(`HTTP ${quranRes.status}`);
    data = await quranRes.json();
    buildAyahOffsets();
    bookmark = loadBookmark();
    applyProgressSeedFromUrl();
    ensureProgressSeeded(bookmark);
    // Fresh load always lands on home (ignore leftover #/s/... from history).
    history.replaceState(null, "", `${location.pathname}${location.search}#/`);
    route();
  } catch (err) {
    console.error(err);
    app.innerHTML = `<p class="error">Could not load Quran data. Open this app over HTTP from the project root.</p>`;
  }
}

function route() {
  if (!data) return;
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);

  if (suppressReaderRoute) {
    suppressReaderRoute = false;
    if (parts[0] === "s") {
      history.replaceState(null, "", `${location.pathname}${location.search}#/`);
      renderHome();
      return;
    }
  }

  if (parts[0] === "s" && parts[1]) {
    renderReader(Number(parts[1]), parts[2] ? Number(parts[2]) : null);
    return;
  }
  renderHome();
}

/** Open a surah; replace=true keeps edge-back pointed at home. */
function openReader(surah, ayah, { replace = false } = {}) {
  const next = `#/s/${surah}/${ayah}`;
  if (replace) {
    history.replaceState(null, "", `${location.pathname}${location.search}${next}`);
    route();
    return;
  }
  location.hash = next;
}

function renderHome() {
  document.body.classList.remove("is-reading");
  document.body.classList.add("is-home");
  readerSurah = null;
  window.scrollTo({ top: 0, left: 0 });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  const bookmarkSurah = bookmark ? data.surahs[bookmark.surah - 1] : null;
  const bookmarkLabel = bookmarkSurah
    ? `${bookmarkSurah.nameEn} · ${bookmark.surah}:${bookmark.ayah}`
    : "";
  const startSurah = bookmark?.surah || 1;
  const startAyah = bookmark?.ayah || 1;

  app.innerHTML = `
    <section class="home">
      <div class="home-pane">
        <div class="hero">
          <p>Iqra keeps you focused on completing the Qur'an from cover to cover, whether you're on the subway, between classes, or lounging in bed. When your session ends, set your bookmark and return to it next session.</p>
          <div class="cta-row">
            ${
              bookmark
                ? `<button type="button" class="btn btn-primary btn-bookmark" id="go-bookmark">
                    <span class="btn-bookmark-title">Back to bookmark</span>
                    <span class="btn-bookmark-where" id="bookmark-label">${escapeHtml(bookmarkLabel)}</span>
                  </button>`
                : `<button type="button" class="btn btn-primary" id="go-start">Begin</button>`
            }
          </div>
          ${weekProgressHtml()}
        </div>
        <div class="jump" aria-label="Jump to verse">
          <h2 class="jump-title">Jump to</h2>
          <div class="jump-wheels">
            <div class="jump-col">
              <div class="jump-label">Surah</div>
              <div class="jump-wheel" id="jump-surah" role="listbox" aria-label="Surah"></div>
            </div>
            <div class="jump-col">
              <div class="jump-label">Ayah</div>
              <div class="jump-wheel" id="jump-ayah" role="listbox" aria-label="Ayah"></div>
            </div>
          </div>
          <div class="jump-actions">
            <button type="button" class="btn btn-primary" id="jump-go">Jump</button>
          </div>
        </div>
      </div>
    </section>
  `;

  document.getElementById("go-bookmark")?.addEventListener("click", () => {
    if (!bookmark) return;
    location.hash = `#/s/${bookmark.surah}/${bookmark.ayah}`;
  });
  document.getElementById("go-start")?.addEventListener("click", () => {
    setBookmark(1, 1);
    location.hash = "#/s/1/1";
  });

  bindJumpPicker(startSurah, startAyah);
}

/** Block page pan/rubber-band on home; allow only jump-wheel scrolling. */
function blockHomePageScroll(e) {
  if (!document.body.classList.contains("is-home")) return;
  if (e.target.closest?.(".jump-wheel")) return;
  e.preventDefault();
}
document.addEventListener("touchmove", blockHomePageScroll, { passive: false });
document.addEventListener("wheel", blockHomePageScroll, { passive: false });

const JUMP_ITEM_H = 44;

function bindJumpPicker(initialSurah, initialAyah) {
  const surahWheel = document.getElementById("jump-surah");
  const ayahWheel = document.getElementById("jump-ayah");
  const jumpGo = document.getElementById("jump-go");
  if (!surahWheel || !ayahWheel || !jumpGo || !data) return;

  let selectedSurah = Math.min(Math.max(1, initialSurah), 114);
  let selectedAyah = Math.max(1, initialAyah);

  const pad = `<div class="jump-pad" aria-hidden="true"></div>`;

  surahWheel.innerHTML =
    pad +
    data.surahs
      .map(
        (s) =>
          `<div class="jump-option" role="option" data-value="${s.number}">
            <span class="jump-num">${s.number}</span>
            <span class="jump-name">${escapeHtml(s.nameEn)}</span>
          </div>`
      )
      .join("") +
    pad;

  function fillAyahWheel(surahNum, ayahNum) {
    const surah = data.surahs[surahNum - 1];
    const count = surah?.verses.length || 1;
    selectedAyah = Math.min(Math.max(1, ayahNum), count);
    ayahWheel.innerHTML =
      pad +
      Array.from({ length: count }, (_, i) => {
        const n = i + 1;
        return `<div class="jump-option jump-option--ayah" role="option" data-value="${n}">${n}</div>`;
      }).join("") +
      pad;
    requestAnimationFrame(() => {
      ayahWheel.scrollTop = (selectedAyah - 1) * JUMP_ITEM_H;
    });
  }

  function indexFromScroll(wheel) {
    return Math.round(wheel.scrollTop / JUMP_ITEM_H) + 1;
  }

  function snapWheel(wheel) {
    const idx = Math.max(0, Math.round(wheel.scrollTop / JUMP_ITEM_H));
    wheel.scrollTo({ top: idx * JUMP_ITEM_H, behavior: "smooth" });
    return idx + 1;
  }

  let surahTimer = null;
  let ayahTimer = null;

  surahWheel.addEventListener("scroll", () => {
    clearTimeout(surahTimer);
    surahTimer = setTimeout(() => {
      const next = Math.min(114, Math.max(1, snapWheel(surahWheel)));
      if (next !== selectedSurah) {
        selectedSurah = next;
        fillAyahWheel(selectedSurah, 1);
      } else {
        selectedSurah = next;
      }
    }, 80);
  });

  ayahWheel.addEventListener("scroll", () => {
    clearTimeout(ayahTimer);
    ayahTimer = setTimeout(() => {
      const surah = data.surahs[selectedSurah - 1];
      const count = surah?.verses.length || 1;
      selectedAyah = Math.min(count, Math.max(1, snapWheel(ayahWheel)));
    }, 80);
  });

  fillAyahWheel(selectedSurah, selectedAyah);
  requestAnimationFrame(() => {
    surahWheel.scrollTop = (selectedSurah - 1) * JUMP_ITEM_H;
    ayahWheel.scrollTop = (selectedAyah - 1) * JUMP_ITEM_H;
  });

  jumpGo.addEventListener("click", () => {
    selectedSurah = Math.min(114, Math.max(1, indexFromScroll(surahWheel)));
    const count = data.surahs[selectedSurah - 1]?.verses.length || 1;
    selectedAyah = Math.min(count, Math.max(1, indexFromScroll(ayahWheel)));
    location.hash = `#/s/${selectedSurah}/${selectedAyah}`;
  });
}

function renderReader(surahNum, focusAyah) {
  const surah = data.surahs[surahNum - 1];
  if (!surah) {
    location.hash = "#/";
    return;
  }

  document.body.classList.remove("is-home");
  document.body.classList.add("is-reading");
  window.scrollTo({ top: 0 });
  readerSurah = surah.number;
  pendingWbwExitAnchor = null;
  // Clear any leftover WBW history flag from a previous visit.
  history.replaceState(null, "", location.href);

  const prev = surahNum > 1 ? surahNum - 1 : null;
  const next = surahNum < 114 ? surahNum + 1 : null;
  const aim = getAimVerse(bookmark);
  const scrollTo =
    focusAyah ||
    (bookmark && bookmark.surah === surahNum ? bookmark.ayah : null);

  const topNav = `
    <nav class="reader-nav reader-nav--start">
      ${
        prev
          ? `<button type="button" class="btn btn-ghost surah-nav-btn" data-go-surah="${prev}">Previous surah</button>`
          : `<span class="surah-nav-spacer"></span>`
      }
    </nav>`;

  const nextNav = `
    <nav class="reader-nav reader-nav--end">
      ${
        next
          ? `<button type="button" class="btn btn-primary surah-nav-btn" data-go-surah="${next}">Next surah</button>`
          : `<a class="btn btn-primary" href="#/">Finished</a>`
      }
    </nav>`;

  const verseCells = (mode) =>
    surah.verses
      .map((v) => {
        const isBookmark =
          bookmark && bookmark.surah === surah.number && bookmark.ayah === v.number;
        const isAim = aim && aim.surah === surah.number && aim.ayah === v.number;
        const rukuMark = v.endOfRuku
          ? `<div class="ruku-end">End of rukuʿ ${v.ruku}</div>`
          : "";
        const stripe = v.number % 2 === 0 ? "is-even" : "is-odd";
        const markClass = [
          stripe,
          v.endOfRuku && "is-ruku-end",
          isBookmark && "is-bookmark",
          isAim && "is-aim",
        ]
          .filter(Boolean)
          .join(" ");
        const idAttr = mode === "en" ? `id="a${v.number}"` : `id="w${v.number}"`;
        const body =
          mode === "en"
            ? `<p class="verse-en">${escapeHtml(v.en || "")}</p>`
            : `<div class="wbw" data-wbw-ayah="${v.number}"><p class="wbw-status">Loading words…</p></div>`;
        return `
          <article class="verse ${markClass}" ${idAttr} data-ayah="${v.number}">
            <div class="ayah-marker" aria-hidden="true">
              <span class="ayah-num">${v.number}</span>
            </div>
            ${body}
            ${rukuMark}
          </article>`;
      })
      .join("");

  app.innerHTML = `
    <section class="reader">
      <header class="reader-head">
        <div class="reader-head-titles">
          <div class="meta">${surah.number} / 114</div>
          <h1 lang="ar" dir="rtl">${escapeHtml(surah.nameAr)}</h1>
          <p class="en-name">${escapeHtml(surah.nameEn)}</p>
        </div>
        <p class="pane-swipe-hint" id="pane-swipe-hint">Swipe left for word-by-word translation.</p>
      </header>
      <div class="reader-pane" id="reader-pane">
        ${topNav}
        <div class="reader-swipe" id="reader-swipe" data-mode="en">
          <div class="reader-swipe-track">
            <div class="reader-swipe-panel reader-swipe-panel--en">
              <div class="verses">${verseCells("en")}</div>
              ${nextNav}
            </div>
            <div class="reader-swipe-panel reader-swipe-panel--wbw" aria-live="polite">
              <div class="verses" id="wbw-verses">${verseCells("wbw")}</div>
              ${nextNav}
            </div>
          </div>
        </div>
      </div>
    </section>
  `;

  bindVerseBookmarks(surah.number);
  bindSurahNav();
  bindPaneSwipe(surah.number);
  syncSwipeHeight();
  ensureWbw(surah.number).then(() => {
    fillAllWbw(surah.number);
    syncSwipeHeight();
  });

  const pane = document.getElementById("reader-pane");
  const target = scrollTo ? document.getElementById(`a${scrollTo}`) : null;
  requestAnimationFrame(() => {
    syncSwipeHeight();
    if (target && pane) {
      const y =
        target.getBoundingClientRect().top - pane.getBoundingClientRect().top + pane.scrollTop;
      pane.scrollTop = Math.max(0, y - 12);
    } else if (pane) {
      pane.scrollTop = 0;
    }
  });
}

function updateSwipeHint(mode) {
  const hint = document.getElementById("pane-swipe-hint");
  if (!hint) return;
  hint.textContent =
    mode === "wbw"
      ? "Swipe right for regular translation."
      : "Swipe left for word-by-word translation.";
}

/** Keep scroll height tied to the visible panel (WBW is usually taller than EN). */
function syncSwipeHeight() {
  const swipe = document.getElementById("reader-swipe");
  if (!swipe) return;
  const mode = swipe.dataset.mode === "wbw" ? "wbw" : "en";
  const panel = swipe.querySelector(
    mode === "wbw" ? ".reader-swipe-panel--wbw" : ".reader-swipe-panel--en"
  );
  if (!panel) return;
  swipe.style.height = `${panel.scrollHeight}px`;
}

function bindSurahNav() {
  document.querySelectorAll("[data-go-surah]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.getAttribute("data-go-surah"));
      if (!Number.isInteger(n)) return;
      setBookmark(n, 1);
      // Replace so phone edge-back returns home, not the prior surah.
      openReader(n, 1, { replace: true });
    });
  });
}

function bindVerseBookmarks(surahNum) {
  document.querySelectorAll(".verse").forEach((el) => {
    let timer = null;
    let moved = false;

    const clear = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const arm = () => {
      moved = false;
      clear();
      timer = setTimeout(() => {
        timer = null;
        if (moved) return;
        const ayah = Number(el.dataset.ayah);
        setBookmark(surahNum, ayah);
        paintMarks(surahNum);
        document.querySelectorAll(`.verse[data-ayah="${ayah}"]`).forEach((node) => {
          node.classList.add("bookmark-flash");
          setTimeout(() => node.classList.remove("bookmark-flash"), 450);
        });
        if (navigator.vibrate) navigator.vibrate(18);
      }, LONG_PRESS_MS);
    };

    el.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      arm();
    });
    el.addEventListener("pointermove", (e) => {
      if (!timer) return;
      if (Math.abs(e.movementX) + Math.abs(e.movementY) > 8) {
        moved = true;
        clear();
      }
    });
    el.addEventListener("pointerup", clear);
    el.addEventListener("pointercancel", clear);
    el.addEventListener("pointerleave", clear);
    el.addEventListener("contextmenu", (e) => e.preventDefault());
  });
}

function bindPaneSwipe(surahNum) {
  const swipe = document.getElementById("reader-swipe");
  if (!swipe) return;

  let startX = 0;
  let startY = 0;
  let tracking = false;

  const onStart = (x, y) => {
    startX = x;
    startY = y;
    tracking = true;
  };

  const onEnd = async (x, y) => {
    if (!tracking) return;
    tracking = false;
    const dx = x - startX;
    const dy = y - startY;
    if (Math.abs(dx) < SWIPE_MIN_X || Math.abs(dx) < Math.abs(dy) * 1.2) return;

    const fromMode = swipe.dataset.mode === "wbw" ? "wbw" : "en";
    const anchor = captureVerseAnchor(fromMode);

    if (dx < 0) {
      // Switch immediately; pin matching WBW verse top to the same screen Y.
      // If already at surah end, stay at the end of the other panel.
      swipe.dataset.mode = "wbw";
      updateSwipeHint("wbw");
      syncSwipeHeight();
      restoreAfterSwipe("wbw", anchor);
      // Extra history entry so edge-swipe back exits WBW → English, not home.
      if (!history.state?.iqraWbw) {
        history.pushState({ iqraWbw: true }, "", location.href);
      }
      ensureWbw(surahNum).then(() => {
        fillAllWbw(surahNum);
        syncSwipeHeight();
        restoreAfterSwipe("wbw", anchor);
      });
    } else if (fromMode === "wbw") {
      // Prefer history.back() so we consume the WBW history entry (and edge-back too).
      if (history.state?.iqraWbw) {
        pendingWbwExitAnchor = anchor;
        history.back();
      } else {
        swipe.dataset.mode = "en";
        updateSwipeHint("en");
        syncSwipeHeight();
        restoreAfterSwipe("en", anchor);
      }
    }
  };

  swipe.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      onStart(e.touches[0].clientX, e.touches[0].clientY);
    },
    { passive: true }
  );
  swipe.addEventListener(
    "touchend",
    (e) => {
      const t = e.changedTouches[0];
      if (!t) return;
      onEnd(t.clientX, t.clientY);
    },
    { passive: true }
  );
  swipe.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    if (e.button !== 0) return;
    onStart(e.clientX, e.clientY);
  });
  swipe.addEventListener("pointerup", (e) => {
    if (e.pointerType === "touch") return;
    onEnd(e.clientX, e.clientY);
  });
}

/**
 * Anchor = first verse whose top is still on/below the pane top edge
 * (e.g. ayah 54 top mid-screen → anchor 54, not 53).
 * If scrolled inside a tall verse, fall back to that verse (top above the pane).
 * offset = verseTop - paneTop (same screen Y to restore after swipe).
 * atEnd = scrolled to the surah footer (Next button); restore should pin bottom.
 */
function captureVerseAnchor(mode) {
  const pane = document.getElementById("reader-pane");
  const panel = document.querySelector(
    mode === "wbw" ? ".reader-swipe-panel--wbw" : ".reader-swipe-panel--en"
  );
  if (!pane || !panel) return { ayah: 1, offset: 0, atEnd: false };
  const verses = [...panel.querySelectorAll(".verse")];
  if (!verses.length) return { ayah: 1, offset: 0, atEnd: isPaneAtEnd() };

  const paneTop = pane.getBoundingClientRect().top;
  let anchor = verses[0];
  for (const v of verses) {
    const top = v.getBoundingClientRect().top;
    if (top >= paneTop - 0.5) {
      anchor = v;
      break;
    }
    anchor = v;
  }

  return {
    ayah: Number(anchor.dataset.ayah) || 1,
    offset: anchor.getBoundingClientRect().top - paneTop,
    atEnd: isPaneAtEnd(),
  };
}

function isPaneAtEnd(slack = 64) {
  const pane = document.getElementById("reader-pane");
  if (!pane) return false;
  return pane.scrollTop + pane.clientHeight >= pane.scrollHeight - slack;
}

function scrollPaneToEnd() {
  const pane = document.getElementById("reader-pane");
  if (!pane) return;
  pane.scrollTop = pane.scrollHeight;
}

/** After EN↔WBW swipe: keep end-of-surah, otherwise match verse screen Y. */
function restoreAfterSwipe(mode, anchor) {
  if (anchor?.atEnd) {
    scrollPaneToEnd();
    requestAnimationFrame(() => {
      syncSwipeHeight();
      scrollPaneToEnd();
    });
    return;
  }
  alignVerseAnchor(mode, anchor.ayah, anchor.offset);
  requestAnimationFrame(() => alignVerseAnchor(mode, anchor.ayah, anchor.offset));
}

/** Place matching verse top at the exact captured screen offset. */
function alignVerseAnchor(mode, ayah, offset) {
  const pane = document.getElementById("reader-pane");
  const el = document.getElementById(mode === "wbw" ? `w${ayah}` : `a${ayah}`);
  if (!pane || !el) return;
  const paneTop = pane.getBoundingClientRect().top;
  const current = el.getBoundingClientRect().top - paneTop;
  pane.scrollTop += current - offset;
}

async function ensureWbw(surahNum) {
  if (wbwCache.has(surahNum)) return wbwCache.get(surahNum);
  try {
    const res = await fetch(WBW_URL(surahNum));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    wbwCache.set(surahNum, json);
    return json;
  } catch (err) {
    console.warn("Could not load word-by-word data.", err);
    wbwCache.set(surahNum, {});
    return {};
  }
}

function wbwWordsHtml(surahNum, ayah) {
  const table = wbwCache.get(surahNum);
  if (!table) return `<p class="wbw-status">Loading words…</p>`;
  const words = table[String(ayah)] || [];
  if (!words.length) return `<p class="wbw-status">Word-by-word unavailable</p>`;
  // Keep API order exactly; dir=rtl on .wbw places the first token on the right.
  return words
    .map(
      ([ar, en]) => `
      <span class="wbw-word">
        <span class="wbw-ar" lang="ar" dir="rtl">${escapeHtml(ar)}</span>
        <span class="wbw-en" lang="en" dir="ltr">${escapeHtml(en || "")}</span>
      </span>`
    )
    .join("");
}

function fillAllWbw(surahNum) {
  document.querySelectorAll("#wbw-verses .wbw").forEach((mount) => {
    const ayah = Number(mount.dataset.wbwAyah);
    mount.innerHTML = wbwWordsHtml(surahNum, ayah);
  });
}

function setBookmark(surah, ayah) {
  bookmark = normalizeBookmark({ surah, ayah }) || { ...DEFAULT_BOOKMARK };
  try {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(bookmark));
  } catch (err) {
    console.warn("Could not save bookmark on device.", err);
  }
  recordBookmarkProgress(bookmark);
  updateHomeBookmarkLabel();
}

/** Absolute ayah index 1…6236 for a surah:ayah position. */
function ayahIndex(surah, ayah) {
  if (!ayahOffsets || !data) return 1;
  const s = Number(surah);
  const a = Number(ayah);
  if (!Number.isInteger(s) || !Number.isInteger(a)) return 1;
  if (s < 1 || s > data.surahs.length) return 1;
  const count = data.surahs[s - 1].verses.length;
  const clamped = Math.min(Math.max(1, a), count);
  return ayahOffsets[s - 1] + clamped;
}

function buildAyahOffsets() {
  if (!data) {
    ayahOffsets = null;
    return;
  }
  const offsets = [];
  let running = 0;
  for (const surah of data.surahs) {
    offsets.push(running);
    running += surah.verses.length;
  }
  ayahOffsets = offsets;
}

function localDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return { lastIndex: null, days: {} };
    const parsed = JSON.parse(raw);
    const days =
      parsed && typeof parsed.days === "object" && parsed.days && !Array.isArray(parsed.days)
        ? parsed.days
        : {};
    const lastIndex =
      Number.isInteger(parsed?.lastIndex) && parsed.lastIndex > 0 ? parsed.lastIndex : null;
    return { lastIndex, days };
  } catch {
    return { lastIndex: null, days: {} };
  }
}

function saveProgress(progress) {
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch (err) {
    console.warn("Could not save progress on device.", err);
  }
}

/** On first run, anchor lastIndex to the current bookmark without counting progress. */
function ensureProgressSeeded(mark) {
  const progress = loadProgress();
  if (progress.lastIndex != null) return;
  const idx = mark ? ayahIndex(mark.surah, mark.ayah) : 1;
  progress.lastIndex = idx;
  saveProgress(progress);
}

/**
 * One-shot local progress seed via query params, e.g.
 * ?setBookmark=25-59&dayStart=25-50
 * or ?setBookmark=25-59&daysToday=9
 * Sets bookmark and overwrites today's ayah total.
 */
function applyProgressSeedFromUrl() {
  if (!data) return;
  const params = new URLSearchParams(location.search);
  const setRaw = params.get("setBookmark");
  if (!setRaw) return;

  const parseRef = (raw) => {
    const m = String(raw).trim().match(/^(\d+)\s*[:\-.](\d+)$/);
    if (!m) return null;
    return normalizeBookmark({ surah: Number(m[1]), ayah: Number(m[2]) });
  };

  const endMark = parseRef(setRaw);
  if (!endMark) return;

  const endIndex = ayahIndex(endMark.surah, endMark.ayah);
  const daysTodayRaw = params.get("daysToday");
  let delta;
  if (daysTodayRaw != null && daysTodayRaw !== "") {
    delta = Math.max(0, Math.floor(Number(daysTodayRaw)) || 0);
  } else {
    const startMark = params.get("dayStart") ? parseRef(params.get("dayStart")) : null;
    const startIndex = startMark ? ayahIndex(startMark.surah, startMark.ayah) : endIndex;
    delta = Math.max(0, endIndex - startIndex);
  }

  bookmark = endMark;
  try {
    localStorage.setItem(BOOKMARK_KEY, JSON.stringify(endMark));
  } catch (err) {
    console.warn("Could not save bookmark on device.", err);
  }

  const progress = loadProgress();
  progress.lastIndex = endIndex;
  progress.days = trimProgressDays(progress.days || {});
  // Overwrite today (do not add to a prior inflated total).
  if (delta > 0) progress.days[localDateKey()] = delta;
  else delete progress.days[localDateKey()];
  saveProgress(progress);

  params.delete("setBookmark");
  params.delete("dayStart");
  params.delete("daysToday");
  const q = params.toString();
  history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash || "#/"}`);
}

function trimProgressDays(days, keepDays = PROGRESS_KEEP_DAYS) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - (keepDays - 1));
  const cutoffKey = localDateKey(cutoff);
  const next = {};
  for (const [key, value] of Object.entries(days)) {
    if (key >= cutoffKey && Number.isFinite(value) && value > 0) {
      next[key] = Math.floor(value);
    }
  }
  return next;
}

/** Max ayahs one bookmark set may count as reading (larger = reposition/jump). */
const MAX_COUNTED_JUMP = 200;

/** Count forward-only ayah advances toward today's bar. */
function recordBookmarkProgress(mark) {
  if (!mark || !data) return;
  const newIndex = ayahIndex(mark.surah, mark.ayah);
  const progress = loadProgress();
  const today = localDateKey();

  if (progress.lastIndex == null) {
    progress.lastIndex = newIndex;
    progress.days = trimProgressDays(progress.days || {});
    saveProgress(progress);
    return;
  }

  const delta = Math.max(0, newIndex - progress.lastIndex);
  // Large jumps are treated as repositioning, not a reading session.
  if (delta > 0 && delta <= MAX_COUNTED_JUMP) {
    progress.days[today] = (Number(progress.days[today]) || 0) + delta;
  }
  progress.lastIndex = newIndex;
  progress.days = trimProgressDays(progress.days);
  saveProgress(progress);
}

/** Last 7 local calendar days (oldest → today) for the home histogram. */
function getWeekProgress() {
  const progress = loadProgress();
  const days = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const key = localDateKey(d);
    days.push({
      key,
      label: WEEKDAY_LABELS[d.getDay()],
      value: Math.max(0, Math.floor(Number(progress.days[key]) || 0)),
      isToday: i === 0,
    });
  }
  return days;
}

function totalAyahCount() {
  if (!data?.surahs?.length || !ayahOffsets) return 6236;
  const last = data.surahs.length - 1;
  return ayahOffsets[last] + data.surahs[last].verses.length;
}

/**
 * Daily pace for ETA:
 * - today only (no earlier days with progress) → today's ayah count
 * - otherwise → sum from first reading day through today ÷ span in days
 *   (first day 15 days ago → ÷ 15). Lookback capped at 30 days.
 */
function estimatedDailyRate() {
  const progress = loadProgress();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayCount = Math.max(
    0,
    Math.floor(Number(progress.days[localDateKey(today)]) || 0)
  );

  let earliestOffset = null;
  let sum = 0;
  for (let i = 0; i < 30; i++) {
    const cursor = new Date(today);
    cursor.setDate(today.getDate() - i);
    const value = Math.max(0, Math.floor(Number(progress.days[localDateKey(cursor)]) || 0));
    if (value > 0) {
      sum += value;
      earliestOffset = i;
    }
  }

  if (earliestOffset == null || earliestOffset === 0) return todayCount;
  return sum / earliestOffset;
}

/** @returns {Date | null} */
function estimatedCompletionDate() {
  if (!bookmark) return null;
  const remaining = totalAyahCount() - ayahIndex(bookmark.surah, bookmark.ayah);
  if (remaining <= 0) {
    const done = new Date();
    done.setHours(0, 0, 0, 0);
    return done;
  }
  const rate = estimatedDailyRate();
  if (!(rate > 0)) return null;
  const daysNeeded = Math.ceil(remaining / rate);
  const eta = new Date();
  eta.setHours(0, 0, 0, 0);
  eta.setDate(eta.getDate() + daysNeeded);
  return eta;
}

function formatCompletionDate(date) {
  if (!date) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function weekProgressHtml() {
  const days = getWeekProgress();
  const max = Math.max(1, ...days.map((d) => d.value));
  const completionLabel = formatCompletionDate(estimatedCompletionDate());
  const bars = days
    .map((d) => {
      const pct = Math.round((d.value / max) * 100);
      const todayClass = d.isToday ? " is-today" : "";
      const title = `${d.key}: ${d.value} ayah${d.value === 1 ? "" : "s"}`;
      const valueLabel = d.value > 0 ? String(d.value) : "";
      const emptyClass = d.value === 0 ? " is-empty" : "";
      return `
        <div class="week-bar${todayClass}${emptyClass}" title="${escapeHtml(title)}">
          <div class="week-bar-track" aria-hidden="true">
            <div class="week-bar-stack" style="height:${pct}%">
              <span class="week-bar-value">${escapeHtml(valueLabel)}</span>
              <div class="week-bar-fill"></div>
            </div>
          </div>
          <span class="week-bar-label">${d.label}</span>
        </div>`;
    })
    .join("");
  return `
    <div class="week-progress" aria-label="Ayahs progressed this week">
      <div class="week-progress-head">
        <span class="week-progress-eta">Estimated completion: ${escapeHtml(completionLabel)}</span>
      </div>
      <div class="week-chart" role="img" aria-label="Last seven days of ayahs progressed">
        ${bars}
      </div>
    </div>`;
}

function loadBookmark() {
  try {
    const raw = localStorage.getItem(BOOKMARK_KEY);
    if (!raw) return { ...DEFAULT_BOOKMARK };
    return normalizeBookmark(JSON.parse(raw)) || { ...DEFAULT_BOOKMARK };
  } catch {
    return { ...DEFAULT_BOOKMARK };
  }
}

function normalizeBookmark(value) {
  if (!value || !data) return null;
  const surah = Number(value.surah);
  const ayah = Number(value.ayah);
  if (!Number.isInteger(surah) || !Number.isInteger(ayah)) return null;
  const chapter = data.surahs[surah - 1];
  if (!chapter) return null;
  if (ayah < 1 || ayah > chapter.verses.length) return null;
  return { surah, ayah };
}

function updateHomeBookmarkLabel() {
  const label = document.getElementById("bookmark-label");
  if (!label || !bookmark || !data) return;
  const surah = data.surahs[bookmark.surah - 1];
  if (!surah) return;
  label.textContent = `${surah.nameEn} · ${bookmark.surah}:${bookmark.ayah}`;
}

/** Next reading aim: end of the current ruku, or the following ruku if already at the end. */
function getAimVerse(mark) {
  if (!mark || !data) return null;
  const surah = data.surahs[mark.surah - 1];
  const verse = surah?.verses[mark.ayah - 1];
  if (!verse) return null;

  const ruku = data.rukus[verse.ruku - 1];
  if (!ruku) return null;

  const atRukuEnd = mark.surah === ruku.last.surah && mark.ayah === ruku.last.ayah;

  if (!atRukuEnd) {
    return { surah: ruku.last.surah, ayah: ruku.last.ayah };
  }

  const nextRuku = data.rukus[verse.ruku];
  if (!nextRuku) return null;
  return { surah: nextRuku.last.surah, ayah: nextRuku.last.ayah };
}

function paintMarks(surahNum) {
  const aim = getAimVerse(bookmark);
  document.querySelectorAll(".verse").forEach((el) => {
    const ayah = Number(el.dataset.ayah);
    const isBookmark = bookmark && bookmark.surah === surahNum && bookmark.ayah === ayah;
    const isAim = aim && aim.surah === surahNum && aim.ayah === ayah;
    el.classList.toggle("is-bookmark", Boolean(isBookmark));
    el.classList.toggle("is-aim", Boolean(isAim));
  });
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function splitTanzilBism(surahNum, verse) {
  if (verse.number !== 1 || surahNum === 1 || surahNum === 9) {
    return { bism: null, body: verse.ar };
  }
  const parts = verse.ar.split(/\s+/);
  if (parts.length <= 4) return { bism: null, body: verse.ar };
  return { bism: parts.slice(0, 4).join(" "), body: parts.slice(4).join(" ") };
}
