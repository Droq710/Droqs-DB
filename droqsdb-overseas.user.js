// ==UserScript==
// @name         DroqsDB - Overseas Shop Auto Reporter (Desktop + TornPDA)
// @namespace    https://droqsdb.com/
// @version      1.3.2
// @description  Collects overseas shop prices/stock and submits them to DroqsDB. Quiet UI; supports Desktop Torn + TornPDA (cart icon). SPA-safe.
// @author       Droq
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";
  const MAX_ITEMS = 300;

  // UI
  const AUTO_HIDE_MS = 2500;
  const FAILSAFE_HIDE_MS = 7000;

  // Avoid spam uploads
  const UPLOAD_COOLDOWN_MS = 60 * 1000;

  // Locations (must match server)
  const COUNTRY_NAMES = [
    "Mexico",
    "Cayman Islands",
    "Canada",
    "Hawaii",
    "United Kingdom",
    "Argentina",
    "Switzerland",
    "Japan",
    "China",
    "UAE",
    "South Africa",
  ];
  const COUNTRY_ALIASES = new Map([
    ["united arab emirates", "UAE"],
    ["uae", "UAE"],
    ["uk", "United Kingdom"],
    ["united kingdom", "United Kingdom"],
    ["cayman", "Cayman Islands"],
    ["cayman islands", "Cayman Islands"],
    ["south africa", "South Africa"],
  ]);

  // ---------- Badge (hidden by default) ----------
  const badge = document.createElement("div");
  badge.style.cssText = `
    position: fixed;
    right: 12px;
    bottom: 12px;
    z-index: 999999;
    background: rgba(0,0,0,0.85);
    color: #fff;
    padding: 10px 12px;
    border: 1px solid #444;
    border-radius: 10px;
    font: 12px/1.3 system-ui, sans-serif;
    white-space: pre-line;
    max-width: 420px;
    display: none;
  `;
  document.documentElement.appendChild(badge);

  let hideTimer = null;
  let failsafeTimer = null;

  function showBadge(text) {
    if (hideTimer) clearTimeout(hideTimer);
    if (failsafeTimer) clearTimeout(failsafeTimer);
    badge.textContent = text;
    badge.style.display = "block";
    failsafeTimer = setTimeout(() => (badge.style.display = "none"), FAILSAFE_HIDE_MS);
  }
  function hideBadge(afterMs = 0) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      badge.style.display = "none";
      if (failsafeTimer) clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }, Math.max(0, afterMs));
  }
  window.addEventListener("pagehide", () => (badge.style.display = "none"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) badge.style.display = "none";
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

  function parseMoney(txt) {
    const m = (txt || "").match(/\$\s*([0-9][0-9,]*)/);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }
  function parseIntFromText(txt) {
    const m = (txt || "").match(/([0-9][0-9,]*)/);
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- Country detection ----------
  function normalizeCountryCandidate(s) {
    const t = norm(s).toLowerCase();
    if (!t) return null;

    for (const name of COUNTRY_NAMES) {
      if (t === name.toLowerCase()) return name;
    }
    if (COUNTRY_ALIASES.has(t)) return COUNTRY_ALIASES.get(t);
    return null;
  }

  function scanForKnownCountry(text) {
    const t = norm(text).toLowerCase();
    if (!t) return null;

    for (const name of COUNTRY_NAMES) {
      const n = name.toLowerCase();
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      if (re.test(t)) return name;
    }
    for (const [alias, canonical] of COUNTRY_ALIASES.entries()) {
      const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\b`, "i");
      if (re.test(t)) return canonical;
    }
    return null;
  }

  function detectCountry() {
    try {
      const saved = sessionStorage.getItem("droqsdb_country_override");
      const normalized = normalizeCountryCandidate(saved);
      if (normalized) return normalized;
    } catch {}

    const fromTitle = scanForKnownCountry(document.title || "");
    if (fromTitle) return fromTitle;

    const bodyText = document.body?.innerText || "";
    const m = bodyText.match(/You are in\s+([A-Za-z\s]+?)(?:\s+and|\s+\$|\s+\.|\s*,|\n)/i);
    if (m && m[1]) {
      const c = normalizeCountryCandidate(m[1]);
      if (c) return c;
    }
    return scanForKnownCountry(bodyText);
  }

  function askCountryOverride() {
    const options = COUNTRY_NAMES.map((c, i) => `${i + 1}) ${c}`).join("\n");
    const input = prompt(
      "DroqsDB: Could not detect your overseas country.\n\nChoose the number:\n" +
        options +
        "\n\n(We’ll remember for this session.)"
    );
    if (!input) return null;
    const idx = Number(String(input).trim());
    if (!Number.isFinite(idx) || idx < 1 || idx > COUNTRY_NAMES.length) return null;
    const chosen = COUNTRY_NAMES[idx - 1];
    try {
      sessionStorage.setItem("droqsdb_country_override", chosen);
    } catch {}
    return chosen;
  }

  // ---------- Shop/category ----------
  function normalizeShopName(raw) {
    const t = norm(raw).toLowerCase();
    if (!t) return null;
    if (t.includes("general")) return "General Store";
    if (t.includes("arms")) return "Arms Dealer";
    if (t.includes("black")) return "Black Market";
    return null;
  }

  // ---------- Desktop collector (BUY buttons) ----------
  function getBuyButtonsDesktop() {
    const btns = [...document.querySelectorAll("button, input, a, div[role='button']")];
    return btns.filter((el) => {
      const t = norm(el.textContent || el.value);
      return t && t.toLowerCase() === "buy";
    });
  }

  function findNearestShopLabel(startEl) {
    let el = startEl;
    for (let i = 0; i < 10 && el; i++) {
      const headings = el.querySelectorAll(
        "h1,h2,h3,h4,[role='heading'],div[class*='title'],div[class*='header'],span[class*='title']"
      );
      for (const h of headings) {
        const shop = normalizeShopName(h.textContent);
        if (shop) return shop;
      }
      el = el.parentElement;
    }
    return null;
  }

  function parseFromTableRowDesktop(buyEl) {
    const tr = buyEl.closest("tr");
    if (!tr) return null;

    const tds = [...tr.querySelectorAll("td")];
    // old desktop layout often: [icon][name][...][cost][stock][buy]
    if (tds.length < 4) return null;

    const name = norm(tds[1]?.textContent);
    const cost = parseMoney(norm(tds[3]?.textContent));
    const stock = parseIntFromText(norm(tds[4]?.textContent || tr.textContent));

    if (!name || cost == null || stock == null) return null;
    const shop = findNearestShopLabel(tr) || "Uncategorized";
    return { name, cost, stock, shop };
  }

  function findRowContainerFromBuy(buyEl) {
    let el = buyEl;
    for (let i = 0; i < 14 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const t = norm(el.innerText);
      if (t.length < 1200 && t.includes("$") && /[0-9]/.test(t)) return el;
    }
    return null;
  }

  function parseFromRowContainer(rowEl) {
    const nameEl =
      rowEl.querySelector("button[class*='itemNameButton']") ||
      rowEl.querySelector("[class*='itemName']") ||
      rowEl.querySelector("a[class*='item']");

    const name = nameEl ? norm(nameEl.textContent) : null;

    const priceEl = rowEl.querySelector("span[class*='displayPrice'], [class*='price'], [class*='cost']");
    const cost = priceEl ? parseMoney(norm(priceEl.textContent)) : parseMoney(norm(rowEl.innerText));

    let stock = null;
    const stockEl = rowEl.querySelector("[data-tt-content-type='stock'], [class*='stock']");
    if (stockEl) stock = parseIntFromText(norm(stockEl.textContent));
    if (stock == null) {
      const labeled = norm(rowEl.innerText).match(/\bStock\b[^0-9]*([0-9][0-9,]*)/i);
      if (labeled) stock = parseIntFromText(labeled[1]);
    }

    if (!name || cost == null || stock == null) return null;
    const shop = findNearestShopLabel(rowEl) || "Uncategorized";
    return { name, cost, stock, shop };
  }

  function collectItemsDesktop() {
    const out = new Map();
    for (const buy of getBuyButtonsDesktop()) {
      let item = parseFromTableRowDesktop(buy);
      if (!item) {
        const row = findRowContainerFromBuy(buy);
        if (row) item = parseFromRowContainer(row);
      }
      if (item) out.set(item.name.toLowerCase(), item);
    }
    return [...out.values()];
  }

  // ---------- TornPDA collector (tables with cart icons) ----------
  function isOverseasShopTable(table) {
    const t = norm(table.innerText).toLowerCase();
    return t.includes("name") && t.includes("stock") && t.includes("cost") && t.includes("buy");
  }

  function getOverseasTables() {
    return [...document.querySelectorAll("table")].filter(isOverseasShopTable);
  }

  function findShopLabelForTable(tableEl) {
    let el = tableEl;
    for (let up = 0; up < 12 && el; up++) {
      let sib = el;
      for (let back = 0; back < 12 && sib; back++) {
        sib = sib.previousElementSibling;
        if (!sib) break;
        const shop = normalizeShopName(sib.textContent);
        if (shop) return shop;
        const hs = sib.querySelectorAll("h1,h2,h3,h4,[role='heading']");
        for (const h of hs) {
          const s = normalizeShopName(h.textContent);
          if (s) return s;
        }
      }
      el = el.parentElement;
    }
    return null;
  }

  function collectItemsTornPDA() {
    const items = [];
    const seen = new Set();

    const tables = getOverseasTables();
    for (const table of tables) {
      const shop = findShopLabelForTable(table) || "Uncategorized";
      const rows = [...table.querySelectorAll("tr")];

      for (const tr of rows) {
        const tds = [...tr.querySelectorAll("td")];
        // expected columns: Item | Name | Stock | Cost | Buy
        if (tds.length < 4) continue;

        const name = norm(tds[1]?.textContent);
        if (!name) continue;

        const stock = parseIntFromText(norm(tds[2]?.textContent));
        const cost = parseMoney(norm(tds[3]?.textContent));
        if (stock == null || cost == null) continue;

        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({ name, stock, cost, shop });
      }
    }
    return items;
  }

  // ---------- Submit ----------
  function submit(country, items) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: API_URL,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ country, items: items.slice(0, MAX_ITEMS) }),
        onload: (res) => (res.status >= 200 && res.status < 300 ? resolve() : reject(`HTTP ${res.status}`)),
        onerror: () => reject("Network error"),
      });
    });
  }

  // ---------- Cooldown ----------
  function cooldownKey(country) {
    return `droqsdb_last_upload_${(country || "").toLowerCase()}`;
  }
  function recentlyUploaded(country) {
    try {
      const v = sessionStorage.getItem(cooldownKey(country));
      const t = v ? Number(v) : 0;
      return Number.isFinite(t) && Date.now() - t < UPLOAD_COOLDOWN_MS;
    } catch {
      return false;
    }
  }
  function markUploaded(country) {
    try {
      sessionStorage.setItem(cooldownKey(country), String(Date.now()));
    } catch {}
  }

  // ---------- Run once when shop appears ----------
  let hasRun = false;

  async function tryRun() {
    if (hasRun) return;

    // Detect which UI we’re on
    const hasTornPDA = getOverseasTables().length > 0;
    const hasDesktop = getBuyButtonsDesktop().length > 0;

    // Only proceed if we see a shop UI
    if (!hasTornPDA && !hasDesktop) return;

    // country
    let country = detectCountry();
    if (!country) country = askCountryOverride();
    if (!country) return;

    if (recentlyUploaded(country)) return;

    hasRun = true; // lock to prevent repeated uploads on SPA refreshes
    showBadge("DroqsDB: scanning…");

    const items = hasTornPDA ? collectItemsTornPDA() : collectItemsDesktop();

    if (!items.length) {
      showBadge(`DroqsDB: no items found\n${country}`);
      hideBadge(AUTO_HIDE_MS);
      hasRun = false; // allow retry if UI finishes loading
      return;
    }

    const counts = items.reduce((acc, it) => {
      const k = it.shop || "Uncategorized";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const breakdown = Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(" | ");

    showBadge(`DroqsDB: uploading ${items.length} items…\n${country}\n${breakdown}`);

    try {
      await submit(country, items);
      markUploaded(country);
      showBadge(`DroqsDB: uploaded ✓\n${country}\nItems: ${items.length}`);
      hideBadge(AUTO_HIDE_MS);
    } catch (e) {
      showBadge(`DroqsDB: upload failed ✗\n${country}\n${String(e)}`);
      hideBadge(AUTO_HIDE_MS);
      hasRun = false; // allow retry after failure
    }
  }

  // Initial attempt + SPA-safe observer
  tryRun();

  const obs = new MutationObserver(() => {
    // If shop UI appears later via AJAX, this will catch it
    tryRun();
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });

})();
