// ==UserScript==
// @name         DroqsDB Overseas Stock Reporter
// @namespace    https://droqsdb.com/
// @version      1.3.7
// @description  Collects overseas shop stock+prices and uploads to droqsdb.com
// @author       Droq
// @match        https://www.torn.com/page.php?sid=travel*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const API_URL = "https://droqsdb.com/api/report-stock";

  const KNOWN_COUNTRIES = new Set([
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
  ]);

  const SHOP_NAMES = ["General Store", "Arms Dealer", "Black Market"];

  // ---------------- Badge (ONLY during upload) ----------------
  let badgeEl = null;
  let hideTimer = null;

  function ensureBadge() {
    if (badgeEl) return badgeEl;
    badgeEl = document.createElement("div");
    badgeEl.style.position = "fixed";
    badgeEl.style.right = "10px";
    badgeEl.style.bottom = "10px";
    badgeEl.style.zIndex = "999999";
    badgeEl.style.padding = "8px 10px";
    badgeEl.style.borderRadius = "10px";
    badgeEl.style.fontSize = "12px";
    badgeEl.style.fontFamily = "Arial, sans-serif";
    badgeEl.style.whiteSpace = "pre-line";
    badgeEl.style.boxShadow = "0 8px 20px rgba(0,0,0,0.35)";
    badgeEl.style.background = "rgba(0,0,0,0.85)";
    badgeEl.style.color = "#fff";
    badgeEl.style.display = "none";
    (document.body || document.documentElement).appendChild(badgeEl);
    return badgeEl;
  }

  function showBadge(text) {
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    el.textContent = text;
    el.style.display = "block";
  }

  function hideBadgeSoon(ms = 1200) {
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      el.style.display = "none";
      el.textContent = "";
    }, ms);
  }

  // ---------------- Utils ----------------
  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function parseMoney(text) {
    const t = norm(text);
    const m = t.match(/\$[\s]*([\d,]+)/);
    if (!m) return null;
    const n = Number(String(m[1]).replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }

  function parseIntSafe(text) {
    const t = norm(text).replace(/,/g, "");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n)) return null;
    return Math.trunc(n);
  }

  function isValidName(name) {
    const n = norm(name);
    if (n.length < 2 || n.length > 80) return false;
    if (n.startsWith("$")) return false;
    if (!/[A-Za-z]/.test(n)) return false;     // must contain letters
    if (/^[\d\s,.$-]+$/.test(n)) return false; // reject numeric/currency-only
    return true;
  }

  function normalizeShop(shopText) {
    const t = norm(shopText).toLowerCase();
    if (!t) return null;
    if (t.includes("general")) return "General Store";
    if (t.includes("arms")) return "Arms Dealer";
    if (t.includes("black")) return "Black Market";
    return null;
  }

  // ---------------- Country detection ----------------
  function getCountryName() {
    // Use the info banner text: "You are in Mexico and have $..."
    const pageText = norm(document.body?.innerText || "");
    const m = pageText.match(/You are in\s+([A-Za-z ]+?)\s+and have\b/i);
    if (m) {
      const candidate = norm(m[1]);
      if (KNOWN_COUNTRIES.has(candidate)) return candidate;
    }

    // Backup: exact header match
    const headers = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5"))
      .map((el) => norm(el.textContent))
      .filter(Boolean);

    for (const h of headers) {
      if (KNOWN_COUNTRIES.has(h)) return h;
    }

    return null;
  }

  // ---------------- Scrape (STRICT using confirmed DOM) ----------------
  function getShopHeaders() {
    // <h5 class="shopHeader___...">General Store</h5>
    return Array.from(document.querySelectorAll('h5[class*="shopHeader"]'))
      .map((el) => ({ el, text: norm(el.textContent) }))
      .filter((h) => SHOP_NAMES.includes(h.text));
  }

  function getRowsBetween(startEl, endEl) {
    // We will walk the DOM in document order from startEl to endEl and collect rows.
    // Row container looks like: <div class="row___wHVtu"> ... </div>
    const rows = [];

    let node = startEl;
    // helper: next node in DOM order
    const nextNode = (n) => {
      if (n.firstElementChild) return n.firstElementChild;
      while (n) {
        if (n.nextElementSibling) return n.nextElementSibling;
        n = n.parentElement;
      }
      return null;
    };

    // Move to the next node after header
    node = nextNode(startEl);

    while (node && node !== endEl) {
      if (
        node.nodeType === 1 &&
        node.classList &&
        Array.from(node.classList).some((c) => c.startsWith("row___"))
      ) {
        rows.push(node);
      }
      node = nextNode(node);
    }

    return rows;
  }

  function extractItemFromRow(rowEl, shop) {
    // Name:
    const nameBtn = rowEl.querySelector('button[class*="itemNameButton"]');
    const name = nameBtn ? norm(nameBtn.textContent) : null;
    if (!isValidName(name)) return null;

    // Cost:
    const priceEl = rowEl.querySelector('span[class*="displayPrice"]');
    const cost = priceEl ? parseMoney(priceEl.textContent) : null;

    // Stock:
    const stockEl = rowEl.querySelector('div[data-tt-content-type="stock"]');
    let stock = null;
    if (stockEl) {
      // contains srOnly + number, but textContent ends in the number
      const raw = norm(stockEl.textContent);
      const mm = raw.match(/(\d[\d,]*)\s*$/);
      stock = mm ? parseIntSafe(mm[1]) : parseIntSafe(raw);
    }

    if (cost === null || stock === null) return null;

    return {
      name,
      stock,
      cost,
      shop,
      category: shop, // exactly matches the 3 headers
    };
  }

  function collectItems() {
    const shopHeaders = getShopHeaders();
    if (!shopHeaders.length) return [];

    const allItems = [];
    const seen = new Set();

    for (let i = 0; i < shopHeaders.length; i++) {
      const { el: headerEl, text: shopText } = shopHeaders[i];
      const shop = normalizeShop(shopText);
      if (!shop) continue;

      const endEl = shopHeaders[i + 1]?.el || null;

      const rows = getRowsBetween(headerEl, endEl);

      for (const row of rows) {
        const item = extractItemFromRow(row, shop);
        if (!item) continue;

        const key = `${item.shop}::${item.name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push(item);
      }
    }

    return allItems;
  }

  // ---------------- Upload ----------------
  async function uploadReport(country, items) {
    const payload = JSON.stringify({ country, items });

    if (typeof GM_xmlhttpRequest === "function") {
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: API_URL,
          headers: { "Content-Type": "application/json" },
          data: payload,
          timeout: 20000,
          onload: (res) => {
            if (res.status >= 200 && res.status < 300) resolve(true);
            else reject(new Error(`HTTP ${res.status}`));
          },
          onerror: () => reject(new Error("Network error")),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      mode: "cors",
      credentials: "omit",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return true;
  }

  // ---------------- Run loop ----------------
  let lastSignature = null;

  async function scanAndMaybeUpload() {
    // Only run on travel page (already matched, but keep safe)
    if (!location.href.includes("page.php?sid=travel")) return;

    const country = getCountryName();
    if (!country) return; // no badge, no noise

    const items = collectItems();
    if (!items.length) return; // no badge, no noise

    const sig =
      country +
      "::" +
      items
        .map((i) => `${i.shop}|${i.name}|${i.stock}|${i.cost}`)
        .join(";");

    if (sig === lastSignature) return; // no badge, no noise
    lastSignature = sig;

    // Badge ONLY during upload
    showBadge(`DroqsDB Uploading…\n${country}\nItems: ${items.length}`);

    try {
      await uploadReport(country, items);
      showBadge(`DroqsDB Uploaded ✓\n${country}\nItems: ${items.length}`);
      hideBadgeSoon(900);
    } catch (e) {
      showBadge(`DroqsDB Upload Failed\n${country}\n${String(e.message || e)}`);
      hideBadgeSoon(2000);
    }
  }

  // Run once after load, then observe changes (React-style UI updates)
  scanAndMaybeUpload();

  const obs = new MutationObserver(() => {
    if (window.__droqsdb_scan_timer) clearTimeout(window.__droqsdb_scan_timer);
    window.__droqsdb_scan_timer = setTimeout(scanAndMaybeUpload, 500);
  });

  obs.observe(document.documentElement, { childList: true, subtree: true });
})();
