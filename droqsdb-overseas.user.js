// ==UserScript==
// @name         Droqs DB - Overseas Shop Auto Reporter
// @namespace    https://droqsdb.com/
// @version      1.2.0
// @description  Automatically collects overseas shop prices and stock for Droqs DB
// @author       Droq
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";
  const MAX_ITEMS = 300;

  // ---------- UI BADGE ----------
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
  `;
  document.documentElement.appendChild(badge);
  const setBadge = (t) => (badge.textContent = t);

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
  function detectCountry() {
    // Confirmed element:
    const h = document.querySelector("h4[class*='title___']");
    if (h) return norm(h.textContent);

    const txt = document.body?.innerText || "";
    const m = txt.match(/You are in\s+([A-Za-z\s]+?)\s+and have\s+\$/i);
    if (m) return norm(m[1]);

    return null;
  }

  // ---------- SHOP / CATEGORY DETECTION ----------
  function normalizeShopName(raw) {
    const t = norm(raw).toLowerCase();
    if (!t) return null;

    if (t.includes("general")) return "General Store";
    if (t.includes("arms")) return "Arms Dealer";
    if (t.includes("black")) return "Black Market";

    return null;
  }

  function findNearestShopLabel(startEl) {
    // We try a few strategies:
    // 1) Walk up to a containing "section/card" and look for a header within it.
    // 2) If not found, walk backwards in the DOM looking for a heading-like element.

    // Strategy 1: climb and search within parent blocks
    let el = startEl;
    for (let i = 0; i < 10 && el; i++) {
      // Search for headings in this block
      const headings = el.querySelectorAll("h1,h2,h3,h4,[role='heading'],div[class*='title'],div[class*='header']");
      for (const h of headings) {
        const shop = normalizeShopName(h.textContent);
        if (shop) return shop;
      }

      el = el.parentElement;
    }

    // Strategy 2: search previous siblings / earlier nodes
    // Walk up a bit, then traverse previousElementSibling chain.
    el = startEl;
    for (let climb = 0; climb < 6 && el; climb++) {
      let sib = el;
      for (let back = 0; back < 30 && sib; back++) {
        sib = sib.previousElementSibling;
        if (!sib) break;

        const txt = norm(sib.textContent);
        const shop = normalizeShopName(txt);
        if (shop) return shop;

        const hs = sib.querySelectorAll("h1,h2,h3,h4,[role='heading']");
        for (const h of hs) {
          const s = normalizeShopName(h.textContent);
          if (s) return s;
        }
      }
      el = el.parentElement;
    }

    return null; // unknown
  }

  // ---------- FIND BUY BUTTONS ----------
  function getBuyButtons() {
    const btns = [...document.querySelectorAll("button, input")];
    return btns.filter((el) => norm(el.textContent || el.value).toUpperCase() === "BUY");
  }

  // ---------- PARSE TABLE ROW (PRIMARY) ----------
  function parseFromTableRow(buyEl) {
    const tr = buyEl.closest("tr");
    if (!tr) return null;

    const tds = [...tr.querySelectorAll("td")];
    // Expected: Item | Name | Type | Cost | Stock | Amount | Buy
    if (tds.length < 6) return null;

    const name = norm(tds[1]?.textContent);
    const cost = parseMoney(norm(tds[3]?.textContent));
    const stock = parseIntFromText(norm(tds[4]?.textContent));

    if (!name || cost == null || stock == null) return null;

    const shop = findNearestShopLabel(tr); // <--- NEW
    return { name, cost, stock, shop: shop || "Uncategorized" };
  }

  // ---------- FALLBACK ROW FINDER (NON-TABLE LAYOUTS) ----------
  function findRowContainerFromBuy(buyEl) {
    let el = buyEl;
    for (let i = 0; i < 12 && el; i++) {
      el = el.parentElement;
      if (!el) break;

      const t = norm(el.innerText);
      if (t.length < 800 && t.includes("$") && /[0-9]/.test(t)) return el;
    }
    return null;
  }

  function parseFromRowContainer(rowEl) {
    const nameBtn = rowEl.querySelector("button[class*='itemNameButton']");
    const name = nameBtn ? norm(nameBtn.textContent) : null;

    const priceEl = rowEl.querySelector("span[class*='displayPrice']");
    const stockEl = rowEl.querySelector("[data-tt-content-type='stock']");

    const cost = priceEl ? parseMoney(norm(priceEl.textContent)) : parseMoney(norm(rowEl.innerText));

    let stock = null;
    if (stockEl) {
      stock = parseIntFromText(norm(stockEl.textContent));
    } else {
      const labeled = norm(rowEl.innerText).match(/\bStock\b[^0-9]*([0-9][0-9,]*)/i);
      if (labeled) stock = parseIntFromText(labeled[1]);
    }

    if (!name || cost == null || stock == null) return null;

    const shop = findNearestShopLabel(rowEl); // <--- NEW
    return { name, cost, stock, shop: shop || "Uncategorized" };
  }

  function collectItems() {
    const map = new Map();

    for (const buy of getBuyButtons()) {
      let item = parseFromTableRow(buy);

      if (!item) {
        const row = findRowContainerFromBuy(buy);
        if (row) item = parseFromRowContainer(row);
      }

      if (item) map.set(item.name.toLowerCase(), item);
    }

    return [...map.values()];
  }

  // ---------- SUBMIT (CSP SAFE) ----------
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

  // ---------- MAIN ----------
  async function run() {
    setBadge("Droqs DB: scanning…");

    // Wait for BUY buttons (signals shop loaded)
    for (let i = 0; i < 20; i++) {
      if (getBuyButtons().length) break;
      await sleep(300);
    }

    const country = detectCountry();
    if (!country) {
      setBadge("Droqs DB: can't detect country");
      return;
    }

    const items = collectItems();
    if (!items.length) {
      setBadge(`Droqs DB: ${country}\nNo items found`);
      return;
    }

    // Show a quick breakdown so you can confirm it’s categorizing
    const counts = items.reduce((acc, it) => {
      const k = it.shop || "Uncategorized";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    const breakdown = Object.entries(counts).map(([k,v]) => `${k}: ${v}`).join(" | ");

    setBadge(`Droqs DB: submitting ${items.length} items for ${country}…\n${breakdown}`);

    try {
      await submit(country, items);
      setBadge(`Droqs DB: sent ✓\n${country}\nItems: ${items.length}\n${breakdown}`);
    } catch (e) {
      setBadge(`Droqs DB: submit failed ✗\n${String(e)}`);
    }
  }

  run();
})();
