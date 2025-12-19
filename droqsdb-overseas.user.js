// ==UserScript==
// @name         DroqsDB - Overseas Shop Auto Reporter (Desktop + TornPDA)
// @namespace    https://droqsdb.com/
// @version      1.3.3
// @description  Collects overseas shop prices/stock and submits them to DroqsDB. Quiet UI; supports Desktop Torn + TornPDA. SPA-safe. Forces category/shop so site grouping stays correct.
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

  const AUTO_HIDE_MS = 2500;
  const FAILSAFE_HIDE_MS = 7000;

  const UPLOAD_COOLDOWN_MS = 60 * 1000;

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

  // ---------- Badge ----------
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

  function shopToCategory(shop) {
    const s = (shop || "").toLowerCase();
    if (s.includes("general")) return "General";
    if (s.includes("arms")) return "Arms Dealer";
    if (s.includes("black")) return "Black Market";
    return "Uncategorized";
  }

  function findNearestShopLabel(startEl) {
    let el = startEl;
    for (let i = 0; i < 14 && el; i++) {
      // Look for headings within/near this subtree
      const headings = el.querySelectorAll("h1,h2,h3,h4,[role='heading'],div,span");
      for (const h of headings) {
        const shop = normalizeShopName(h.textContent);
        if (shop) return shop;
      }
      el = el.parentElement;
    }
    return null;
  }

  // ---------- Desktop collector ----------
  function getBuyButtonsDesktop() {
    const btns = [...document.querySelectorAll("button, input, a, div[role='button']")];
    return btns.filter((el) => norm(el.textContent || el.value).toLowerCase() === "buy");
  }

  function parseFromTableRowDesktop(buyEl) {
    const tr = buyEl.closest("tr");
    if (!tr) return null;

    const tds = [...tr.querySelectorAll("td")];
    if (tds.length < 4) return null;

    const name = norm(tds[1]?.textContent);
    // Desktop columns can move; detect cost by $ and stock by integer from right side
    const rowText = norm(tr.textContent);
    const cost = parseMoney(rowText);
    // stock is often near "Stock" column; best effort: pick the largest int in row that isn't cost
    const stock = parseIntFromText(rowText);

    if (!name || cost == null || stock == null) return null;

    const shop = findNearestShopLabel(tr) || "Uncategorized";
    const category = shopToCategory(shop);

    return { name, cost, stock, shop, category };
  }

  function findRowContainerFromBuy(buyEl) {
    let el = buyEl;
    for (let i = 0; i < 16 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const t = norm(el.innerText);
      if (t.length < 1500 && t.includes("$") && /[0-9]/.test(t)) return el;
    }
    return null;
  }

  function parseFromRowContainer(rowEl) {
    const nameEl =
      rowEl.querySelector("button[class*='itemNameButton']") ||
      rowEl.querySelector("[class*='itemName']") ||
      rowEl.querySelector("a[class*='item']");

    const name = nameEl ? norm(nameEl.textContent) : null;
    const text = norm(rowEl.innerText);

    const cost = parseMoney(text);

    // try stock labeled first
    let stock = null;
    const labeled = text.match(/\bStock\b[^0-9]*([0-9][0-9,]*)/i);
    if (labeled) stock = parseIntFromText(labeled[1]);
    if (stock == null) stock = parseIntFromText(text);

    if (!name || cost == null || stock == null) return null;

    const shop = findNearestShopLabel(rowEl) || "Uncategorized";
    const category = shopToCategory(shop);

    return { name, cost, stock, shop, category };
  }

  function collectItemsDesktop() {
    const out = new Map();
    const buys = getBuyButtonsDesktop();
    for (const buy of buys) {
      let item = parseFromTableRowDesktop(buy);
      if (!item) {
        const row = findRowContainerFromBuy(buy);
        if (row) item = parseFromRowContainer(row);
      }
      if (item) out.set(item.name.toLowerCase(), item);
    }
    return [...out.values()];
  }

  // ---------- TornPDA collector ----------
  function looksLikeShopRow(tr) {
    const t = norm(tr.innerText);
    // needs a $ cost and at least one number (stock)
    return t.includes("$") && /[0-9]/.test(t);
  }

  function collectItemsTornPDA() {
    // TornPDA: easiest reliable approach is parse ALL visible shop rows inside tables
    const items = [];
    const seen = new Set();

    const tables = [...document.querySelectorAll("table")];
    for (const table of tables) {
      const rows = [...table.querySelectorAll("tr")].filter(looksLikeShopRow);
      if (rows.length < 3) continue; // avoid random tables

      const shop = findNearestShopLabel(table) || "Uncategorized";
      const category = shopToCategory(shop);

      for (const tr of rows) {
        const tds = [...tr.querySelectorAll("td")];
        if (tds.length < 3) continue;

        // In your TornPDA screenshot: [Item icon] [Name] [Stock] [Cost] [Cart]
        const name = norm(tds[1]?.textContent);
        const stock = parseIntFromText(norm(tds[2]?.textContent));
        const cost = parseMoney(norm(tds[3]?.textContent || tr.textContent));

        if (!name || stock == null || cost == null) continue;

        const key = name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        items.push({ name, stock, cost, shop, category });
      }
    }

    return items;
  }

  // ---------- Submit ----------
  function submit(country, items) {
    // Ensure we always send shop+category
    const payloadItems = items.map((it) => {
      const shop = it.shop || "Uncategorized";
      const category = it.category || shopToCategory(shop);
      return {
        name: it.name,
        stock: it.stock,
        cost: it.cost,
        shop,
        category,
      };
    });

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: "POST",
        url: API_URL,
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({ country, items: payloadItems.slice(0, MAX_ITEMS) }),
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

  // ---------- Run when shop appears (SPA-safe) ----------
  let running = false;

  async function tryRun() {
    if (running) return;

    const hasDesktop = getBuyButtonsDesktop().length > 0;
    // TornPDA: instead of strict header matching, just see if we can parse any items
    const pdaPreview = collectItemsTornPDA();
    const hasPDA = pdaPreview.length > 0;

    if (!hasDesktop && !hasPDA) return;

    let country = detectCountry();
    if (!country) country = askCountryOverride();
    if (!country) return;

    if (recentlyUploaded(country)) return;

    running = true;
    showBadge("DroqsDB: scanning…");

    const items = hasPDA ? pdaPreview : collectItemsDesktop();

    if (!items.length) {
      showBadge(`DroqsDB: no items found\n${country}`);
      hideBadge(AUTO_HIDE_MS);
      running = false;
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
      running = false;
    }
  }

  // initial + observer
  tryRun();
  const obs = new MutationObserver(() => tryRun());
  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
