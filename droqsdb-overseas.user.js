// ==UserScript==
// @name         DroqsDB - Overseas Shop Auto Reporter (Torn + TornPDA)
// @namespace    https://droqsdb.com/
// @version      1.3.1
// @description  Collects overseas shop prices/stock and submits them to DroqsDB. Quiet UI; TornPDA table/cart-icon support.
// @author       Droq
// @match        https://www.torn.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";
  const MAX_ITEMS = 300;

  // Badge behavior
  const AUTO_HIDE_MS = 2500;
  const FAILSAFE_HIDE_MS = 7000;

  // Prevent spam uploads when navigating around overseas pages
  const UPLOAD_COOLDOWN_MS = 60 * 1000;

  // --------- Known overseas locations (must match server) ----------
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

  // ---------- UI BADGE (CREATED ONCE, HIDDEN BY DEFAULT) ----------
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

    // failsafe: badge can never stay forever
    failsafeTimer = setTimeout(() => {
      badge.style.display = "none";
    }, FAILSAFE_HIDE_MS);
  }

  function hideBadge(afterMs = 0) {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      badge.style.display = "none";
      if (failsafeTimer) clearTimeout(failsafeTimer);
      failsafeTimer = null;
    }, Math.max(0, afterMs));
  }

  // extra safety on SPA-ish transitions
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

  // ---------- COUNTRY DETECTION ----------
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
      const candidate = normalizeCountryCandidate(m[1]);
      if (candidate) return candidate;
    }

    const fromScan = scanForKnownCountry(bodyText);
    if (fromScan) return fromScan;

    return null;
  }

  function askCountryOverride() {
    const options = COUNTRY_NAMES.map((c, i) => `${i + 1}) ${c}`).join("\n");
    const input = prompt(
      "DroqsDB: Could not detect your overseas country (TornPDA layout differs).\n\nChoose the number:\n" +
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

  // ---------- SHOP / CATEGORY ----------
  function normalizeShopName(raw) {
    const t = norm(raw).toLowerCase();
    if (!t) return null;
    if (t.includes("general")) return "General Store";
    if (t.includes("arms")) return "Arms Dealer";
    if (t.includes("black")) return "Black Market";
    return null;
  }

  function findShopLabelForTable(tableEl) {
    // Look upward for a nearby heading like "General Store"
    let el = tableEl;
    for (let up = 0; up < 12 && el; up++) {
      // check siblings above
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

  // ---------- TornPDA-friendly detection: overseas shop table ----------
  function isOverseasShopTable(table) {
    const headerText = norm(table.innerText).toLowerCase();
    // Must contain these headers somewhere
    return (
      headerText.includes("name") &&
      headerText.includes("stock") &&
      headerText.includes("cost") &&
      headerText.includes("buy")
    );
  }

  function getOverseasTables() {
    const tables = [...document.querySelectorAll("table")];
    return tables.filter(isOverseasShopTable);
  }

  function collectItemsFromTables() {
    const items = [];
    const seen = new Set();

    const tables = getOverseasTables();
    for (const table of tables) {
      const shop = findShopLabelForTable(table) || "Uncategorized";

      const rows = [...table.querySelectorAll("tr")];
      for (const tr of rows) {
        const tds = [...tr.querySelectorAll("td")];
        // Expect at least: Item | Name | Stock | Cost | Buy
        if (tds.length < 4) continue;

        // Name is typically the second column in TornPDA table
        const name = norm(tds[1]?.textContent);
        if (!name) continue;

        // Stock / Cost columns
        // Based on your screenshot: columns are Item, Name, Stock, Cost, Buy
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

  // ---------- SUBMIT ----------
  function submit(country, items) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: API_URL,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ country, items: items.slice(0, MAX_ITEMS) }),
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve();
          else reject(`HTTP ${res.status}`);
        },
        onerror: () => reject("Network error"),
      });
    });
  }

  // ---------- COOLDOWN (per-country) ----------
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

  // ---------- MAIN ----------
  async function run() {
    // Only do anything if we can see an overseas shop table (prevents Travel page badge spam)
    for (let i = 0; i < 16; i++) {
      if (getOverseasTables().length) break;
      await sleep(250);
    }
    if (!getOverseasTables().length) return;

    // Detect country
    let country = null;
    for (let i = 0; i < 10; i++) {
      country = detectCountry();
      if (country) break;
      await sleep(200);
    }
    if (!country) {
      // Only ask if we ARE on a shop table page
      country = askCountryOverride();
      if (!country) return;
    }

    if (recentlyUploaded(country)) return;

    showBadge("DroqsDB: scanning…");

    const items = collectItemsFromTables();

    if (!items.length) {
      showBadge(`DroqsDB: no items found\n${country}`);
      hideBadge(AUTO_HIDE_MS);
      return;
    }

    // simple shop breakdown for debugging
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
    }
  }

  run();
})();
