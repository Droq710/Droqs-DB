// ==UserScript==
// @name         DroqsDB Overseas Stock Reporter
// @namespace    https://droqsdb.com/
// @version      1.6.10
// @description  Collects overseas shop stock+prices and uploads to droqsdb.com (Desktop + TornPDA iOS fallback)
// @author       Droq
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://torn.com/page.php?sid=travel*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      droqsdb.com
// @downloadURL  https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// @updateURL    https://raw.githubusercontent.com/Droq710/Droqs-DB/main/droqsdb-overseas.user.js
// ==/UserScript==

(() => {
  "use strict";

  const SCRIPT_VERSION = "1.6.10";
  const API_URL = "https://droqsdb.com/api/report-stock";
  const COMPANION_TRAVEL_PLANNER_API_URL = "https://droqsdb.com/api/companion/v1/travel-planner/query";
  const COMPANION_COUNTRY_HELPER_API_URL = "https://droqsdb.com/api/companion/v1/country-helper/query";
  const COMPANION_OPTIONS_API_URL = "https://droqsdb.com/api/companion/v1/options";
  const COMPANION_RESPONSE_CACHE_TTL_MS = 45000;
  const PAGE_READY_DEBOUNCE_MS = 250;
  const PAGE_READY_OBSERVER_TIMEOUT_MS = 8000;
  const COMPANION_STATE_DEBOUNCE_MS = 250;
  const TRAVEL_SELECTION_CLEAR_GRACE_MS = 1200;
  const TRAVEL_PLANNER_LAYOUT_GRACE_MS = 1500;
  const TEXT_ONLY_CELL_MAX_LENGTH = 120;
  const ROW_TEXT_MAX_LENGTH = 220;
  const MIN_FALLBACK_ITEMS = 5;
  const SETTINGS_CAPACITY_MIN = 5;
  const SETTINGS_CAPACITY_MAX = 44;
  const SETTINGS_CATEGORY_OPTIONS = Object.freeze([
    { value: "flowers", label: "Flowers" },
    { value: "plushies", label: "Plushies" },
    { value: "drugs", label: "Drugs" },
  ]);
  const LEGACY_TRAVEL_PLANNER_DISPLAY_OPTIONS = Object.freeze([
    { value: "best", label: "Best run only" },
    { value: "top3", label: "Top 3 overall runs" },
    { value: "categories", label: "Special categories (top 3 each)" },
  ]);
  const SETTINGS_TRAVEL_PLANNER_GENERAL_RESULTS_OPTIONS = Object.freeze([
    { value: "best", label: "Best run only" },
    { value: "top3", label: "Top 3 overall" },
  ]);
  const TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS = Object.freeze([
    { value: "plushies", label: "Plushies" },
    { value: "flowers", label: "Flowers" },
    { value: "drugs", label: "Drugs" },
  ]);
  const SETTINGS_SELL_WHERE_OPTIONS = Object.freeze([
    { value: "market", label: "Item Market" },
    { value: "bazaar", label: "Bazaar" },
    { value: "torn", label: "Torn City Shops" },
  ]);
  const COMPANION_SELL_VALUE_LABELS = Object.freeze({
    market: "Item Market Value",
    bazaar: "Bazaar Value",
    torn: "Torn City Shops",
  });
  const SETTINGS_FLIGHT_TYPE_OPTIONS = Object.freeze([
    { value: "standard", label: "Standard" },
    { value: "airstrip", label: "Airstrip" },
    { value: "wlt", label: "WLT" },
    { value: "business", label: "Business" },
  ]);

  // Keep this OFF by default. If you ever need to debug a user’s issue,
  // temporarily set true and it will show extra badge info.
  const DEBUG = false;

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
  const KNOWN_COUNTRY_NAMES = Array.from(KNOWN_COUNTRIES);

  const SHOP_NAMES = ["General Store", "Arms Dealer", "Black Market"];
  const PRICE_TEXT_RE = /\$\s*[0-9][0-9,\s]*(?:\.[0-9]+)?(?:\s*[kKmMbB])?/;
  const STOCK_LABEL_RE = /\b(stock|available|qty|quantity)\b/i;
  const STOCK_PHRASE_RE = /\bin stock\b/i;
  const BLOCKED_ITEM_NAME_KEYS = new Set(
    [...KNOWN_COUNTRIES, ...SHOP_NAMES, "Information", "Item", "Name", "Stock", "Cost", "Price", "Buy", "Available", "Shop"]
      .map((value) => toNameKey(value))
      .filter(Boolean)
  );

  const SETTINGS_STORAGE_KEY = "droqsdb:userscript-settings:v1";
  const UI_STATE_STORAGE_KEY = "droqsdb:userscript-ui-state:v1";
  const LEGACY_BADGE_POSITION_STORAGE_KEY = "droqsdb:overseas-badge-position:v1";
  const SETTINGS_SCHEMA_VERSION = 1;
  const UI_STATE_SCHEMA_VERSION = 1;

  function normalizeSellWhereSetting(value, fallback = "market") {
    return normalizeEnumString(
      value,
      SETTINGS_SELL_WHERE_OPTIONS.map((option) => option.value),
      fallback
    );
  }

  function createDefaultTravelPlannerCategoryGroups() {
    return {
      plushies: false,
      flowers: false,
      drugs: false,
    };
  }

  function createDefaultTravelPlannerSettings() {
    return {
      generalResultsCount: "best",
      categoryGroups: createDefaultTravelPlannerCategoryGroups(),
    };
  }

  function createDefaultSettings() {
    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      mode: "enhanced",
      disableAllUi: false,
      uploadToastEnabled: true,
      showRunCost: true,
      helpers: {
        travelPlannerEnabled: true,
        countryHelperEnabled: true,
      },
      travelPlanner: createDefaultTravelPlannerSettings(),
      profit: {
        sellWhere: "market",
        applyTax: true,
        flightType: "standard",
        capacity: 29,
      },
      filters: {
        roundTripHours: null,
        countries: [],
        categories: [],
        itemNames: [],
      },
    };
  }

  function createDefaultUiState() {
    return {
      schemaVersion: UI_STATE_SCHEMA_VERSION,
      positions: {
        uploadToast: null,
        companionPanel: null,
      },
      minimized: {
        companionPanel: false,
      },
    };
  }

  function normalizeBoolean(value, fallback) {
    return typeof value === "boolean" ? value : fallback;
  }

  function normalizeInteger(value, fallback, { min = null, max = null, allowNull = false } = {}) {
    if ((value === null || value === "") && allowNull) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const rounded = Math.round(numeric);
    if (min !== null && rounded < min) return fallback;
    if (max !== null && rounded > max) return fallback;
    return rounded;
  }

  function normalizeHalfStepNumber(value, fallback, { min = null, max = null, allowNull = false } = {}) {
    if ((value === null || value === "") && allowNull) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    const rounded = Math.round(numeric * 2) / 2;
    if (min !== null && rounded < min) return fallback;
    if (max !== null && rounded > max) return fallback;
    return rounded;
  }

  function normalizeString(value, fallback) {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed || fallback;
  }

  function normalizeEnumString(value, allowedValues, fallback) {
    const normalized = normalizeString(value, fallback).toLowerCase();
    return allowedValues.includes(normalized) ? normalized : fallback;
  }

  function normalizeStringArray(value) {
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => typeof entry === "string" ? entry.trim() : "")
      .filter(Boolean);
  }

  function normalizeStoredPosition(value) {
    if (!value || typeof value !== "object") return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left: Math.round(left), top: Math.round(top) };
  }

  function loadLegacyBadgePosition() {
    try {
      return normalizeStoredPosition(JSON.parse(localStorage.getItem(LEGACY_BADGE_POSITION_STORAGE_KEY) || "null"));
    } catch {
      return null;
    }
  }

  function normalizeSettings(raw) {
    const defaults = createDefaultSettings();
    if (!raw || typeof raw !== "object" || raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
      return defaults;
    }

    const helpers = raw.helpers && typeof raw.helpers === "object" ? raw.helpers : {};
    const travelPlanner = raw.travelPlanner && typeof raw.travelPlanner === "object" ? raw.travelPlanner : {};
    const profit = raw.profit && typeof raw.profit === "object" ? raw.profit : {};
    const filters = raw.filters && typeof raw.filters === "object" ? raw.filters : {};
    const normalizedCountries = normalizeStringArray(filters.countries);
    const normalizedCategoryFilters = normalizeStringArray(filters.categories);
    const normalizedItemNames = normalizeStringArray(filters.itemNames);
    const legacyDisplayMode = normalizeEnumString(
      travelPlanner.displayMode,
      LEGACY_TRAVEL_PLANNER_DISPLAY_OPTIONS.map((option) => option.value),
      ""
    );
    const defaultTravelPlanner = createDefaultTravelPlannerSettings();
    const rawCategoryGroups = travelPlanner.categoryGroups && typeof travelPlanner.categoryGroups === "object"
      ? travelPlanner.categoryGroups
      : {};
    const hasExplicitCategoryGroups = TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS.some(
      (option) => typeof rawCategoryGroups[option.value] === "boolean"
    );
    const migratedCategoryGroups = createDefaultTravelPlannerCategoryGroups();

    if (hasExplicitCategoryGroups) {
      TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS.forEach((option) => {
        migratedCategoryGroups[option.value] = normalizeBoolean(
          rawCategoryGroups[option.value],
          defaultTravelPlanner.categoryGroups[option.value]
        );
      });
    } else if (legacyDisplayMode === "categories") {
      const legacyEnabledGroups = new Set(
        normalizedCategoryFilters
          .map((value) => String(value || "").trim().toLowerCase())
          .filter(Boolean)
      );
      TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS.forEach((option) => {
        migratedCategoryGroups[option.value] = !legacyEnabledGroups.size || legacyEnabledGroups.has(option.value);
      });
    }

    return {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      mode: raw.mode === "enhanced" ? "enhanced" : "legacy",
      disableAllUi: normalizeBoolean(raw.disableAllUi, defaults.disableAllUi),
      uploadToastEnabled: normalizeBoolean(raw.uploadToastEnabled, defaults.uploadToastEnabled),
      showRunCost: normalizeBoolean(raw.showRunCost, defaults.showRunCost),
      helpers: {
        travelPlannerEnabled: normalizeBoolean(helpers.travelPlannerEnabled, defaults.helpers.travelPlannerEnabled),
        countryHelperEnabled: normalizeBoolean(helpers.countryHelperEnabled, defaults.helpers.countryHelperEnabled),
      },
      travelPlanner: {
        generalResultsCount: normalizeEnumString(
          travelPlanner.generalResultsCount,
          SETTINGS_TRAVEL_PLANNER_GENERAL_RESULTS_OPTIONS.map((option) => option.value),
          legacyDisplayMode === "top3" ? "top3" : defaultTravelPlanner.generalResultsCount
        ),
        categoryGroups: migratedCategoryGroups,
      },
      profit: {
        sellWhere: normalizeSellWhereSetting(profit.sellWhere, defaults.profit.sellWhere),
        applyTax: normalizeBoolean(profit.applyTax, defaults.profit.applyTax),
        flightType: normalizeEnumString(
          profit.flightType,
          SETTINGS_FLIGHT_TYPE_OPTIONS.map((option) => option.value),
          defaults.profit.flightType
        ),
        capacity: normalizeInteger(profit.capacity, defaults.profit.capacity, {
          min: SETTINGS_CAPACITY_MIN,
          max: SETTINGS_CAPACITY_MAX,
        }),
      },
      filters: {
        roundTripHours: normalizeHalfStepNumber(filters.roundTripHours, defaults.filters.roundTripHours, {
          min: 0.5,
          allowNull: true,
        }),
        countries: normalizedCountries,
        categories: normalizedCategoryFilters,
        itemNames: normalizedItemNames,
      },
    };
  }

  function normalizeUiState(raw) {
    const defaults = createDefaultUiState();
    const fallbackUploadToastPosition = loadLegacyBadgePosition();

    if (!raw || typeof raw !== "object" || raw.schemaVersion !== UI_STATE_SCHEMA_VERSION) {
      defaults.positions.uploadToast = fallbackUploadToastPosition;
      return defaults;
    }

    const positions = raw.positions && typeof raw.positions === "object" ? raw.positions : {};
    const minimized = raw.minimized && typeof raw.minimized === "object" ? raw.minimized : {};

    return {
      schemaVersion: UI_STATE_SCHEMA_VERSION,
      positions: {
        uploadToast: normalizeStoredPosition(positions.uploadToast) || fallbackUploadToastPosition,
        companionPanel: normalizeStoredPosition(positions.companionPanel),
      },
      minimized: {
        companionPanel: normalizeBoolean(minimized.companionPanel, defaults.minimized.companionPanel),
      },
    };
  }

  function loadStoredJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function getSettings() {
    return normalizeSettings(loadStoredJson(SETTINGS_STORAGE_KEY));
  }

  function getTravelPlannerGeneralResultsCount(settings = getSettings()) {
    const generalResultsCount = String(settings?.travelPlanner?.generalResultsCount || "").trim().toLowerCase();
    if (generalResultsCount === "top3") return "top3";
    return "best";
  }

  function isTravelPlannerCategoryGroupEnabled(settings = getSettings(), groupValue = "") {
    const normalizedGroupValue = String(groupValue || "").trim().toLowerCase();
    if (!normalizedGroupValue) return false;
    return settings?.travelPlanner?.categoryGroups?.[normalizedGroupValue] === true;
  }

  function getTravelPlannerResultsLimit(settings = getSettings()) {
    return getTravelPlannerGeneralResultsCount(settings) === "top3" ? 3 : 1;
  }

  function saveSettings(nextSettings) {
    const normalized = normalizeSettings(nextSettings);
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage failures; the current session can still use defaults.
    }
    return normalized;
  }

  function getUiState() {
    return normalizeUiState(loadStoredJson(UI_STATE_STORAGE_KEY));
  }

  function saveUiState(nextUiState) {
    const normalized = normalizeUiState(nextUiState);
    try {
      localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage failures; the current session can still use defaults.
    }
    return normalized;
  }

  function resetSettings() {
    try {
      localStorage.removeItem(SETTINGS_STORAGE_KEY);
      localStorage.removeItem(UI_STATE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_BADGE_POSITION_STORAGE_KEY);
    } catch {
      // Ignore storage failures; defaults will still be used in-memory.
    }
    return createDefaultSettings();
  }

  function resetUiSettings() {
    const defaults = createDefaultSettings();
    const nextSettings = getSettings();
    nextSettings.disableAllUi = defaults.disableAllUi;
    nextSettings.uploadToastEnabled = defaults.uploadToastEnabled;
    const savedSettings = saveSettings(nextSettings);
    try {
      localStorage.removeItem(UI_STATE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_BADGE_POSITION_STORAGE_KEY);
    } catch {
      // Ignore storage failures; defaults will still be used in-memory.
    }
    return savedSettings;
  }

  function shouldRenderUploadToast() {
    const settings = getSettings();
    return !settings.disableAllUi && settings.uploadToastEnabled;
  }

  function markDroqsdbUiRoot(el, rootName) {
    if (!el || el.nodeType !== 1) return el;
    el.setAttribute("data-droqsdb-ui", "true");
    if (rootName) el.setAttribute("data-droqsdb-ui-root", rootName);
    return el;
  }

  function isDroqsdbUiNode(node) {
    return Boolean(node?.closest?.('[data-droqsdb-ui="true"]'));
  }

  // ---------------- Badge (ONLY during upload / debug) ----------------
  let badgeEl = null;
  let badgeTextEl = null;
  let badgeCloseEl = null;
  let badgeSettingsEl = null;
  let badgePosition = null;
  let badgeDragState = null;
  let hideTimer = null;
  let settingsOverlayEl = null;
  let settingsDialogEl = null;
  let settingsBodyEl = null;
  let settingsLauncherEl = null;
  let companionPanelEl = null;
  let companionPanelHeaderEl = null;
  let companionPanelContentEl = null;
  let companionLauncherEl = null;
  let companionPanelTitleEl = null;
  let companionPanelSubtitleEl = null;
  let companionPanelSettingsEl = null;
  let companionPanelCloseEl = null;
  let companionPanelPosition = null;
  let companionPanelDragState = null;
  let companionStateObserver = null;
  let companionStateTimer = null;
  let companionInteractionTimer = null;
  let companionGuidanceTimer = null;
  const companionDebugSignatures = {
    planner: null,
    helper: null,
    selectedCountryCard: null,
  };
  const travelPlannerSelectionState = {
    country: null,
    clearRequestedAt: 0,
    lastEligibleAt: 0,
  };
  const settingsModalUiState = {
    itemQuery: "",
  };
  const companionOptionsState = {
    status: "idle",
    data: null,
    error: null,
    promise: null,
  };
  const companionResponseCache = new Map();
  const companionPanelState = {
    signature: null,
    requestToken: 0,
    context: {
      eligible: false,
      mode: "hidden",
      selectedCountry: null,
      country: null,
    },
    global: {
      status: "idle",
      payload: null,
      runs: [],
      emptyReason: null,
      emptyStateGuidance: null,
    },
    selected: {
      status: "hidden",
      country: null,
      payload: null,
      runs: [],
      emptyReason: null,
      emptyStateGuidance: null,
    },
    countryHelper: {
      status: "idle",
      country: null,
      payload: null,
      runs: [],
      emptyReason: null,
    },
    categoryGroups: [],
  };
  const BADGE_EDGE_MARGIN = 10;
  const SETTINGS_LAUNCHER_EDGE_MARGIN = 8;
  const COMPANION_PANEL_EDGE_MARGIN = 12;
  const COMPANION_PANEL_DEFAULT_TOP = 72;

  function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function loadBadgePosition() {
    return getUiState().positions.uploadToast;
  }

  function saveBadgePosition(position) {
    if (!position) return;
    const uiState = getUiState();
    uiState.positions.uploadToast = normalizeStoredPosition(position);
    saveUiState(uiState);
  }

  function loadCompanionPanelPosition() {
    return getUiState().positions.companionPanel;
  }

  function saveCompanionPanelPosition(position) {
    if (!position) return;
    const uiState = getUiState();
    uiState.positions.companionPanel = normalizeStoredPosition(position);
    saveUiState(uiState);
  }

  function isCompanionPanelMinimized() {
    return getUiState().minimized.companionPanel;
  }

  function saveCompanionPanelMinimized(minimized) {
    const uiState = getUiState();
    uiState.minimized.companionPanel = Boolean(minimized);
    saveUiState(uiState);
  }

  function getViewportSize() {
    return {
      width: Math.max(window.innerWidth || 0, document.documentElement?.clientWidth || 0),
      height: Math.max(window.innerHeight || 0, document.documentElement?.clientHeight || 0),
    };
  }

  function getBadgeSize(el) {
    const rect = el.getBoundingClientRect();
    return {
      width: Math.max(Math.round(rect.width || el.offsetWidth || 0), 1),
      height: Math.max(Math.round(rect.height || el.offsetHeight || 0), 1),
    };
  }

  function clampBadgePosition(position, el = badgeEl) {
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const { width, height } = getBadgeSize(el);
    const maxLeft = Math.max(BADGE_EDGE_MARGIN, viewportWidth - width - BADGE_EDGE_MARGIN);
    const maxTop = Math.max(BADGE_EDGE_MARGIN, viewportHeight - height - BADGE_EDGE_MARGIN);
    return {
      left: clampNumber(Math.round(position.left), BADGE_EDGE_MARGIN, maxLeft),
      top: clampNumber(Math.round(position.top), BADGE_EDGE_MARGIN, maxTop),
    };
  }

  function getDefaultBadgePosition(el = badgeEl) {
    const { height: viewportHeight } = getViewportSize();
    const { height } = getBadgeSize(el);
    // Default to bottom-left to avoid desktop chat overlays and mobile top chrome.
    return clampBadgePosition({
      left: BADGE_EDGE_MARGIN,
      top: viewportHeight - height - BADGE_EDGE_MARGIN,
    }, el);
  }

  function applyBadgePosition(position, { persist = false } = {}) {
    const el = ensureBadge();
    const nextPosition = clampBadgePosition(position || getDefaultBadgePosition(el), el);
    badgePosition = nextPosition;
    el.style.left = `${nextPosition.left}px`;
    el.style.top = `${nextPosition.top}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    if (persist) saveBadgePosition(nextPosition);
    return nextPosition;
  }

  function syncVisibleBadgePosition() {
    if (!badgeEl || badgeEl.style.display === "none") return;
    applyBadgePosition(badgePosition || loadBadgePosition() || getDefaultBadgePosition(badgeEl));
  }

  function isBadgeControlTarget(target) {
    if (!(target instanceof Node)) return false;
    return Boolean(
      (badgeCloseEl && badgeCloseEl.contains(target)) ||
      (badgeSettingsEl && badgeSettingsEl.contains(target))
    );
  }

  function closeSettingsModal() {
    if (!settingsOverlayEl) return;
    settingsOverlayEl.style.display = "none";
  }

  function getUserscriptMenuCommandRegistrar() {
    if (typeof GM_registerMenuCommand === "function") return GM_registerMenuCommand;
    if (typeof GM === "object" && GM && typeof GM.registerMenuCommand === "function") {
      return (label, handler) => GM.registerMenuCommand(label, handler);
    }
    return null;
  }

  function hasUserscriptMenuCommandSupport() {
    return typeof getUserscriptMenuCommandRegistrar() === "function";
  }

  function isLikelyTornPdaOrMobile() {
    const userAgent = typeof navigator === "object" ? String(navigator.userAgent || "") : "";
    if (/tornpda/i.test(userAgent)) return true;

    const touchPoints = typeof navigator === "object" ? Number(navigator.maxTouchPoints || 0) : 0;
    const coarsePointer = typeof window.matchMedia === "function" && (
      window.matchMedia("(pointer: coarse)").matches ||
      window.matchMedia("(any-pointer: coarse)").matches ||
      window.matchMedia("(hover: none)").matches
    );
    return /iphone|ipad|android|mobile/i.test(userAgent) || ((touchPoints > 0 || coarsePointer) && getViewportSize().width <= 1024);
  }

  function shouldShowSettingsLauncher(settings = getSettings()) {
    return isTravelPage() && (
      settings.disableAllUi === true ||
      !hasUserscriptMenuCommandSupport() ||
      isLikelyTornPdaOrMobile()
    );
  }

  function ensureSettingsLauncher() {
    if (settingsLauncherEl) return settingsLauncherEl;

    settingsLauncherEl = document.createElement("button");
    markDroqsdbUiRoot(settingsLauncherEl, "settings-launcher");
    settingsLauncherEl.type = "button";
    settingsLauncherEl.textContent = "DB";
    settingsLauncherEl.setAttribute("aria-label", "Open DroqsDB settings");
    settingsLauncherEl.title = "Open DroqsDB settings";
    settingsLauncherEl.style.position = "fixed";
    settingsLauncherEl.style.left = `calc(${SETTINGS_LAUNCHER_EDGE_MARGIN}px + env(safe-area-inset-left, 0px))`;
    settingsLauncherEl.style.bottom = `calc(${SETTINGS_LAUNCHER_EDGE_MARGIN}px + env(safe-area-inset-bottom, 0px))`;
    settingsLauncherEl.style.zIndex = "999998";
    settingsLauncherEl.style.display = "none";
    settingsLauncherEl.style.alignItems = "center";
    settingsLauncherEl.style.justifyContent = "center";
    settingsLauncherEl.style.minWidth = "30px";
    settingsLauncherEl.style.height = "20px";
    settingsLauncherEl.style.padding = "0 7px";
    settingsLauncherEl.style.border = "1px solid rgba(255,255,255,0.18)";
    settingsLauncherEl.style.borderRadius = "999px";
    settingsLauncherEl.style.background = "rgba(0,0,0,0.45)";
    settingsLauncherEl.style.color = "rgba(255,255,255,0.78)";
    settingsLauncherEl.style.fontFamily = "Arial, sans-serif";
    settingsLauncherEl.style.fontSize = "9px";
    settingsLauncherEl.style.fontWeight = "700";
    settingsLauncherEl.style.letterSpacing = "0.04em";
    settingsLauncherEl.style.cursor = "pointer";
    settingsLauncherEl.style.opacity = "0.68";
    settingsLauncherEl.style.boxShadow = "0 4px 10px rgba(0,0,0,0.18)";
    settingsLauncherEl.style.touchAction = "manipulation";
    settingsLauncherEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettingsModal();
    });

    (document.body || document.documentElement).appendChild(settingsLauncherEl);
    return settingsLauncherEl;
  }

  function syncSettingsLauncherVisibility(settings = getSettings()) {
    const shouldShow = shouldShowSettingsLauncher(settings);
    if (!shouldShow && !settingsLauncherEl) return;
    const el = ensureSettingsLauncher();
    el.style.display = shouldShow ? "inline-flex" : "none";
  }

  function syncUiVisibilityWithSettings(settings = getSettings()) {
    if (settings.disableAllUi || !settings.uploadToastEnabled) dismissBadge();
    syncSettingsLauncherVisibility(settings);
    if (
      settings.disableAllUi === true ||
      settings.mode !== "enhanced" ||
      (
        settings.helpers?.travelPlannerEnabled !== true &&
        settings.helpers?.countryHelperEnabled !== true
      )
    ) {
      hideCompanionPanelUi();
    }
    scheduleCompanionStateCheck(0);
  }

  function commitSettingsChange(mutator) {
    const nextSettings = getSettings();
    mutator(nextSettings);
    const savedSettings = saveSettings(nextSettings);
    badgePosition = loadBadgePosition();
    syncUiVisibilityWithSettings(savedSettings);
    syncVisibleBadgePosition();
    renderSettingsModal();
    renderCompanionPanel();
    return savedSettings;
  }

  function createSettingsSection(title) {
    const section = document.createElement("section");
    section.style.padding = "12px 0";
    section.style.borderTop = "1px solid rgba(255,255,255,0.12)";

    const heading = document.createElement("div");
    heading.textContent = title;
    heading.style.fontSize = "12px";
    heading.style.fontWeight = "700";
    heading.style.textTransform = "uppercase";
    heading.style.letterSpacing = "0.04em";
    heading.style.color = "rgba(255,255,255,0.72)";
    heading.style.marginBottom = "8px";

    section.appendChild(heading);
    return section;
  }

  function createSettingsControl({ type, name = "", label, checked, disabled = false, onChange }) {
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "10px";
    row.style.padding = "6px 0";
    row.style.cursor = disabled ? "default" : "pointer";
    row.style.opacity = disabled ? "0.6" : "1";

    const input = document.createElement("input");
    input.type = type;
    if (name) input.name = name;
    input.checked = checked;
    input.disabled = disabled;
    input.style.margin = "0";
    input.addEventListener("change", onChange);

    const text = document.createElement("span");
    text.textContent = label;
    text.style.flex = "1";
    text.style.lineHeight = "1.35";

    row.appendChild(input);
    row.appendChild(text);
    return row;
  }

  function createSettingsHint(text) {
    const hint = document.createElement("div");
    hint.textContent = text;
    hint.style.fontSize = "12px";
    hint.style.lineHeight = "1.4";
    hint.style.color = "rgba(255,255,255,0.72)";
    hint.style.marginTop = "4px";
    return hint;
  }

  function createSettingsFieldLabel(text) {
    const label = document.createElement("div");
    label.textContent = text;
    label.style.fontSize = "12px";
    label.style.fontWeight = "700";
    label.style.lineHeight = "1.4";
    label.style.color = "rgba(255,255,255,0.88)";
    label.style.marginBottom = "6px";
    return label;
  }

  function createSettingsSelectControl({ label, value, options, disabled = false, onChange }) {
    const row = document.createElement("label");
    row.style.display = "block";
    row.style.padding = "6px 0";
    row.style.opacity = disabled ? "0.6" : "1";

    row.appendChild(createSettingsFieldLabel(label));

    const select = document.createElement("select");
    select.disabled = disabled;
    select.style.width = "100%";
    select.style.boxSizing = "border-box";
    select.style.minHeight = "36px";
    select.style.padding = "8px 10px";
    select.style.border = "1px solid rgba(255,255,255,0.18)";
    select.style.borderRadius = "8px";
    select.style.background = "rgba(24,33,48,0.96)";
    select.style.color = "#f5f7fb";
    select.style.font = "inherit";
    select.style.colorScheme = "dark";

    for (const option of options) {
      const optionEl = document.createElement("option");
      optionEl.value = option.value;
      optionEl.textContent = option.label;
      optionEl.style.backgroundColor = "#182130";
      optionEl.style.color = "#f5f7fb";
      optionEl.style.font = "inherit";
      select.appendChild(optionEl);
    }

    select.value = value;
    select.addEventListener("change", onChange);
    row.appendChild(select);
    return row;
  }

  function createSettingsNumberControl({
    label,
    value,
    placeholder = "",
    min = null,
    max = null,
    step = "1",
    disabled = false,
    onChange,
  }) {
    const row = document.createElement("label");
    row.style.display = "block";
    row.style.padding = "6px 0";

    row.appendChild(createSettingsFieldLabel(label));

    const input = document.createElement("input");
    input.type = "number";
    input.disabled = disabled;
    input.value = value === null || value === undefined ? "" : String(value);
    input.placeholder = placeholder;
    input.inputMode = step === "1" ? "numeric" : "decimal";
    if (min !== null) input.min = String(min);
    if (max !== null) input.max = String(max);
    input.step = String(step);
    input.style.width = "100%";
    input.style.boxSizing = "border-box";
    input.style.minHeight = "36px";
    input.style.padding = "8px 10px";
    input.style.border = "1px solid rgba(255,255,255,0.18)";
    input.style.borderRadius = "8px";
    input.style.background = "rgba(255,255,255,0.08)";
    input.style.color = "#fff";
    input.style.font = "inherit";
    input.addEventListener("change", onChange);
    row.appendChild(input);
    return row;
  }

  function createSettingsCheckboxChip({ label, meta = "", checked, disabled = false, onChange }) {
    const chip = document.createElement("label");
    chip.style.display = "flex";
    chip.style.alignItems = "flex-start";
    chip.style.gap = "8px";
    chip.style.padding = "8px 10px";
    chip.style.border = "1px solid rgba(255,255,255,0.12)";
    chip.style.borderRadius = "8px";
    chip.style.background = checked ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.05)";
    chip.style.cursor = disabled ? "default" : "pointer";
    chip.style.opacity = disabled ? "0.6" : "1";
    chip.style.boxSizing = "border-box";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.disabled = disabled;
    input.style.margin = "2px 0 0";
    input.addEventListener("change", onChange);

    const body = document.createElement("span");
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "2px";
    body.style.flex = "1";

    const labelEl = document.createElement("span");
    labelEl.textContent = label;
    labelEl.style.lineHeight = "1.35";
    body.appendChild(labelEl);

    if (meta) {
      const metaEl = document.createElement("span");
      metaEl.textContent = meta;
      metaEl.style.fontSize = "11px";
      metaEl.style.lineHeight = "1.3";
      metaEl.style.color = "rgba(255,255,255,0.62)";
      body.appendChild(metaEl);
    }

    chip.appendChild(input);
    chip.appendChild(body);
    return chip;
  }

  function getSettingsOptionLabel(options, value, fallback = "") {
    const match = (Array.isArray(options) ? options : []).find((option) => option.value === value);
    return match?.label || fallback || String(value || "");
  }

  function toggleStringSelection(values, value, checked) {
    const next = [];
    const lookupKey = toNameKey(value);
    for (const entry of normalizeStringArray(values)) {
      if (toNameKey(entry) === lookupKey) continue;
      next.push(entry);
    }
    if (checked && value) next.push(value);
    return next;
  }

  function buildFallbackCompanionOptions() {
    const defaults = createDefaultSettings();
    return {
      defaults: {
        settings: { ...defaults.profit },
        travelPlanner: {
          roundTripHoursByFlightType: {},
        },
      },
      enums: {
        sellWhere: SETTINGS_SELL_WHERE_OPTIONS.map((option) => option.value),
        flightType: SETTINGS_FLIGHT_TYPE_OPTIONS.map((option) => option.value),
        categories: SETTINGS_CATEGORY_OPTIONS.map((option) => ({ ...option })),
      },
      filters: {
        countries: [...KNOWN_COUNTRY_NAMES],
        items: [],
      },
    };
  }

  function normalizeCompanionOptionsPayload(rawPayload) {
    const fallback = buildFallbackCompanionOptions();
    const payload = rawPayload && typeof rawPayload === "object" ? rawPayload : {};
    const sellWhereAllowed = new Set(fallback.enums.sellWhere);
    const flightTypeAllowed = new Set(fallback.enums.flightType);
    const categoryLabelFallbacks = new Map(
      SETTINGS_CATEGORY_OPTIONS.map((option) => [option.value, option.label])
    );

    const sellWhere = normalizeStringArray(payload.enums?.sellWhere)
      .map((value) => value.toLowerCase())
      .filter((value) => sellWhereAllowed.has(value));
    const flightType = normalizeStringArray(payload.enums?.flightType)
      .map((value) => value.toLowerCase())
      .filter((value) => flightTypeAllowed.has(value));
    const categories = Array.isArray(payload.enums?.categories)
      ? payload.enums.categories
        .map((entry) => {
          const value = String(entry?.value || "").trim().toLowerCase();
          if (!categoryLabelFallbacks.has(value)) return null;
          return {
            value,
            label: normalizeString(entry?.label, categoryLabelFallbacks.get(value)),
          };
        })
        .filter(Boolean)
      : [];

    const countries = [];
    const seenCountries = new Set();
    for (const country of normalizeStringArray(payload.filters?.countries)) {
      if (seenCountries.has(country)) continue;
      seenCountries.add(country);
      countries.push(country);
    }

    const items = [];
    const seenItems = new Set();
    for (const item of Array.isArray(payload.filters?.items) ? payload.filters.items : []) {
      const itemName = String(item?.itemName || "").trim();
      const lookupKey = toNameKey(itemName);
      if (!lookupKey || seenItems.has(lookupKey)) continue;
      seenItems.add(lookupKey);
      items.push({
        itemId: Number.isFinite(Number(item?.itemId)) ? Math.round(Number(item.itemId)) : null,
        itemName,
        category: String(item?.category || "").trim().toLowerCase() || null,
      });
    }

    items.sort((a, b) => String(a.itemName || "").localeCompare(String(b.itemName || "")));

    const roundTripHoursByFlightType = {};
    for (const option of SETTINGS_FLIGHT_TYPE_OPTIONS) {
      const value = normalizeHalfStepNumber(
        payload.defaults?.travelPlanner?.roundTripHoursByFlightType?.[option.value],
        null,
        { min: 0.5, allowNull: true }
      );
      if (value !== null) roundTripHoursByFlightType[option.value] = value;
    }

    return {
      defaults: {
        settings: {
          sellWhere: sellWhereAllowed.has(payload.defaults?.settings?.sellWhere)
            ? payload.defaults.settings.sellWhere
            : fallback.defaults.settings.sellWhere,
          applyTax: typeof payload.defaults?.settings?.applyTax === "boolean"
            ? payload.defaults.settings.applyTax
            : fallback.defaults.settings.applyTax,
          flightType: flightTypeAllowed.has(payload.defaults?.settings?.flightType)
            ? payload.defaults.settings.flightType
            : fallback.defaults.settings.flightType,
          capacity: normalizeInteger(payload.defaults?.settings?.capacity, fallback.defaults.settings.capacity, {
            min: SETTINGS_CAPACITY_MIN,
            max: SETTINGS_CAPACITY_MAX,
          }),
        },
        travelPlanner: {
          roundTripHoursByFlightType,
        },
      },
      enums: {
        sellWhere: sellWhere.length ? sellWhere : fallback.enums.sellWhere,
        flightType: flightType.length ? flightType : fallback.enums.flightType,
        categories: categories.length ? categories : fallback.enums.categories,
      },
      filters: {
        countries: countries.length ? countries : fallback.filters.countries,
        items,
      },
    };
  }

  function getSettingsModalOptions(settings = getSettings()) {
    const normalized = companionOptionsState.data || buildFallbackCompanionOptions();
    const sellWhereOptions = normalized.enums.sellWhere.map((value) => ({
      value,
      label: getSettingsOptionLabel(SETTINGS_SELL_WHERE_OPTIONS, value, value),
    }));
    const flightTypeOptions = normalized.enums.flightType.map((value) => ({
      value,
      label: getSettingsOptionLabel(SETTINGS_FLIGHT_TYPE_OPTIONS, value, value),
    }));
    const categoryOptions = normalized.enums.categories.map((option) => ({
      value: option.value,
      label: option.label,
    }));

    const countryOptions = [];
    const seenCountries = new Set();
    for (const country of normalized.filters.countries.concat(settings.filters.countries || [])) {
      const normalizedCountry = String(country || "").trim();
      if (!normalizedCountry || seenCountries.has(normalizedCountry)) continue;
      seenCountries.add(normalizedCountry);
      countryOptions.push(normalizedCountry);
    }

    const itemOptions = [];
    const seenItems = new Set();
    for (const item of normalized.filters.items) {
      const itemName = String(item?.itemName || "").trim();
      const lookupKey = toNameKey(itemName);
      if (!lookupKey || seenItems.has(lookupKey)) continue;
      seenItems.add(lookupKey);
      itemOptions.push({
        itemId: item.itemId ?? null,
        itemName,
        category: item.category || null,
      });
    }
    for (const itemName of settings.filters.itemNames || []) {
      const normalizedName = String(itemName || "").trim();
      const lookupKey = toNameKey(normalizedName);
      if (!lookupKey || seenItems.has(lookupKey)) continue;
      seenItems.add(lookupKey);
      itemOptions.push({
        itemId: null,
        itemName: normalizedName,
        category: null,
      });
    }
    itemOptions.sort((a, b) => String(a.itemName || "").localeCompare(String(b.itemName || "")));

    return {
      source: companionOptionsState.data ? "backend" : "local",
      status: companionOptionsState.status,
      error: companionOptionsState.error,
      sellWhereOptions,
      flightTypeOptions,
      categoryOptions,
      countries: countryOptions,
      items: itemOptions,
      roundTripHoursByFlightType: normalized.defaults?.travelPlanner?.roundTripHoursByFlightType || {},
    };
  }

  async function ensureCompanionOptionsLoaded() {
    if (companionOptionsState.status === "loaded" && companionOptionsState.data) {
      return companionOptionsState.data;
    }
    if (companionOptionsState.promise) return companionOptionsState.promise;

    companionOptionsState.status = "loading";
    companionOptionsState.error = null;
    companionOptionsState.promise = (async () => {
      try {
        const payload = await getCompanionJson(COMPANION_OPTIONS_API_URL);
        if (!payload || payload.ok !== true) throw new Error("Invalid companion options payload");
        const normalized = normalizeCompanionOptionsPayload(payload);
        companionOptionsState.data = normalized;
        companionOptionsState.status = "loaded";
        companionOptionsState.error = null;
        return normalized;
      } catch (error) {
        companionOptionsState.status = "error";
        companionOptionsState.error = error instanceof Error ? error : new Error("Failed to load companion options");
        return null;
      } finally {
        companionOptionsState.promise = null;
        if (settingsOverlayEl?.style.display !== "none") {
          renderSettingsModal();
        }
      }
    })();

    return companionOptionsState.promise;
  }

  function ensureSettingsModal() {
    if (settingsOverlayEl) return settingsOverlayEl;

    settingsOverlayEl = document.createElement("div");
    markDroqsdbUiRoot(settingsOverlayEl, "settings-overlay");
    settingsOverlayEl.style.position = "fixed";
    settingsOverlayEl.style.inset = "0";
    settingsOverlayEl.style.zIndex = "1000000";
    settingsOverlayEl.style.display = "none";
    settingsOverlayEl.style.alignItems = "center";
    settingsOverlayEl.style.justifyContent = "center";
    settingsOverlayEl.style.padding = "12px";
    settingsOverlayEl.style.boxSizing = "border-box";
    settingsOverlayEl.style.background = "rgba(0,0,0,0.45)";

    settingsDialogEl = document.createElement("div");
    settingsDialogEl.setAttribute("role", "dialog");
    settingsDialogEl.setAttribute("aria-modal", "true");
    settingsDialogEl.setAttribute("aria-label", "DroqsDB settings");
    settingsDialogEl.style.width = "100%";
    settingsDialogEl.style.maxWidth = "420px";
    settingsDialogEl.style.maxHeight = "calc(100vh - 24px)";
    settingsDialogEl.style.overflowY = "auto";
    settingsDialogEl.style.boxSizing = "border-box";
    settingsDialogEl.style.borderRadius = "12px";
    settingsDialogEl.style.background = "rgba(18,18,18,0.96)";
    settingsDialogEl.style.color = "#fff";
    settingsDialogEl.style.boxShadow = "0 18px 40px rgba(0,0,0,0.35)";
    settingsDialogEl.style.fontFamily = "Arial, sans-serif";
    settingsDialogEl.style.fontSize = "14px";

    const header = document.createElement("div");
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.justifyContent = "space-between";
    header.style.gap = "12px";
    header.style.padding = "14px 16px";
    header.style.borderBottom = "1px solid rgba(255,255,255,0.12)";

    const title = document.createElement("div");
    title.textContent = "DroqsDB Settings";
    title.style.fontSize = "16px";
    title.style.fontWeight = "700";

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "×";
    closeButton.setAttribute("aria-label", "Close settings");
    closeButton.style.border = "0";
    closeButton.style.background = "transparent";
    closeButton.style.color = "#fff";
    closeButton.style.fontSize = "20px";
    closeButton.style.lineHeight = "1";
    closeButton.style.cursor = "pointer";
    closeButton.addEventListener("click", () => {
      closeSettingsModal();
    });

    settingsBodyEl = document.createElement("div");
    settingsBodyEl.style.padding = "0 16px 16px";

    header.appendChild(title);
    header.appendChild(closeButton);
    settingsDialogEl.appendChild(header);
    settingsDialogEl.appendChild(settingsBodyEl);
    settingsOverlayEl.appendChild(settingsDialogEl);

    settingsOverlayEl.addEventListener("click", (event) => {
      if (event.target === settingsOverlayEl) closeSettingsModal();
    });
    settingsDialogEl.addEventListener("click", (event) => {
      event.stopPropagation();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && settingsOverlayEl?.style.display !== "none") {
        closeSettingsModal();
      }
    });

    (document.body || document.documentElement).appendChild(settingsOverlayEl);
    return settingsOverlayEl;
  }

  function renderSettingsModal() {
    if (!settingsBodyEl) return;

    const settings = getSettings();
    const helpersDisabled = settings.mode !== "enhanced";
    const modalOptions = getSettingsModalOptions(settings);
    const categoriesActive = (settings.filters.categories || []).length > 0;
    const selectedCountries = new Set(settings.filters.countries || []);
    const selectedCategories = new Set(settings.filters.categories || []);
    const selectedItemKeys = new Set(
      (settings.filters.itemNames || []).map((itemName) => toNameKey(itemName)).filter(Boolean)
    );
    const activeFlightTypeLabel = getSettingsOptionLabel(
      modalOptions.flightTypeOptions,
      settings.profit.flightType,
      "current flight type"
    );
    const defaultRoundTripHours = normalizeHalfStepNumber(
      modalOptions.roundTripHoursByFlightType?.[settings.profit.flightType],
      null,
      { min: 0.5, allowNull: true }
    );
    settingsBodyEl.textContent = "";

    const modeSection = createSettingsSection("Mode");
    modeSection.style.borderTop = "0";
    modeSection.appendChild(createSettingsControl({
      type: "radio",
      name: "droqsdb-mode",
      label: "Legacy Mode",
      checked: settings.mode === "legacy",
      onChange: (event) => {
        if (!event.target.checked) return;
        commitSettingsChange((next) => {
          next.mode = "legacy";
        });
      },
    }));
    modeSection.appendChild(createSettingsControl({
      type: "radio",
      name: "droqsdb-mode",
      label: "Enhanced Mode",
      checked: settings.mode === "enhanced",
      onChange: (event) => {
        if (!event.target.checked) return;
        commitSettingsChange((next) => {
          next.mode = "enhanced";
        });
      },
    }));

    modeSection.appendChild(createSettingsHint("Enhanced mode currently keeps the same upload behavior as legacy mode."));

    const uiSection = createSettingsSection("UI Controls");
    uiSection.appendChild(createSettingsControl({
      type: "checkbox",
      label: "Hide DroqsDB overlays",
      checked: settings.disableAllUi,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.disableAllUi = Boolean(event.target.checked);
        });
      },
    }));
    uiSection.appendChild(createSettingsControl({
      type: "checkbox",
      label: "Upload confirmation badge",
      checked: settings.uploadToastEnabled,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.uploadToastEnabled = Boolean(event.target.checked);
        });
      },
    }));
    uiSection.appendChild(createSettingsControl({
      type: "checkbox",
      label: "Show Run Cost",
      checked: settings.showRunCost,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.showRunCost = Boolean(event.target.checked);
        });
      },
    }));
    uiSection.appendChild(createSettingsHint(
      "Hides the upload toast and regular DroqsDB overlays. A tiny settings launcher stays available on travel pages."
    ));
    uiSection.appendChild(createSettingsHint(
      "Run Cost is buy price multiplied by your saved capacity. It is informational only."
    ));

    const futureSection = createSettingsSection("Future Features");
    futureSection.appendChild(createSettingsControl({
      type: "checkbox",
      label: "Travel Planner",
      checked: settings.helpers.travelPlannerEnabled,
      disabled: helpersDisabled,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.helpers.travelPlannerEnabled = Boolean(event.target.checked);
        });
      },
    }));
    futureSection.appendChild(createSettingsControl({
      type: "checkbox",
      label: "Country Helper",
      checked: settings.helpers.countryHelperEnabled,
      disabled: helpersDisabled,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.helpers.countryHelperEnabled = Boolean(event.target.checked);
        });
      },
    }));
    futureSection.appendChild(createSettingsSelectControl({
      label: "General Result Count",
      value: getTravelPlannerGeneralResultsCount(settings),
      options: SETTINGS_TRAVEL_PLANNER_GENERAL_RESULTS_OPTIONS,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.travelPlanner.generalResultsCount = normalizeEnumString(
            event.target.value,
            SETTINGS_TRAVEL_PLANNER_GENERAL_RESULTS_OPTIONS.map((option) => option.value),
            next.travelPlanner.generalResultsCount
          );
        });
      },
    }));
    const travelPlannerGroupsBlock = document.createElement("div");
    travelPlannerGroupsBlock.style.padding = "6px 0";
    travelPlannerGroupsBlock.appendChild(createSettingsFieldLabel("Additional Groups"));
    TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS.forEach((option) => {
      travelPlannerGroupsBlock.appendChild(createSettingsControl({
        type: "checkbox",
        label: `Show ${option.label}`,
        checked: isTravelPlannerCategoryGroupEnabled(settings, option.value),
        onChange: (event) => {
          commitSettingsChange((next) => {
            next.travelPlanner.categoryGroups[option.value] = Boolean(event.target.checked);
          });
        },
      }));
    });
    futureSection.appendChild(travelPlannerGroupsBlock);
    futureSection.appendChild(createSettingsHint(
      helpersDisabled
        ? "Travel Planner surfaces only appear in Enhanced Mode. These helper settings still stay saved."
        : "Travel Planner uses the profitability and filter settings below."
    ));
    futureSection.appendChild(createSettingsHint(
      "General results show either the single best backend-ranked run or the top 3 overall. Selected groups add matching Plushies, Flowers, and Drugs sections."
    ));

    const profitSection = createSettingsSection("Profitability");
    profitSection.appendChild(createSettingsSelectControl({
      label: "Sell Where",
      value: settings.profit.sellWhere,
      options: modalOptions.sellWhereOptions,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.profit.sellWhere = normalizeSellWhereSetting(event.target.value, next.profit.sellWhere);
        });
      },
    }));
    profitSection.appendChild(createSettingsControl({
      type: "checkbox",
      label: "Apply Tax",
      checked: settings.profit.applyTax,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.profit.applyTax = Boolean(event.target.checked);
        });
      },
    }));
    profitSection.appendChild(createSettingsSelectControl({
      label: "Flight Type",
      value: settings.profit.flightType,
      options: modalOptions.flightTypeOptions,
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.profit.flightType = normalizeString(event.target.value, next.profit.flightType).toLowerCase();
        });
      },
    }));
    profitSection.appendChild(createSettingsNumberControl({
      label: "Capacity",
      value: settings.profit.capacity,
      min: SETTINGS_CAPACITY_MIN,
      max: SETTINGS_CAPACITY_MAX,
      step: "1",
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.profit.capacity = normalizeInteger(event.target.value, next.profit.capacity, {
            min: SETTINGS_CAPACITY_MIN,
            max: SETTINGS_CAPACITY_MAX,
          });
        });
      },
    }));
    profitSection.appendChild(createSettingsHint(
      `Capacity is validated conservatively between ${SETTINGS_CAPACITY_MIN} and ${SETTINGS_CAPACITY_MAX}.`
    ));

    const filtersSection = createSettingsSection("Planner Filters");
    filtersSection.appendChild(createSettingsNumberControl({
      label: "Round-Trip Hours",
      value: settings.filters.roundTripHours,
      placeholder: defaultRoundTripHours === null ? "" : String(defaultRoundTripHours),
      min: 0.5,
      step: "0.5",
      onChange: (event) => {
        commitSettingsChange((next) => {
          next.filters.roundTripHours = normalizeHalfStepNumber(event.target.value, next.filters.roundTripHours, {
            min: 0.5,
            allowNull: true,
          });
        });
      },
    }));
    filtersSection.appendChild(createSettingsHint(
      defaultRoundTripHours === null
        ? "Leave blank to use the current flight type default."
        : `Leave blank to use the ${activeFlightTypeLabel} default of ${defaultRoundTripHours} hours.`
    ));
    filtersSection.appendChild(createSettingsHint("Empty country, category, and item selections mean no filter."));

    if (modalOptions.status === "loading") {
      filtersSection.appendChild(createSettingsHint("Loading current countries and items from DroqsDB..."));
    } else if (modalOptions.status === "error") {
      filtersSection.appendChild(createSettingsHint("Using local fallback options right now. Item choices may be limited until the backend options load."));
    }

    const countriesGroup = document.createElement("div");
    countriesGroup.style.padding = "6px 0";
    countriesGroup.appendChild(createSettingsFieldLabel("Countries"));
    countriesGroup.appendChild(createSettingsHint("None selected = all countries."));
    const countriesGrid = document.createElement("div");
    countriesGrid.style.display = "grid";
    countriesGrid.style.gridTemplateColumns = "repeat(auto-fit, minmax(132px, 1fr))";
    countriesGrid.style.gap = "8px";
    countriesGrid.style.marginTop = "8px";
    for (const country of modalOptions.countries) {
      countriesGrid.appendChild(createSettingsCheckboxChip({
        label: country,
        checked: selectedCountries.has(country),
        onChange: (event) => {
          commitSettingsChange((next) => {
            next.filters.countries = toggleStringSelection(next.filters.countries, country, Boolean(event.target.checked));
          });
        },
      }));
    }
    if (!modalOptions.countries.length) {
      countriesGroup.appendChild(createSettingsHint("Country options are not available right now."));
    } else {
      countriesGroup.appendChild(countriesGrid);
    }
    filtersSection.appendChild(countriesGroup);

    const categoriesGroup = document.createElement("div");
    categoriesGroup.style.padding = "6px 0";
    categoriesGroup.appendChild(createSettingsFieldLabel("Categories"));
    const categoriesGrid = document.createElement("div");
    categoriesGrid.style.display = "grid";
    categoriesGrid.style.gridTemplateColumns = "repeat(auto-fit, minmax(132px, 1fr))";
    categoriesGrid.style.gap = "8px";
    categoriesGrid.style.marginTop = "8px";
    for (const category of modalOptions.categoryOptions) {
      categoriesGrid.appendChild(createSettingsCheckboxChip({
        label: category.label,
        checked: selectedCategories.has(category.value),
        onChange: (event) => {
          settingsModalUiState.itemQuery = "";
          commitSettingsChange((next) => {
            next.filters.categories = toggleStringSelection(
              next.filters.categories,
              category.value,
              Boolean(event.target.checked)
            );
          });
        },
      }));
    }
    categoriesGroup.appendChild(categoriesGrid);
    filtersSection.appendChild(categoriesGroup);

    const itemsGroup = document.createElement("div");
    itemsGroup.style.padding = "6px 0";

    const itemLabelRow = document.createElement("div");
    itemLabelRow.style.display = "flex";
    itemLabelRow.style.alignItems = "center";
    itemLabelRow.style.justifyContent = "space-between";
    itemLabelRow.style.gap = "12px";
    itemLabelRow.style.flexWrap = "wrap";
    itemLabelRow.appendChild(createSettingsFieldLabel("Item Names"));
    const itemNote = document.createElement("div");
    itemNote.textContent = categoriesActive ? "Category filters override item picks." : "None selected = all items.";
    itemNote.style.fontSize = "11px";
    itemNote.style.lineHeight = "1.35";
    itemNote.style.color = "rgba(255,255,255,0.62)";
    itemLabelRow.appendChild(itemNote);
    itemsGroup.appendChild(itemLabelRow);

    const itemSearchInput = document.createElement("input");
    itemSearchInput.type = "search";
    itemSearchInput.value = settingsModalUiState.itemQuery;
    itemSearchInput.placeholder = "Search items...";
    itemSearchInput.disabled = categoriesActive || !modalOptions.items.length;
    itemSearchInput.style.width = "100%";
    itemSearchInput.style.boxSizing = "border-box";
    itemSearchInput.style.minHeight = "36px";
    itemSearchInput.style.marginTop = "2px";
    itemSearchInput.style.padding = "8px 10px";
    itemSearchInput.style.border = "1px solid rgba(255,255,255,0.18)";
    itemSearchInput.style.borderRadius = "8px";
    itemSearchInput.style.background = "rgba(255,255,255,0.08)";
    itemSearchInput.style.color = "#fff";
    itemSearchInput.style.font = "inherit";
    itemsGroup.appendChild(itemSearchInput);

    const itemList = document.createElement("div");
    itemList.style.marginTop = "8px";
    itemList.style.display = "grid";
    itemList.style.gridTemplateColumns = "1fr";
    itemList.style.gap = "8px";
    itemList.style.maxHeight = "168px";
    itemList.style.overflowY = "auto";
    itemList.style.paddingRight = "2px";

    const itemRows = [];
    for (const item of modalOptions.items) {
      const categoryMeta = item.category
        ? getSettingsOptionLabel(modalOptions.categoryOptions, item.category, item.category)
        : "";
      const row = createSettingsCheckboxChip({
        label: item.itemName,
        meta: categoryMeta,
        checked: selectedItemKeys.has(toNameKey(item.itemName)),
        disabled: categoriesActive,
        onChange: (event) => {
          commitSettingsChange((next) => {
            next.filters.itemNames = toggleStringSelection(
              next.filters.itemNames,
              item.itemName,
              Boolean(event.target.checked)
            );
          });
        },
      });
      row.dataset.itemNameKey = toNameKey(item.itemName);
      itemRows.push(row);
      itemList.appendChild(row);
    }

    const itemEmptyState = document.createElement("div");
    itemEmptyState.textContent = modalOptions.items.length
      ? "No items match your search."
      : "Item options are not available right now.";
    itemEmptyState.style.display = "none";
    itemEmptyState.style.padding = "10px 0 2px";
    itemEmptyState.style.fontSize = "12px";
    itemEmptyState.style.lineHeight = "1.4";
    itemEmptyState.style.color = "rgba(255,255,255,0.62)";

    const applyItemFilter = () => {
      const query = toNameKey(settingsModalUiState.itemQuery);
      let visibleCount = 0;
      for (const row of itemRows) {
        const matches = !query || String(row.dataset.itemNameKey || "").includes(query);
        row.style.display = matches ? "flex" : "none";
        if (matches) visibleCount += 1;
      }
      itemEmptyState.style.display = visibleCount === 0 ? "block" : "none";
    };

    itemSearchInput.addEventListener("input", () => {
      settingsModalUiState.itemQuery = itemSearchInput.value;
      applyItemFilter();
    });

    itemsGroup.appendChild(itemList);
    itemsGroup.appendChild(itemEmptyState);
    filtersSection.appendChild(itemsGroup);
    applyItemFilter();

    const actionsSection = createSettingsSection("Actions");
    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.textContent = "Reset all settings";
    resetButton.style.border = "1px solid rgba(255,255,255,0.18)";
    resetButton.style.borderRadius = "8px";
    resetButton.style.padding = "8px 12px";
    resetButton.style.background = "rgba(255,255,255,0.08)";
    resetButton.style.color = "#fff";
    resetButton.style.cursor = "pointer";
    resetButton.addEventListener("click", () => {
      settingsModalUiState.itemQuery = "";
      resetSettings();
      badgePosition = loadBadgePosition();
      syncUiVisibilityWithSettings(getSettings());
      syncVisibleBadgePosition();
      renderSettingsModal();
    });
    actionsSection.appendChild(resetButton);

    settingsBodyEl.appendChild(modeSection);
    settingsBodyEl.appendChild(uiSection);
    settingsBodyEl.appendChild(futureSection);
    settingsBodyEl.appendChild(profitSection);
    settingsBodyEl.appendChild(filtersSection);
    settingsBodyEl.appendChild(actionsSection);
  }

  function openSettingsModal() {
    if (!isTravelPage()) return;
    ensureSettingsModal();
    settingsModalUiState.itemQuery = "";
    ensureCompanionOptionsLoaded();
    renderSettingsModal();
    settingsOverlayEl.style.display = "flex";
  }

  function registerUserscriptMenuCommands() {
    const registerMenuCommand = getUserscriptMenuCommandRegistrar();
    if (!registerMenuCommand) return;

    registerMenuCommand("Open DroqsDB Settings", () => {
      openSettingsModal();
    });
    registerMenuCommand("Reset DroqsDB UI Settings", () => {
      const savedSettings = resetUiSettings();
      badgePosition = loadBadgePosition();
      syncUiVisibilityWithSettings(savedSettings);
      syncVisibleBadgePosition();
      openSettingsModal();
    });
  }

  function getTouchPoint(event) {
    const touch = event.touches?.[0] || event.changedTouches?.[0];
    if (!touch) return null;
    return { clientX: touch.clientX, clientY: touch.clientY };
  }

  function startBadgeDrag(clientX, clientY) {
    const el = ensureBadge();
    const rect = el.getBoundingClientRect();
    const body = document.body;
    badgeDragState = {
      startX: clientX,
      startY: clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
      previousBodyUserSelect: body ? body.style.userSelect : "",
      previousDocumentUserSelect: document.documentElement.style.userSelect,
    };
    if (body) body.style.userSelect = "none";
    document.documentElement.style.userSelect = "none";
    el.style.cursor = "grabbing";
  }

  function moveBadgeDrag(clientX, clientY) {
    if (!badgeDragState) return;
    badgeDragState.moved = true;
    applyBadgePosition({
      left: badgeDragState.originLeft + (clientX - badgeDragState.startX),
      top: badgeDragState.originTop + (clientY - badgeDragState.startY),
    });
  }

  function finishBadgeDrag() {
    if (!badgeDragState) return;
    const el = ensureBadge();
    const body = document.body;
    if (body) body.style.userSelect = badgeDragState.previousBodyUserSelect;
    document.documentElement.style.userSelect = badgeDragState.previousDocumentUserSelect;
    el.style.cursor = "grab";
    const shouldPersist = badgeDragState.moved && badgePosition;
    badgeDragState = null;
    if (shouldPersist) saveBadgePosition(badgePosition);
  }

  function onBadgeMouseMove(event) {
    if (!badgeDragState) return;
    event.preventDefault();
    moveBadgeDrag(event.clientX, event.clientY);
  }

  function onBadgeMouseUp() {
    document.removeEventListener("mousemove", onBadgeMouseMove);
    document.removeEventListener("mouseup", onBadgeMouseUp);
    finishBadgeDrag();
  }

  function onBadgeMouseDown(event) {
    if (event.button !== 0 || isBadgeControlTarget(event.target)) return;
    event.preventDefault();
    startBadgeDrag(event.clientX, event.clientY);
    document.addEventListener("mousemove", onBadgeMouseMove);
    document.addEventListener("mouseup", onBadgeMouseUp);
  }

  function onBadgeTouchMove(event) {
    if (!badgeDragState) return;
    const point = getTouchPoint(event);
    if (!point) return;
    event.preventDefault();
    moveBadgeDrag(point.clientX, point.clientY);
  }

  function onBadgeTouchEnd() {
    document.removeEventListener("touchmove", onBadgeTouchMove);
    document.removeEventListener("touchend", onBadgeTouchEnd);
    document.removeEventListener("touchcancel", onBadgeTouchEnd);
    finishBadgeDrag();
  }

  function onBadgeTouchStart(event) {
    if (isBadgeControlTarget(event.target)) return;
    const point = getTouchPoint(event);
    if (!point) return;
    event.preventDefault();
    startBadgeDrag(point.clientX, point.clientY);
    document.addEventListener("touchmove", onBadgeTouchMove, { passive: false });
    document.addEventListener("touchend", onBadgeTouchEnd);
    document.addEventListener("touchcancel", onBadgeTouchEnd);
  }

  function dismissBadge() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    if (!badgeEl) return;
    badgeEl.style.display = "none";
    if (badgeTextEl) badgeTextEl.textContent = "";
  }

  function ensureBadge() {
    if (badgeEl) return badgeEl;
    badgeEl = document.createElement("div");
    markDroqsdbUiRoot(badgeEl, "upload-badge");
    badgeEl.style.position = "fixed";
    badgeEl.style.left = `${BADGE_EDGE_MARGIN}px`;
    badgeEl.style.top = `${BADGE_EDGE_MARGIN}px`;
    badgeEl.style.zIndex = "999999";
    badgeEl.style.padding = "8px 42px 8px 10px";
    badgeEl.style.borderRadius = "10px";
    badgeEl.style.fontSize = "12px";
    badgeEl.style.fontFamily = "Arial, sans-serif";
    badgeEl.style.boxShadow = "0 8px 20px rgba(0,0,0,0.35)";
    badgeEl.style.background = "rgba(0,0,0,0.76)";
    badgeEl.style.color = "#fff";
    badgeEl.style.display = "none";
    badgeEl.style.maxWidth = `calc(100vw - ${BADGE_EDGE_MARGIN * 2}px)`;
    badgeEl.style.cursor = "grab";
    badgeEl.style.userSelect = "none";
    badgeEl.style.webkitUserSelect = "none";
    badgeEl.style.touchAction = "none";

    badgeTextEl = document.createElement("div");
    badgeTextEl.style.whiteSpace = "pre-line";
    badgeTextEl.style.lineHeight = "1.35";

    badgeSettingsEl = document.createElement("button");
    badgeSettingsEl.type = "button";
    badgeSettingsEl.textContent = "\u2699";
    badgeSettingsEl.setAttribute("aria-label", "Open DroqsDB settings");
    badgeSettingsEl.style.position = "absolute";
    badgeSettingsEl.style.top = "4px";
    badgeSettingsEl.style.right = "22px";
    badgeSettingsEl.style.width = "14px";
    badgeSettingsEl.style.height = "14px";
    badgeSettingsEl.style.padding = "0";
    badgeSettingsEl.style.margin = "0";
    badgeSettingsEl.style.border = "0";
    badgeSettingsEl.style.background = "transparent";
    badgeSettingsEl.style.color = "rgba(255,255,255,0.9)";
    badgeSettingsEl.style.fontSize = "12px";
    badgeSettingsEl.style.lineHeight = "12px";
    badgeSettingsEl.style.cursor = "pointer";
    badgeSettingsEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettingsModal();
    });

    badgeCloseEl = document.createElement("button");
    badgeCloseEl.type = "button";
    badgeCloseEl.textContent = "×";
    badgeCloseEl.setAttribute("aria-label", "Dismiss badge");
    badgeCloseEl.style.position = "absolute";
    badgeCloseEl.style.top = "4px";
    badgeCloseEl.style.right = "5px";
    badgeCloseEl.style.width = "12px";
    badgeCloseEl.style.height = "12px";
    badgeCloseEl.style.padding = "0";
    badgeCloseEl.style.margin = "0";
    badgeCloseEl.style.border = "0";
    badgeCloseEl.style.background = "transparent";
    badgeCloseEl.style.color = "rgba(255,255,255,0.9)";
    badgeCloseEl.style.fontSize = "14px";
    badgeCloseEl.style.lineHeight = "12px";
    badgeCloseEl.style.cursor = "pointer";

    badgeCloseEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      dismissBadge();
    });

    badgeEl.addEventListener("mousedown", onBadgeMouseDown);
    badgeEl.addEventListener("touchstart", onBadgeTouchStart, { passive: false });
    badgeEl.addEventListener("dragstart", (event) => {
      event.preventDefault();
    });

    badgeEl.appendChild(badgeTextEl);
    badgeEl.appendChild(badgeSettingsEl);
    badgeEl.appendChild(badgeCloseEl);
    (document.body || document.documentElement).appendChild(badgeEl);
    badgePosition = loadBadgePosition();
    window.addEventListener("resize", syncVisibleBadgePosition);
    window.addEventListener("orientationchange", syncVisibleBadgePosition);
    return badgeEl;
  }

  function showBadge(text) {
    if (!shouldRenderUploadToast()) {
      dismissBadge();
      return;
    }
    const el = ensureBadge();
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    badgeTextEl.textContent = text;
    el.style.display = "block";
    applyBadgePosition(badgePosition || loadBadgePosition() || getDefaultBadgePosition(el));
  }

  function hideBadgeSoon(ms = 1200) {
    if (!shouldRenderUploadToast()) {
      dismissBadge();
      return;
    }
    if (!badgeEl) return;
    const el = badgeEl;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      el.style.display = "none";
      badgeTextEl.textContent = "";
      hideTimer = null;
    }, ms);
  }

  function debugBadge(text) {
    if (!DEBUG) return;
    showBadge(text);
    hideBadgeSoon(1800);
  }

  // ---------------- Companion Panel ----------------
  function shouldEnableTravelPlanner(settings = getSettings()) {
    return isTravelPage() &&
      settings.disableAllUi !== true &&
      settings.mode === "enhanced" &&
      settings.helpers?.travelPlannerEnabled === true;
  }

  function shouldEnableCountryHelper(settings = getSettings()) {
    return isTravelPage() &&
      settings.disableAllUi !== true &&
      settings.mode === "enhanced" &&
      settings.helpers?.countryHelperEnabled === true;
  }

  function getCompanionPanelChrome(context = companionPanelState.context) {
    if (context?.mode === "country-helper") {
      return {
        panelAriaLabel: "DroqsDB Country Helper",
        title: "Country Helper",
        subtitle: "Best current in-stock item",
        launcherLabel: "Helper",
        launcherAriaLabel: "Open DroqsDB Country Helper",
        launcherTitle: "Open Country Helper",
        minimizeAriaLabel: "Minimize Country Helper",
      };
    }

    return {
      panelAriaLabel: "DroqsDB Travel Planner",
      title: "Travel Planner",
      subtitle: "Current companion picks",
      launcherLabel: "Planner",
      launcherAriaLabel: "Open DroqsDB Travel Planner",
      launcherTitle: "Open Travel Planner",
      minimizeAriaLabel: "Minimize Travel Planner",
    };
  }

  function applyCompanionPanelChrome(context = companionPanelState.context) {
    const chrome = getCompanionPanelChrome(context);
    if (companionPanelEl) {
      companionPanelEl.setAttribute("aria-label", chrome.panelAriaLabel);
    }
    if (companionPanelTitleEl) companionPanelTitleEl.textContent = chrome.title;
    if (companionPanelSubtitleEl) companionPanelSubtitleEl.textContent = chrome.subtitle;
    if (companionLauncherEl) {
      companionLauncherEl.textContent = chrome.launcherLabel;
      companionLauncherEl.setAttribute("aria-label", chrome.launcherAriaLabel);
      companionLauncherEl.title = chrome.launcherTitle;
    }
    if (companionPanelCloseEl) {
      companionPanelCloseEl.setAttribute("aria-label", chrome.minimizeAriaLabel);
    }
  }

  function isCompanionControlTarget(target) {
    if (!(target instanceof Node)) return false;
    return Boolean(
      (companionPanelSettingsEl && companionPanelSettingsEl.contains(target)) ||
      (companionPanelCloseEl && companionPanelCloseEl.contains(target)) ||
      (companionLauncherEl && companionLauncherEl.contains(target))
    );
  }

  function clampCompanionPanelPosition(position, el = companionPanelEl || companionLauncherEl) {
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const { width, height } = getBadgeSize(el);
    const maxLeft = Math.max(COMPANION_PANEL_EDGE_MARGIN, viewportWidth - width - COMPANION_PANEL_EDGE_MARGIN);
    const maxTop = Math.max(COMPANION_PANEL_EDGE_MARGIN, viewportHeight - height - COMPANION_PANEL_EDGE_MARGIN);
    return {
      left: clampNumber(Math.round(position.left), COMPANION_PANEL_EDGE_MARGIN, maxLeft),
      top: clampNumber(Math.round(position.top), COMPANION_PANEL_EDGE_MARGIN, maxTop),
    };
  }

  function getDefaultCompanionPanelPosition(el = companionPanelEl || companionLauncherEl) {
    const { width: viewportWidth } = getViewportSize();
    const { width } = getBadgeSize(el);
    return clampCompanionPanelPosition({
      left: viewportWidth - width - COMPANION_PANEL_EDGE_MARGIN,
      top: COMPANION_PANEL_DEFAULT_TOP,
    }, el);
  }

  function applyCompanionPanelPosition(position, { persist = false } = {}) {
    const panel = companionPanelEl || ensureCompanionPanel();
    const launcher = companionLauncherEl || ensureCompanionLauncher();
    const anchorEl = panel.style.display !== "none" ? panel : launcher;
    const nextPosition = clampCompanionPanelPosition(
      position || loadCompanionPanelPosition() || getDefaultCompanionPanelPosition(anchorEl),
      anchorEl
    );

    companionPanelPosition = nextPosition;

    for (const el of [panel, launcher]) {
      el.style.left = `${nextPosition.left}px`;
      el.style.top = `${nextPosition.top}px`;
      el.style.right = "auto";
      el.style.bottom = "auto";
    }

    if (persist) saveCompanionPanelPosition(nextPosition);
    return nextPosition;
  }

  function syncVisibleCompanionPanelPosition() {
    const visibleEl =
      companionPanelEl && companionPanelEl.style.display !== "none"
        ? companionPanelEl
        : (companionLauncherEl && companionLauncherEl.style.display !== "none" ? companionLauncherEl : null);
    if (!visibleEl) return;
    applyCompanionPanelPosition(companionPanelPosition || loadCompanionPanelPosition() || getDefaultCompanionPanelPosition(visibleEl));
  }

  function startCompanionPanelDrag(clientX, clientY) {
    const el = companionPanelEl || ensureCompanionPanel();
    const rect = el.getBoundingClientRect();
    const body = document.body;
    companionPanelDragState = {
      startX: clientX,
      startY: clientY,
      originLeft: rect.left,
      originTop: rect.top,
      moved: false,
      previousBodyUserSelect: body ? body.style.userSelect : "",
      previousDocumentUserSelect: document.documentElement.style.userSelect,
    };
    if (body) body.style.userSelect = "none";
    document.documentElement.style.userSelect = "none";
    if (companionPanelHeaderEl) companionPanelHeaderEl.style.cursor = "grabbing";
  }

  function moveCompanionPanelDrag(clientX, clientY) {
    if (!companionPanelDragState) return;
    companionPanelDragState.moved = true;
    applyCompanionPanelPosition({
      left: companionPanelDragState.originLeft + (clientX - companionPanelDragState.startX),
      top: companionPanelDragState.originTop + (clientY - companionPanelDragState.startY),
    });
  }

  function finishCompanionPanelDrag() {
    if (!companionPanelDragState) return;
    const body = document.body;
    if (body) body.style.userSelect = companionPanelDragState.previousBodyUserSelect;
    document.documentElement.style.userSelect = companionPanelDragState.previousDocumentUserSelect;
    if (companionPanelHeaderEl) companionPanelHeaderEl.style.cursor = "grab";
    const shouldPersist = companionPanelDragState.moved && companionPanelPosition;
    companionPanelDragState = null;
    if (shouldPersist) saveCompanionPanelPosition(companionPanelPosition);
  }

  function onCompanionPanelMouseMove(event) {
    if (!companionPanelDragState) return;
    event.preventDefault();
    moveCompanionPanelDrag(event.clientX, event.clientY);
  }

  function onCompanionPanelMouseUp() {
    document.removeEventListener("mousemove", onCompanionPanelMouseMove);
    document.removeEventListener("mouseup", onCompanionPanelMouseUp);
    finishCompanionPanelDrag();
  }

  function onCompanionPanelMouseDown(event) {
    if (event.button !== 0 || isCompanionControlTarget(event.target)) return;
    event.preventDefault();
    startCompanionPanelDrag(event.clientX, event.clientY);
    document.addEventListener("mousemove", onCompanionPanelMouseMove);
    document.addEventListener("mouseup", onCompanionPanelMouseUp);
  }

  function onCompanionPanelTouchMove(event) {
    if (!companionPanelDragState) return;
    const point = getTouchPoint(event);
    if (!point) return;
    event.preventDefault();
    moveCompanionPanelDrag(point.clientX, point.clientY);
  }

  function onCompanionPanelTouchEnd() {
    document.removeEventListener("touchmove", onCompanionPanelTouchMove);
    document.removeEventListener("touchend", onCompanionPanelTouchEnd);
    document.removeEventListener("touchcancel", onCompanionPanelTouchEnd);
    finishCompanionPanelDrag();
  }

  function onCompanionPanelTouchStart(event) {
    if (isCompanionControlTarget(event.target)) return;
    const point = getTouchPoint(event);
    if (!point) return;
    event.preventDefault();
    startCompanionPanelDrag(point.clientX, point.clientY);
    document.addEventListener("touchmove", onCompanionPanelTouchMove, { passive: false });
    document.addEventListener("touchend", onCompanionPanelTouchEnd);
    document.addEventListener("touchcancel", onCompanionPanelTouchEnd);
  }

  function setCompanionPanelMinimized(minimized, { persist = true } = {}) {
    if (persist) saveCompanionPanelMinimized(minimized);
    syncCompanionPanelVisibility(companionPanelState.context);
  }

  function ensureCompanionLauncher() {
    if (companionLauncherEl) return companionLauncherEl;

    const chrome = getCompanionPanelChrome();
    companionLauncherEl = document.createElement("button");
    markDroqsdbUiRoot(companionLauncherEl, "companion-launcher");
    companionLauncherEl.type = "button";
    companionLauncherEl.textContent = chrome.launcherLabel;
    companionLauncherEl.setAttribute("aria-label", chrome.launcherAriaLabel);
    companionLauncherEl.title = chrome.launcherTitle;
    companionLauncherEl.style.position = "fixed";
    companionLauncherEl.style.zIndex = "999997";
    companionLauncherEl.style.display = "none";
    companionLauncherEl.style.alignItems = "center";
    companionLauncherEl.style.justifyContent = "center";
    companionLauncherEl.style.minWidth = "64px";
    companionLauncherEl.style.height = "28px";
    companionLauncherEl.style.padding = "0 10px";
    companionLauncherEl.style.border = "1px solid rgba(255,255,255,0.18)";
    companionLauncherEl.style.borderRadius = "999px";
    companionLauncherEl.style.background = "rgba(0,0,0,0.7)";
    companionLauncherEl.style.color = "#fff";
    companionLauncherEl.style.fontFamily = "Arial, sans-serif";
    companionLauncherEl.style.fontSize = "11px";
    companionLauncherEl.style.fontWeight = "700";
    companionLauncherEl.style.letterSpacing = "0.03em";
    companionLauncherEl.style.cursor = "pointer";
    companionLauncherEl.style.boxShadow = "0 8px 18px rgba(0,0,0,0.28)";
    companionLauncherEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCompanionPanelMinimized(false);
    });

    (document.body || document.documentElement).appendChild(companionLauncherEl);
    applyCompanionPanelChrome();
    return companionLauncherEl;
  }

  function ensureCompanionPanel() {
    if (companionPanelEl) return companionPanelEl;

    const chrome = getCompanionPanelChrome();
    companionPanelEl = document.createElement("section");
    markDroqsdbUiRoot(companionPanelEl, "companion-panel");
    companionPanelEl.setAttribute("aria-label", chrome.panelAriaLabel);
    companionPanelEl.style.position = "fixed";
    companionPanelEl.style.left = `${COMPANION_PANEL_EDGE_MARGIN}px`;
    companionPanelEl.style.top = `${COMPANION_PANEL_DEFAULT_TOP}px`;
    companionPanelEl.style.zIndex = "999997";
    companionPanelEl.style.display = "none";
    companionPanelEl.style.width = "min(300px, calc(100vw - 24px))";
    companionPanelEl.style.maxWidth = "calc(100vw - 24px)";
    companionPanelEl.style.maxHeight = "calc(100vh - 24px)";
    companionPanelEl.style.border = "1px solid rgba(255,255,255,0.16)";
    companionPanelEl.style.borderRadius = "12px";
    companionPanelEl.style.background = "rgba(12,12,12,0.92)";
    companionPanelEl.style.color = "#fff";
    companionPanelEl.style.boxShadow = "0 18px 36px rgba(0,0,0,0.35)";
    companionPanelEl.style.fontFamily = "Arial, sans-serif";
    companionPanelEl.style.backdropFilter = "blur(4px)";
    companionPanelEl.style.overflow = "hidden";

    companionPanelHeaderEl = document.createElement("div");
    companionPanelHeaderEl.style.display = "flex";
    companionPanelHeaderEl.style.alignItems = "center";
    companionPanelHeaderEl.style.justifyContent = "space-between";
    companionPanelHeaderEl.style.gap = "8px";
    companionPanelHeaderEl.style.padding = "10px 10px 9px";
    companionPanelHeaderEl.style.borderBottom = "1px solid rgba(255,255,255,0.1)";
    companionPanelHeaderEl.style.cursor = "grab";
    companionPanelHeaderEl.style.userSelect = "none";
    companionPanelHeaderEl.style.webkitUserSelect = "none";
    companionPanelHeaderEl.style.touchAction = "none";

    const titleWrap = document.createElement("div");
    titleWrap.style.minWidth = "0";

    companionPanelTitleEl = document.createElement("div");
    companionPanelTitleEl.textContent = chrome.title;
    companionPanelTitleEl.style.fontSize = "13px";
    companionPanelTitleEl.style.fontWeight = "700";
    companionPanelTitleEl.style.letterSpacing = "0.02em";

    companionPanelSubtitleEl = document.createElement("div");
    companionPanelSubtitleEl.textContent = chrome.subtitle;
    companionPanelSubtitleEl.style.fontSize = "11px";
    companionPanelSubtitleEl.style.color = "rgba(255,255,255,0.62)";
    companionPanelSubtitleEl.style.marginTop = "2px";

    titleWrap.appendChild(companionPanelTitleEl);
    titleWrap.appendChild(companionPanelSubtitleEl);

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.alignItems = "center";
    controls.style.gap = "6px";

    companionPanelSettingsEl = document.createElement("button");
    companionPanelSettingsEl.type = "button";
    companionPanelSettingsEl.textContent = "\u2699";
    companionPanelSettingsEl.setAttribute("aria-label", "Open DroqsDB settings");
    companionPanelSettingsEl.style.width = "18px";
    companionPanelSettingsEl.style.height = "18px";
    companionPanelSettingsEl.style.padding = "0";
    companionPanelSettingsEl.style.border = "0";
    companionPanelSettingsEl.style.background = "transparent";
    companionPanelSettingsEl.style.color = "rgba(255,255,255,0.9)";
    companionPanelSettingsEl.style.fontSize = "13px";
    companionPanelSettingsEl.style.lineHeight = "18px";
    companionPanelSettingsEl.style.cursor = "pointer";
    companionPanelSettingsEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openSettingsModal();
    });

    companionPanelCloseEl = document.createElement("button");
    companionPanelCloseEl.type = "button";
    companionPanelCloseEl.textContent = "×";
    companionPanelCloseEl.setAttribute("aria-label", chrome.minimizeAriaLabel);
    companionPanelCloseEl.style.width = "18px";
    companionPanelCloseEl.style.height = "18px";
    companionPanelCloseEl.style.padding = "0";
    companionPanelCloseEl.style.border = "0";
    companionPanelCloseEl.style.background = "transparent";
    companionPanelCloseEl.style.color = "rgba(255,255,255,0.9)";
    companionPanelCloseEl.style.fontSize = "16px";
    companionPanelCloseEl.style.lineHeight = "18px";
    companionPanelCloseEl.style.cursor = "pointer";
    companionPanelCloseEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setCompanionPanelMinimized(true);
    });

    controls.appendChild(companionPanelSettingsEl);
    controls.appendChild(companionPanelCloseEl);
    companionPanelHeaderEl.appendChild(titleWrap);
    companionPanelHeaderEl.appendChild(controls);

    companionPanelContentEl = document.createElement("div");
    companionPanelContentEl.style.padding = "10px";
    companionPanelContentEl.style.display = "grid";
    companionPanelContentEl.style.gap = "10px";
    companionPanelContentEl.style.maxHeight = "calc(100vh - 74px)";
    companionPanelContentEl.style.overflowY = "auto";

    companionPanelHeaderEl.addEventListener("mousedown", onCompanionPanelMouseDown);
    companionPanelHeaderEl.addEventListener("touchstart", onCompanionPanelTouchStart, { passive: false });

    companionPanelEl.appendChild(companionPanelHeaderEl);
    companionPanelEl.appendChild(companionPanelContentEl);
    (document.body || document.documentElement).appendChild(companionPanelEl);
    companionPanelPosition = loadCompanionPanelPosition();
    window.addEventListener("resize", syncVisibleCompanionPanelPosition);
    window.addEventListener("orientationchange", syncVisibleCompanionPanelPosition);
    applyCompanionPanelChrome();
    return companionPanelEl;
  }

  function hideCompanionPanelUi() {
    if (companionPanelEl) companionPanelEl.style.display = "none";
    if (companionLauncherEl) companionLauncherEl.style.display = "none";
  }

  function syncCompanionPanelVisibility(context = companionPanelState.context) {
    if (!context?.eligible) {
      hideCompanionPanelUi();
      return;
    }

    const panel = ensureCompanionPanel();
    const launcher = ensureCompanionLauncher();
    const minimized = isCompanionPanelMinimized();
    applyCompanionPanelChrome(context);

    panel.style.display = minimized ? "none" : "block";
    launcher.style.display = minimized ? "inline-flex" : "none";

    applyCompanionPanelPosition(
      companionPanelPosition || loadCompanionPanelPosition() || getDefaultCompanionPanelPosition(minimized ? launcher : panel)
    );
  }

  function createCompanionTextBlock(text, styles = {}) {
    const el = document.createElement("div");
    el.textContent = text;
    Object.assign(el.style, styles);
    return el;
  }

  function createCompanionStat(label, value, { mutedValue = false, valueTitle = "" } = {}) {
    const cell = document.createElement("div");
    cell.style.minWidth = "0";

    const labelEl = createCompanionTextBlock(label, {
      fontSize: "10px",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      color: "rgba(255,255,255,0.56)",
      marginBottom: "2px",
    });

    const valueEl = createCompanionTextBlock(value, {
      fontSize: "12px",
      lineHeight: "1.35",
      color: mutedValue ? "rgba(255,255,255,0.62)" : "#fff",
      wordBreak: "break-word",
    });
    if (valueTitle) valueEl.title = valueTitle;

    cell.appendChild(labelEl);
    cell.appendChild(valueEl);
    return cell;
  }

  function isCompanionOutOfStockNow(stock) {
    const numeric = Number(stock);
    return Number.isFinite(numeric) && numeric <= 0;
  }

  function shouldShowCompanionArrivalStockNote(entry) {
    if (!isCompanionOutOfStockNow(entry?.stock)) return false;
    const runKind = String(entry?.runKind || "").trim().toLowerCase();
    if (runKind === "restocks_before_arrival" || runKind === "stockout_then_restock_before_arrival") {
      return true;
    }
    return !runKind;
  }

  function appendCompanionStatsGrid(statsGrid, entry, {
    showBuyPrice = true,
    showRunCost = false,
    hideMissingStock = false,
  } = {}) {
    const settings = getSettings();
    const sellPriceMeta = getCompanionSelectedSellPriceMeta(entry, settings);
    const profitPerItemMeta = getCompanionMetricValueMeta(entry?.profitPerItem, entry, settings);
    const profitPerMinuteMeta = getCompanionMetricValueMeta(entry?.profitPerMinute, entry, settings);

    if (!hideMissingStock || Number.isFinite(Number(entry?.stock))) {
      statsGrid.appendChild(createCompanionStat("Stock", formatCompanionNumber(entry?.stock)));
    }
    if (showBuyPrice) {
      statsGrid.appendChild(createCompanionStat("Buy Price", formatCompanionNumber(entry?.buyPrice, { currency: true })));
    }
    if (showRunCost) {
      statsGrid.appendChild(createCompanionStat("Run Cost", formatCompanionNumber(entry?.runCost, { currency: true })));
    }
    statsGrid.appendChild(createCompanionStat(
      getCompanionSellValueLabel(settings),
      sellPriceMeta.text,
      { mutedValue: sellPriceMeta.muted, valueTitle: sellPriceMeta.title }
    ));
    statsGrid.appendChild(createCompanionStat(
      "Profit / Item",
      profitPerItemMeta.text,
      { mutedValue: profitPerItemMeta.muted, valueTitle: profitPerItemMeta.title }
    ));
    statsGrid.appendChild(createCompanionStat(
      "Profit / Min",
      profitPerMinuteMeta.text,
      { mutedValue: profitPerMinuteMeta.muted, valueTitle: profitPerMinuteMeta.title }
    ));
  }

  function getTravelPlannerCategoryGroupConfigs(settings = getSettings()) {
    return TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS
      .filter((option) => isTravelPlannerCategoryGroupEnabled(settings, option.value))
      .map((option) => ({ ...option }));
  }

  function getCompanionResultRankLabel(index) {
    if (index === 0) return "Best";
    if (index === 1) return "2nd";
    if (index === 2) return "3rd";
    return `#${Number(index) + 1}`;
  }

  function formatCompanionNumber(value, { currency = false } = {}) {
    if (value === null || value === undefined || value === "") return "—";
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return "—";
    const maximumFractionDigits = Number.isInteger(numeric) ? 0 : (Math.abs(numeric) < 10 ? 2 : 1);
    const formatted = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: 0,
      maximumFractionDigits,
    }).format(numeric);
    return currency ? `$${formatted}` : formatted;
  }

  function getCompanionFiniteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function formatCompanionEtaMinutes(value) {
    const minutes = getCompanionFiniteNumber(value);
    if (minutes === null || minutes < 0) return null;
    const rounded = Math.max(0, Math.round(minutes));
    if (rounded < 60) return `~${rounded}m`;
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return remainder ? `~${hours}h ${remainder}m` : `~${hours}h`;
  }

  function formatCompanionCompactDuration(value) {
    const minutes = getCompanionFiniteNumber(value);
    if (minutes === null || minutes < 0) return null;
    const rounded = Math.max(0, Math.round(minutes));
    if (!rounded) return "0m";
    if (rounded < 60) return `${rounded}m`;
    const hours = Math.floor(rounded / 60);
    const remainder = rounded % 60;
    return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
  }

  function formatCompanionUtcClockTime(value) {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const hours = String(date.getUTCHours()).padStart(2, "0");
    const minutes = String(date.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes} TCT`;
  }

  function normalizeTravelPlannerEmptyStateGuidance(guidance) {
    const kind = String(guidance?.kind || "").trim();
    if (!["next_run", "timing_unreliable", "no_viable_runs"].includes(kind)) return null;

    return {
      kind,
      itemName: String(guidance?.itemName || "").trim() || null,
      country: String(guidance?.country || "").trim() || null,
      reasonCode: String(guidance?.reasonCode || "").trim() || null,
      message: String(guidance?.message || "").trim() || null,
      messageShort: String(guidance?.messageShort || "").trim() || null,
      messageDetailed: String(guidance?.messageDetailed || "").trim() || null,
      runKind: String(guidance?.runKind || "").trim() || null,
      departureMinutes: getCompanionFiniteNumber(guidance?.departureMinutes),
      departureAt: guidance?.departureAt || null,
      arrivalAt: guidance?.arrivalAt || null,
      restockAt: guidance?.restockAt || null,
      stockoutAt: guidance?.stockoutAt || null,
      viableWindowDurationMinutes: getCompanionFiniteNumber(guidance?.viableWindowDurationMinutes),
      arrivalBufferMinutes: getCompanionFiniteNumber(guidance?.arrivalBufferMinutes),
      tightWindow: guidance?.tightWindow === true,
    };
  }

  function getTravelPlannerGuidanceDepartureText(guidance) {
    const departureAtMs = guidance?.departureAt ? new Date(guidance.departureAt).getTime() : NaN;
    if (Number.isFinite(departureAtMs)) {
      const minutes = Math.max(0, Math.round((departureAtMs - Date.now()) / 60000));
      return minutes ? `in ${formatCompanionCompactDuration(minutes)}` : "now";
    }

    const fallbackMinutes = getCompanionFiniteNumber(guidance?.departureMinutes);
    if (fallbackMinutes === null || fallbackMinutes < 0) return null;
    const rounded = Math.max(0, Math.round(fallbackMinutes));
    return rounded ? `in ${formatCompanionCompactDuration(rounded)}` : "now";
  }

  function getTravelPlannerGuidanceMessage(guidance) {
    if (!guidance) return null;
    if (guidance.messageDetailed) return guidance.messageDetailed;
    if (guidance.messageShort) return guidance.messageShort;

    if (guidance.kind === "next_run") {
      const routeText = guidance.itemName && guidance.country
        ? `${guidance.itemName} in ${guidance.country}`
        : guidance.itemName || guidance.country || null;
      const departureText = getTravelPlannerGuidanceDepartureText(guidance);
      const departureClock = formatCompanionUtcClockTime(guidance.departureAt);
      const windowText = formatCompanionEtaMinutes(guidance.viableWindowDurationMinutes);
      const parts = ["No runs currently available."];

      if (routeText) parts.push(`Next best: ${routeText}.`);
      if (departureText && departureClock) {
        parts.push(`Depart ${departureText} at ${departureClock}.`);
      } else if (departureText) {
        parts.push(`Depart ${departureText}.`);
      } else if (departureClock) {
        parts.push(`Depart at ${departureClock}.`);
      }
      if (windowText) parts.push(`Window: ${windowText}.`);
      if (guidance.tightWindow) parts.push("Tight timing window.");

      return parts.join(" ");
    }

    if (guidance.kind === "timing_unreliable") {
      return guidance.message
        ? `No runs currently available. ${guidance.message}`
        : "No runs currently available. Upcoming restocks are too inconsistent to reliably predict a profitable departure window.";
    }

    if (guidance.kind === "no_viable_runs") {
      return "No runs currently available under your current filters and settings.";
    }

    return null;
  }

  function getCompanionSelectedSellWhere(settings = getSettings()) {
    return normalizeSellWhereSetting(settings?.profit?.sellWhere);
  }

  function getCompanionSellValueLabel(settings = getSettings()) {
    const sellWhere = getCompanionSelectedSellWhere(settings);
    return COMPANION_SELL_VALUE_LABELS[sellWhere] || COMPANION_SELL_VALUE_LABELS.market;
  }

  function getCompanionSelectedSellPrice(entry, settings = getSettings()) {
    const sellWhere = getCompanionSelectedSellWhere(settings);
    if (sellWhere === "torn") return getCompanionFiniteNumber(entry?.tornCityShops);
    if (sellWhere === "bazaar") return getCompanionFiniteNumber(entry?.bazaarPrice);
    return getCompanionFiniteNumber(entry?.marketValue);
  }

  function getCompanionBazaarUnavailableTitle(entry, settings = getSettings()) {
    if (getCompanionSelectedSellWhere(settings) !== "bazaar") return "";
    if (getCompanionFiniteNumber(entry?.bazaarPrice) !== null) return "";
    return "Bazaar price unavailable. No valid listings above $1 were found, $1-only listings were ignored, or bazaar data is temporarily unavailable.";
  }

  function getCompanionUnavailableValueMeta(entry, settings = getSettings()) {
    const title = getCompanionBazaarUnavailableTitle(entry, settings);
    return {
      text: title ? "Unavailable" : "—",
      muted: true,
      title,
    };
  }

  function getCompanionSelectedSellPriceMeta(entry, settings = getSettings()) {
    const numeric = getCompanionSelectedSellPrice(entry, settings);
    if (numeric !== null) {
      return {
        text: formatCompanionNumber(numeric, { currency: true }),
        muted: false,
        title: "",
      };
    }
    return getCompanionUnavailableValueMeta(entry, settings);
  }

  function getCompanionMetricValueMeta(value, entry, settings = getSettings()) {
    const numeric = getCompanionFiniteNumber(value);
    if (numeric !== null) {
      return {
        text: formatCompanionNumber(numeric, { currency: true }),
        muted: false,
        title: "",
      };
    }
    return getCompanionUnavailableValueMeta(entry, settings);
  }

  function formatCompanionSource(source) {
    const normalized = String(source || "").trim().toLowerCase();
    if (!normalized) return null;
    if (normalized === "db" || normalized === "droqsdb") return "DroqsDB";
    if (normalized === "yata") return "YATA";
    if (normalized === "none") return "No data";
    return normalized.toUpperCase();
  }

  function formatCompanionFreshness(updatedAt) {
    const time = updatedAt ? new Date(updatedAt) : null;
    const ageMs = time ? Date.now() - time.getTime() : NaN;
    if (!Number.isFinite(ageMs) || ageMs < 0) return null;

    const minutes = Math.max(0, Math.round(ageMs / 60000));
    if (minutes <= 1) return "just now";
    if (minutes < 60) return `${minutes}m old`;

    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h old`;

    return `${Math.round(hours / 24)}d old`;
  }

  function getCompanionSourceFreshnessText(entry) {
    const parts = [];
    const source = formatCompanionSource(entry?.source);
    const freshness = formatCompanionFreshness(entry?.updatedAt);
    if (source) parts.push(source);
    if (freshness) parts.push(freshness);
    return parts.join(" · ");
  }

  function getTravelPlannerEmptyMessage(emptyReason, guidance = null, settings = getSettings()) {
    const guidanceMessage = getTravelPlannerGuidanceMessage(guidance);
    if (guidanceMessage) return guidanceMessage;

    const bazaarSelected = getCompanionSelectedSellWhere(settings) === "bazaar";
    if (emptyReason === "FILTERS_EXCLUDED_ALL_RESULTS") {
      return bazaarSelected
        ? "No Bazaar-priced qualifying run matches your saved filters."
        : "No qualifying run matches your saved filters.";
    }
    if (emptyReason === "NO_QUALIFIED_RUNS") {
      return bazaarSelected
        ? "No arrival-safe Bazaar run qualifies right now."
        : "No arrival-safe run qualifies right now.";
    }
    return bazaarSelected
      ? "No profitable run with Bazaar pricing is available right now."
      : "No profitable run is available right now.";
  }

  function getCountryHelperEmptyMessage(country, emptyReason, settings = getSettings()) {
    const bazaarSelected = getCompanionSelectedSellWhere(settings) === "bazaar";
    if (emptyReason === "FILTERS_EXCLUDED_ALL_RESULTS") {
      return bazaarSelected
        ? "No Bazaar-priced qualifying item matches your saved filters."
        : "No qualifying item matches your saved filters.";
    }
    if (emptyReason === "NO_PROFITABLE_ITEMS") {
      return bazaarSelected
        ? `No profitable in-stock Bazaar item is available in ${country}.`
        : `No profitable in-stock item is available in ${country}.`;
    }
    if (emptyReason === "NO_IN_STOCK_ITEMS") return `No in-stock items are available in ${country}.`;
    return bazaarSelected
      ? `No qualifying Bazaar item is available in ${country}.`
      : `No qualifying item is available in ${country}.`;
  }

  function getTravelPlannerCategoryGroupsEmptyMessage(groups, settings = getSettings()) {
    const categoryGroups = Array.isArray(groups) ? groups : [];
    const bazaarSelected = getCompanionSelectedSellWhere(settings) === "bazaar";
    if (categoryGroups.some((group) => group?.status === "unavailable")) {
      return "Selected category groups are unavailable right now.";
    }

    const emptyReasons = categoryGroups
      .map((group) => String(group?.emptyReason || "").trim())
      .filter(Boolean);

    if (emptyReasons.length && emptyReasons.every((reason) => reason === "FILTERS_EXCLUDED_ALL_RESULTS")) {
      return bazaarSelected
        ? "No Bazaar-priced selected category group matches your saved filters."
        : "No selected category group matches your saved filters.";
    }
    if (emptyReasons.length && emptyReasons.every((reason) => reason === "NO_QUALIFIED_RUNS")) {
      return bazaarSelected
        ? "No arrival-safe Bazaar run qualifies in the selected category groups right now."
        : "No arrival-safe run qualifies in the selected category groups right now.";
    }
    return bazaarSelected
      ? "No profitable Bazaar-priced run is available in the selected category groups right now."
      : "No profitable run is available in the selected category groups right now.";
  }

  function buildCompanionResultEntryCard(entry, {
    rankLabel = "",
    showCountryMeta = true,
    showCategoryMeta = true,
    countryOverride = null,
    showBuyPrice = true,
    showRunCost = false,
    hideMissingStock = false,
    showArrivalStockNote = false,
  } = {}) {
    const card = document.createElement("article");
    card.style.padding = "8px";
    card.style.border = "1px solid rgba(255,255,255,0.08)";
    card.style.borderRadius = "8px";
    card.style.background = "rgba(255,255,255,0.025)";
    card.style.boxSizing = "border-box";
    card.style.minWidth = "0";

    if (rankLabel) {
      card.appendChild(createCompanionTextBlock(rankLabel, {
        fontSize: "10px",
        fontWeight: "700",
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: "rgba(255,255,255,0.6)",
        marginBottom: "4px",
      }));
    }

    const titleRow = createCompanionTextBlock(entry.itemName || "Unknown item", {
      fontSize: "13px",
      fontWeight: "700",
      lineHeight: "1.35",
      marginBottom: "4px",
    });

    const metaParts = [];
    const displayCountry = countryOverride || entry.country || null;
    if (showCountryMeta && displayCountry) metaParts.push(displayCountry);
    if (showCategoryMeta && (entry.category || entry.shopCategory)) metaParts.push(entry.category || entry.shopCategory);
    if (metaParts.length) {
      card.appendChild(titleRow);
      card.appendChild(createCompanionTextBlock(metaParts.join(" · "), {
        fontSize: "11px",
        color: "rgba(255,255,255,0.66)",
        lineHeight: "1.35",
        marginBottom: "8px",
      }));
    } else {
      titleRow.style.marginBottom = "8px";
      card.appendChild(titleRow);
    }

    const statsGrid = document.createElement("div");
    statsGrid.style.display = "grid";
    statsGrid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    statsGrid.style.gap = "8px 10px";
    appendCompanionStatsGrid(statsGrid, entry, {
      showBuyPrice,
      showRunCost,
      hideMissingStock,
    });
    card.appendChild(statsGrid);

    if (showArrivalStockNote && shouldShowCompanionArrivalStockNote(entry)) {
      card.appendChild(createCompanionTextBlock("Currently out of stock; expected in stock on arrival.", {
        marginTop: "8px",
        fontSize: "11px",
        color: "rgba(255,255,255,0.62)",
        lineHeight: "1.35",
      }));
    }

    const sourceText = getCompanionSourceFreshnessText(entry);
    if (sourceText) {
      card.appendChild(createCompanionTextBlock(sourceText, {
        marginTop: "8px",
        fontSize: "11px",
        color: "rgba(255,255,255,0.58)",
        lineHeight: "1.35",
      }));
    }

    return card;
  }

  function buildCompanionResultListSection({
    title,
    status,
    entries,
    emptyText,
    showCountryMeta = true,
    showCategoryMeta = true,
    countryOverride = null,
    showBuyPrice = true,
    showRunCost = false,
    hideMissingStock = false,
    treatUnavailableAsEmpty = false,
    showArrivalStockNote = false,
    loadingText = "Loading...",
  }) {
    const section = document.createElement("section");
    section.style.padding = "10px";
    section.style.border = "1px solid rgba(255,255,255,0.08)";
    section.style.borderRadius = "10px";
    section.style.background = "rgba(255,255,255,0.03)";

    const resolvedStatus = treatUnavailableAsEmpty && status === "unavailable" ? "empty" : status;
    const heading = createCompanionTextBlock(title, {
      fontSize: "11px",
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      color: "rgba(255,255,255,0.72)",
      marginBottom: "8px",
    });
    section.appendChild(heading);

    if (resolvedStatus === "loading" || resolvedStatus === "hidden" || resolvedStatus === "queued") {
      section.appendChild(createCompanionTextBlock(loadingText, {
        fontSize: "12px",
        color: "rgba(255,255,255,0.72)",
        lineHeight: "1.4",
      }));
      return section;
    }

    if (resolvedStatus === "unavailable") {
      section.appendChild(createCompanionTextBlock("Unavailable right now.", {
        fontSize: "12px",
        color: "rgba(255,255,255,0.64)",
        lineHeight: "1.4",
      }));
      return section;
    }

    const visibleEntries = (Array.isArray(entries) ? entries : []).filter(Boolean);
    if (resolvedStatus !== "ready" || !visibleEntries.length) {
      section.appendChild(createCompanionTextBlock(emptyText, {
        fontSize: "12px",
        color: "rgba(255,255,255,0.68)",
        lineHeight: "1.4",
      }));
      return section;
    }

    const entriesWrap = document.createElement("div");
    entriesWrap.style.display = "grid";
    entriesWrap.style.gap = "8px";
    entriesWrap.style.minWidth = "0";

    visibleEntries.forEach((entry, index) => {
      entriesWrap.appendChild(buildCompanionResultEntryCard(entry, {
        rankLabel: getCompanionResultRankLabel(index),
        showCountryMeta,
        showCategoryMeta,
        countryOverride,
        showBuyPrice,
        showRunCost,
        hideMissingStock,
        showArrivalStockNote,
      }));
    });

    section.appendChild(entriesWrap);
    return section;
  }

  function buildCompanionResultSection({
    title,
    status,
    entry,
    emptyText,
    showCountryMeta = true,
    showCategoryMeta = true,
    countryOverride = null,
    showBuyPrice = true,
    showRunCost = false,
    hideMissingStock = false,
    treatUnavailableAsEmpty = false,
    showArrivalStockNote = false,
    loadingText = "Loading...",
  }) {
    const section = document.createElement("section");
    section.style.padding = "10px";
    section.style.border = "1px solid rgba(255,255,255,0.08)";
    section.style.borderRadius = "10px";
    section.style.background = "rgba(255,255,255,0.03)";

    const resolvedStatus = treatUnavailableAsEmpty && status === "unavailable" ? "empty" : status;

    const heading = createCompanionTextBlock(title, {
      fontSize: "11px",
      fontWeight: "700",
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      color: "rgba(255,255,255,0.72)",
      marginBottom: "8px",
    });
    section.appendChild(heading);

    if (resolvedStatus === "loading" || resolvedStatus === "queued") {
      section.appendChild(createCompanionTextBlock(loadingText, {
        fontSize: "12px",
        color: "rgba(255,255,255,0.72)",
        lineHeight: "1.4",
      }));
      return section;
    }

    if (resolvedStatus === "unavailable") {
      section.appendChild(createCompanionTextBlock("Unavailable right now.", {
        fontSize: "12px",
        color: "rgba(255,255,255,0.64)",
        lineHeight: "1.4",
      }));
      return section;
    }

    if (resolvedStatus !== "ready" || !entry) {
      section.appendChild(createCompanionTextBlock(emptyText, {
        fontSize: "12px",
        color: "rgba(255,255,255,0.68)",
        lineHeight: "1.4",
      }));
      return section;
    }

    const titleRow = createCompanionTextBlock(entry.itemName || "Unknown item", {
      fontSize: "14px",
      fontWeight: "700",
      lineHeight: "1.35",
      marginBottom: "4px",
    });

    const metaParts = [];
    const displayCountry = countryOverride || entry.country || null;
    if (showCountryMeta && displayCountry) metaParts.push(displayCountry);
    if (showCategoryMeta && (entry.category || entry.shopCategory)) metaParts.push(entry.category || entry.shopCategory);
    if (metaParts.length) {
      section.appendChild(titleRow);
      section.appendChild(createCompanionTextBlock(metaParts.join(" · "), {
        fontSize: "11px",
        color: "rgba(255,255,255,0.66)",
        lineHeight: "1.35",
        marginBottom: "8px",
      }));
    } else {
      titleRow.style.marginBottom = "8px";
      section.appendChild(titleRow);
    }

    const statsGrid = document.createElement("div");
    statsGrid.style.display = "grid";
    statsGrid.style.gridTemplateColumns = "repeat(2, minmax(0, 1fr))";
    statsGrid.style.gap = "8px 10px";
    appendCompanionStatsGrid(statsGrid, entry, {
      showBuyPrice,
      showRunCost,
      hideMissingStock,
    });
    section.appendChild(statsGrid);

    if (showArrivalStockNote && shouldShowCompanionArrivalStockNote(entry)) {
      section.appendChild(createCompanionTextBlock("Currently out of stock; expected in stock on arrival.", {
        marginTop: "8px",
        fontSize: "11px",
        color: "rgba(255,255,255,0.62)",
        lineHeight: "1.35",
      }));
    }

    const sourceText = getCompanionSourceFreshnessText(entry);
    if (sourceText) {
      section.appendChild(createCompanionTextBlock(sourceText, {
        marginTop: "8px",
        fontSize: "11px",
        color: "rgba(255,255,255,0.58)",
        lineHeight: "1.35",
      }));
    }

    return section;
  }

  function buildCompanionCountryResultSection({
    status,
    entry,
    entries,
    country,
    emptyText,
    showRunCost = false,
    resultsMode = "best",
    showArrivalStockNote = false,
  }) {
    if (resultsMode === "top3") {
      return buildCompanionResultListSection({
        title: "For This Country",
        status,
        entries,
        emptyText,
        showCountryMeta: false,
        showCategoryMeta: false,
        countryOverride: country,
        showBuyPrice: true,
        showRunCost,
        hideMissingStock: true,
        treatUnavailableAsEmpty: true,
        showArrivalStockNote,
        loadingText: "Checking this country...",
      });
    }

    return buildCompanionResultSection({
      title: "For This Country",
      status,
      entry,
      emptyText,
      showCountryMeta: true,
      showCategoryMeta: false,
      countryOverride: country,
      showBuyPrice: true,
      showRunCost,
      hideMissingStock: true,
      treatUnavailableAsEmpty: true,
      showArrivalStockNote,
      loadingText: "Checking this country...",
    });
  }

  function buildStandaloneCountryHelperSection({ status, entry, country, emptyText, showRunCost = false }) {
    return buildCompanionResultSection({
      title: "Best Buy Right Now",
      status,
      entry,
      emptyText,
      showCountryMeta: true,
      showCategoryMeta: false,
      countryOverride: country,
      showBuyPrice: true,
      showRunCost,
      hideMissingStock: true,
      loadingText: "Checking this country...",
    });
  }

  function renderTravelPlannerPanelContent(settings) {
    const generalResultsCount = getTravelPlannerGeneralResultsCount(settings);

    if (generalResultsCount === "top3") {
      companionPanelContentEl.appendChild(buildCompanionResultListSection({
        title: "Top Runs Right Now",
        status: companionPanelState.global.status === "hidden" ? "loading" : companionPanelState.global.status,
        entries: companionPanelState.global.runs,
        emptyText: getTravelPlannerEmptyMessage(
          companionPanelState.global.emptyReason,
          companionPanelState.global.emptyStateGuidance
        ),
        showCountryMeta: true,
        showRunCost: settings.showRunCost,
        showArrivalStockNote: true,
        loadingText: "Loading general results...",
      }));
    } else {
      companionPanelContentEl.appendChild(buildCompanionResultSection({
        title: "Best Run Right Now",
        status: companionPanelState.global.status === "hidden" ? "loading" : companionPanelState.global.status,
        entry: companionPanelState.global.payload,
        emptyText: getTravelPlannerEmptyMessage(
          companionPanelState.global.emptyReason,
          companionPanelState.global.emptyStateGuidance
        ),
        showCountryMeta: true,
        showRunCost: settings.showRunCost,
        showArrivalStockNote: true,
        loadingText: "Loading general result...",
      }));
    }

    const categoryGroups = Array.isArray(companionPanelState.categoryGroups) ? companionPanelState.categoryGroups : [];
    if (categoryGroups.length) {
      const visibleGroups = categoryGroups.filter((group) => {
        if (group?.status === "ready") return Array.isArray(group.runs) && group.runs.length > 0;
        if (group?.status === "empty") return Boolean(group?.emptyStateGuidance);
        return group?.status === "unavailable";
      });
      const hasPendingCategoryGroups = categoryGroups.some((group) => group?.status === "queued" || group?.status === "loading");
      const generalHasContent = companionPanelState.global.status === "ready"
        && (generalResultsCount === "top3"
          ? Array.isArray(companionPanelState.global.runs) && companionPanelState.global.runs.length > 0
          : Boolean(companionPanelState.global.payload));
      const selectedHasContent = companionPanelState.selected.status === "ready"
        && (generalResultsCount === "top3"
          ? Array.isArray(companionPanelState.selected.runs) && companionPanelState.selected.runs.length > 0
          : Boolean(companionPanelState.selected.payload));

      if (hasPendingCategoryGroups && !visibleGroups.length && !generalHasContent && !selectedHasContent) {
        companionPanelContentEl.appendChild(buildCompanionResultListSection({
          title: "Selected Categories",
          status: "loading",
          entries: [],
          emptyText: getTravelPlannerCategoryGroupsEmptyMessage(categoryGroups),
          showCountryMeta: true,
          showRunCost: settings.showRunCost,
          showArrivalStockNote: true,
          loadingText: "Checking selected categories...",
        }));
      } else if (!visibleGroups.length && !hasPendingCategoryGroups && !generalHasContent) {
        companionPanelContentEl.appendChild(buildCompanionResultListSection({
          title: "Selected Categories",
          status: "empty",
          entries: [],
          emptyText: getTravelPlannerCategoryGroupsEmptyMessage(categoryGroups),
          showCountryMeta: true,
          showRunCost: settings.showRunCost,
          showArrivalStockNote: true,
        }));
      }

      for (const group of visibleGroups) {
        companionPanelContentEl.appendChild(buildCompanionResultListSection({
          title: group.label,
          status: group.status,
          entries: group.runs,
          emptyText: getTravelPlannerEmptyMessage(group.emptyReason, group.emptyStateGuidance),
          showCountryMeta: true,
          showCategoryMeta: false,
          showRunCost: settings.showRunCost,
          showArrivalStockNote: true,
        }));
      }
    }

    if (companionPanelState.selected.status !== "hidden" && companionPanelState.selected.country) {
      companionPanelContentEl.appendChild(buildCompanionCountryResultSection({
        status: companionPanelState.selected.status,
        entry: companionPanelState.selected.payload,
        entries: companionPanelState.selected.runs,
        country: companionPanelState.selected.country,
        emptyText: getTravelPlannerEmptyMessage(
          companionPanelState.selected.emptyReason,
          companionPanelState.selected.emptyStateGuidance
        ),
        showRunCost: settings.showRunCost,
        resultsMode: generalResultsCount,
        showArrivalStockNote: true,
      }));
    }

    logSelectedCountryCardState({
      rendered: companionPanelState.selected.status !== "hidden" && Boolean(companionPanelState.selected.country),
      country: companionPanelState.selected.country,
      status: companionPanelState.selected.status,
      emptyReason: companionPanelState.selected.emptyReason,
    });
  }

  function renderCountryHelperPanelContent(settings) {
    companionPanelContentEl.appendChild(buildStandaloneCountryHelperSection({
      status: companionPanelState.countryHelper.status,
      entry: companionPanelState.countryHelper.payload,
      country: companionPanelState.countryHelper.country,
      emptyText: getCountryHelperEmptyMessage(
        companionPanelState.countryHelper.country || "this country",
        companionPanelState.countryHelper.emptyReason
      ),
      showRunCost: settings.showRunCost,
    }));
  }

  function renderCompanionPanel() {
    if (!companionPanelContentEl) return;

    clearCompanionGuidanceTimer();
    const settings = getSettings();
    applyCompanionPanelChrome(companionPanelState.context);
    companionPanelContentEl.textContent = "";
    if (companionPanelState.context.mode === "country-helper") {
      renderCountryHelperPanelContent(settings);
      return;
    }
    if (companionPanelState.context.mode === "planner") {
      renderTravelPlannerPanelContent(settings);
      scheduleCompanionGuidanceRefresh();
    }
  }

  function clearCompanionGuidanceTimer() {
    if (!companionGuidanceTimer) return;
    clearTimeout(companionGuidanceTimer);
    companionGuidanceTimer = null;
  }

  function getActiveTravelPlannerGuidances() {
    if (companionPanelState.context.mode !== "planner") return [];

    const guidances = [];
    const globalGuidance = companionPanelState.global?.emptyStateGuidance || null;
    if (globalGuidance?.kind === "next_run") guidances.push(globalGuidance);

    for (const group of (Array.isArray(companionPanelState.categoryGroups) ? companionPanelState.categoryGroups : [])) {
      const guidance = group?.emptyStateGuidance || null;
      if (guidance?.kind === "next_run") guidances.push(guidance);
    }

    return guidances;
  }

  function scheduleCompanionGuidanceRefresh() {
    clearCompanionGuidanceTimer();

    const guidances = getActiveTravelPlannerGuidances();
    if (!guidances.length) return;

    const nowMs = Date.now();
    const hasExpiredDeparture = guidances.some((guidance) => {
      const departureAtMs = guidance?.departureAt ? new Date(guidance.departureAt).getTime() : NaN;
      return Number.isFinite(departureAtMs) && departureAtMs <= nowMs;
    });

    if (hasExpiredDeparture) {
      clearCompanionResponseCache();
      invalidateCompanionPanelSignature();
      scheduleCompanionStateCheck(0);
      return;
    }

    const minuteBoundaryDelay = Math.max(1000, Math.min(60000, (60000 - (nowMs % 60000)) + 250));
    const nextDepartureDelay = guidances
      .map((guidance) => guidance?.departureAt ? new Date(guidance.departureAt).getTime() : NaN)
      .filter((value) => Number.isFinite(value) && value > nowMs)
      .map((value) => Math.max(1000, value - nowMs + 1000))
      .sort((a, b) => a - b)[0] || null;
    const delayMs = nextDepartureDelay === null ? minuteBoundaryDelay : Math.min(minuteBoundaryDelay, nextDepartureDelay);

    companionGuidanceTimer = setTimeout(() => {
      companionGuidanceTimer = null;
      if (companionPanelState.context.mode !== "planner") return;
      renderCompanionPanel();
    }, delayMs);
  }

  function buildCompanionRequestSettings(settings) {
    return {
      sellWhere: settings.profit.sellWhere,
      applyTax: settings.profit.applyTax,
      flightType: settings.profit.flightType,
      capacity: settings.profit.capacity,
    };
  }

  function buildTravelPlannerQueryBody(settings, {
    limit = 1,
    countries = null,
    categories = null,
  } = {}) {
    const normalizedCountries = Array.isArray(countries)
      ? normalizeStringArray(countries)
      : normalizeStringArray(settings.filters.countries);
    const normalizedCategories = Array.isArray(categories)
      ? normalizeStringArray(categories).map((value) => value.toLowerCase())
      : normalizeStringArray(settings.filters.categories).map((value) => value.toLowerCase());

    return {
      settings: buildCompanionRequestSettings(settings),
      filters: {
        roundTripHours: settings.filters.roundTripHours,
        countries: normalizedCountries,
        categories: normalizedCategories,
        itemNames: [...settings.filters.itemNames],
      },
      limit: normalizeInteger(limit, 1, { min: 1, max: 25 }),
    };
  }

  function buildCountryHelperQueryBody(settings, country, { limit = 1 } = {}) {
    return {
      country,
      settings: buildCompanionRequestSettings(settings),
      filters: {
        categories: [...settings.filters.categories],
        itemNames: [...settings.filters.itemNames],
      },
      limit: normalizeInteger(limit, 1, { min: 1, max: 25 }),
    };
  }

  function parseCompanionResponseText(text) {
    try {
      return JSON.parse(String(text || ""));
    } catch {
      return null;
    }
  }

  function buildCompanionRequestHeaders(extraHeaders = {}) {
    return {
      "X-DroqsDB-Client": "userscript-companion",
      "X-DroqsDB-Version": SCRIPT_VERSION,
      ...extraHeaders,
    };
  }

  async function getCompanionJson(url) {
    const headers = buildCompanionRequestHeaders();

    if (typeof GM_xmlhttpRequest === "function") {
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "GET",
          url,
          headers,
          timeout: 20000,
          onload: (res) => {
            const parsed = parseCompanionResponseText(res.responseText);
            if (res.status >= 200 && res.status < 300 && parsed) {
              resolve(parsed);
              return;
            }
            reject(new Error(parsed?.message || `HTTP ${res.status}`));
          },
          onerror: () => reject(new Error("Network error")),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    const res = await fetch(url, {
      method: "GET",
      headers,
      mode: "cors",
      credentials: "omit",
    });
    const parsed = parseCompanionResponseText(await res.text());
    if (!res.ok || !parsed) {
      throw new Error(parsed?.message || `HTTP ${res.status}`);
    }
    return parsed;
  }

  async function postCompanionJson(url, body) {
    const payload = JSON.stringify(body);
    const headers = buildCompanionRequestHeaders({
      "Content-Type": "application/json",
    });

    if (typeof GM_xmlhttpRequest === "function") {
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers,
          data: payload,
          timeout: 20000,
          onload: (res) => {
            const parsed = parseCompanionResponseText(res.responseText);
            if (res.status >= 200 && res.status < 300 && parsed) {
              resolve(parsed);
              return;
            }
            reject(new Error(parsed?.message || `HTTP ${res.status}`));
          },
          onerror: () => reject(new Error("Network error")),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: payload,
      mode: "cors",
      credentials: "omit",
    });
    const parsed = parseCompanionResponseText(await res.text());
    if (!res.ok || !parsed) {
      throw new Error(parsed?.message || `HTTP ${res.status}`);
    }
    return parsed;
  }

  function buildCompanionResponseCacheKey(url, body) {
    return `${String(url || "")}::${JSON.stringify(body || null)}`;
  }

  function clearCompanionResponseCache() {
    companionResponseCache.clear();
  }

  function pruneCompanionResponseCache(now = Date.now()) {
    for (const [key, entry] of companionResponseCache.entries()) {
      if (!entry) {
        companionResponseCache.delete(key);
        continue;
      }
      if (entry.promise) continue;
      if (Number(entry.expiresAt) > now) continue;
      companionResponseCache.delete(key);
    }
  }

  async function postCompanionJsonCached(url, body, { ttlMs = COMPANION_RESPONSE_CACHE_TTL_MS } = {}) {
    const cacheKey = buildCompanionResponseCacheKey(url, body);
    const now = Date.now();
    const normalizedTtlMs = normalizeInteger(ttlMs, COMPANION_RESPONSE_CACHE_TTL_MS, { min: 1000, max: 60000 });
    pruneCompanionResponseCache(now);

    const cachedEntry = companionResponseCache.get(cacheKey);
    if (cachedEntry?.promise) {
      return cachedEntry.promise;
    }
    if (cachedEntry?.payload && Number(cachedEntry.expiresAt) > now) {
      return cachedEntry.payload;
    }

    const requestPromise = postCompanionJson(url, body)
      .then((payload) => {
        companionResponseCache.set(cacheKey, {
          payload,
          expiresAt: Date.now() + normalizedTtlMs,
        });
        return payload;
      })
      .catch((error) => {
        companionResponseCache.delete(cacheKey);
        throw error;
      });

    companionResponseCache.set(cacheKey, {
      promise: requestPromise,
      expiresAt: 0,
      payload: null,
    });

    return requestPromise;
  }

  async function safePostCompanionJson(url, body, options) {
    try {
      return await postCompanionJsonCached(url, body, options);
    } catch {
      return null;
    }
  }

  function createTravelPlannerCategoryGroupState(group, status = "queued") {
    return {
      key: group?.value || null,
      label: group?.label || "Category",
      status,
      payload: null,
      runs: [],
      emptyReason: null,
      emptyStateGuidance: null,
    };
  }

  function applyTravelPlannerPayload(payload, target = companionPanelState.global) {
    if (!payload || payload.ok !== true) {
      target.status = "unavailable";
      target.payload = null;
      target.runs = [];
      target.emptyReason = null;
      target.emptyStateGuidance = null;
      return;
    }

    const runs = (Array.isArray(payload.runs) ? payload.runs : []).filter(Boolean);
    if (!runs.length && payload.bestRun) runs.push(payload.bestRun);

    target.payload = runs[0] || payload.bestRun || null;
    target.runs = runs;
    target.emptyReason = String(payload.emptyReason || "").trim() || null;
    target.emptyStateGuidance = normalizeTravelPlannerEmptyStateGuidance(payload.emptyStateGuidance);
    target.status = target.payload ? "ready" : "empty";
    if (target.status === "ready") target.emptyStateGuidance = null;
  }

  function applyCountryHelperPayload(country, payload, target = companionPanelState.selected) {
    target.country = country;
    if (!payload || payload.ok !== true) {
      target.status = "unavailable";
      target.payload = null;
      target.runs = [];
      target.emptyReason = null;
      return;
    }

    const runs = (Array.isArray(payload.items) ? payload.items : []).filter(Boolean);
    if (!runs.length && payload.bestItem) runs.push(payload.bestItem);

    target.payload = runs[0] || payload.bestItem || null;
    target.runs = runs;
    target.emptyReason = String(payload.emptyReason || "").trim() || null;
    target.status = target.payload ? "ready" : "empty";
  }

  function getVisibleTravelPageText() {
    return norm(document.body?.innerText || document.body?.textContent || "");
  }

  function clearCompanionDebugSignatures() {
    for (const key of Object.keys(companionDebugSignatures)) {
      companionDebugSignatures[key] = null;
    }
  }

  function logCompanionDebug(channel, label, payload) {
    if (!DEBUG) return;
    const signature = JSON.stringify(payload);
    if (companionDebugSignatures[channel] === signature) return;
    companionDebugSignatures[channel] = signature;
    console.debug(`[DroqsDB] ${label}`, payload);
  }

  function logTravelPlannerDetection(snapshot) {
    if (!isTravelPage()) {
      clearCompanionDebugSignatures();
      return;
    }

    const payload = {
      eligible: snapshot?.eligible === true,
      inFlight: snapshot?.inFlight === true,
      travelAgency: snapshot?.travelAgency === true,
      selectedCountry: snapshot?.selectedCountry || null,
      detectedSelectedCountry: snapshot?.detectedSelectedCountry || null,
      stickySelectedCountry: snapshot?.stickySelectedCountry || null,
      countryOptionCount: Number(snapshot?.countryOptionCount || 0),
    };
    logCompanionDebug("planner", "Travel Planner detection", payload);
  }

  function logCountryHelperDetection(snapshot) {
    if (!isTravelPage()) {
      clearCompanionDebugSignatures();
      return;
    }

    logCompanionDebug("helper", "Country Helper detection", {
      eligible: snapshot?.eligible === true,
      inFlight: snapshot?.inFlight === true,
      shopPage: snapshot?.shopPage === true,
      country: snapshot?.country || null,
    });
  }

  function logSelectedCountryTransition(previousCountry, nextCountry, reason) {
    if (!DEBUG) return;
    console.debug("[DroqsDB] Selected country transition", {
      from: previousCountry || null,
      to: nextCountry || null,
      reason: reason || "unknown",
    });
  }

  function logSelectedCountryCardState(snapshot) {
    logCompanionDebug("selectedCountryCard", "Selected country card", {
      rendered: snapshot?.rendered === true,
      country: snapshot?.country || null,
      status: snapshot?.status || "hidden",
      emptyReason: snapshot?.emptyReason || null,
    });
  }

  function getTravelPageCountryFromBanner(text) {
    const match = String(text || "").match(/You are in\s+([A-Za-z ]+?)\s+and have\b/i);
    if (!match) return null;
    const candidate = norm(match[1]);
    return KNOWN_COUNTRIES.has(candidate) ? candidate : null;
  }

  function findCountriesInText(text) {
    const normalized = norm(text);
    return KNOWN_COUNTRY_NAMES.filter((country) => {
      const re = new RegExp(`\\b${escapeRegExp(country)}\\b`, "i");
      return re.test(normalized);
    });
  }

  function hasTravelAgencyHeading() {
    if (/\btravel agency\b/i.test(norm(document.title))) return true;

    return Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span,strong,b"))
      .some((el) => !isDroqsdbUiNode(el) && isVisible(el) && /\btravel agency\b/i.test(getElementText(el)));
  }

  function hasTravelDestinationPrompt(text = getVisibleTravelPageText()) {
    if (!text) return false;
    return /\b(?:please\s+choose\s+(?:a\s+)?destination|choose\s+(?:a\s+)?destination|choose\s+destination|select\s+(?:a\s+)?destination|pick\s+(?:a\s+)?destination|where\s+would\s+you\s+like\s+to\s+(?:travel|fly)|choose\s+where\s+to\s+fly)\b/i.test(text);
  }

  function hasTravelDepartureCtaContext(text = getVisibleTravelPageText()) {
    const actionButtons = collectVisibleTravelActionButtons();
    if (!actionButtons.length) return false;
    if (!text) return true;
    return /\b(?:travel agency|destination|depart|departure|book|confirm|continue|choose)\b/i.test(text);
  }

  function hasInFlightDomSignals() {
    return Boolean(document.querySelector(
      '[class*="flightProgress"], [class*="flight-progress"], [class*="timeRemaining"], [class*="time-remaining"]'
    ));
  }

  function isLikelyInFlight(text = getVisibleTravelPageText()) {
    if (!text) return hasInFlightDomSignals();
    if (/\b(?:travelling|traveling|flying)\s+(?:to|from|back to|towards)\b/i.test(text)) return true;
    if (/\b(?:in flight|time remaining|arriving in|landing in|returning to torn)\b/i.test(text)) return true;
    return hasInFlightDomSignals();
  }

  function isTravelAgencySelectionState(text = getVisibleTravelPageText(), {
    countryOptionCount = collectVisibleCountryLabelNodes().length,
    selectedCountry = null,
  } = {}) {
    if (!text && countryOptionCount < 2 && !selectedCountry) return false;
    const hasHeading = hasTravelAgencyHeading();
    const hasPrompt = hasTravelDestinationPrompt(text);
    const hasCountryOptions = countryOptionCount >= 2;
    const hasDepartureCta = hasTravelDepartureCtaContext(text);
    return hasHeading || hasPrompt || hasCountryOptions || Boolean(selectedCountry) || (countryOptionCount >= 1 && hasDepartureCta);
  }

  function getCountryDetectionTexts(el) {
    if (!el || el.nodeType !== 1) return [];

    const texts = [
      getElementText(el),
      norm(el.getAttribute("aria-label") || ""),
      norm(el.getAttribute("title") || ""),
      norm(el.getAttribute("value") || ""),
      norm(el.getAttribute("data-country") || ""),
      norm(el.getAttribute("data-destination") || ""),
      norm(el.getAttribute("data-location") || ""),
      norm(el.getAttribute("alt") || ""),
    ];

    const seen = new Set();
    return texts.filter((text) => {
      if (!text || seen.has(text)) return false;
      seen.add(text);
      return true;
    });
  }

  function getCountryCandidateFromElement(el) {
    if (!el || el.nodeType !== 1) return null;

    const tagName = String(el.tagName || "").toLowerCase();
    const role = String(el.getAttribute("role") || "").toLowerCase();
    const isInteractive = ["button", "a", "label", "input", "option"].includes(tagName) ||
      ["button", "tab", "option", "radio", "checkbox", "link"].includes(role);
    const texts = getCountryDetectionTexts(el);

    for (const text of texts) {
      const exactCountry = KNOWN_COUNTRY_NAMES.find((country) => text === country);
      if (exactCountry) {
        return {
          country: exactCountry,
          score: 120,
          text,
        };
      }
    }

    for (const text of texts) {
      if (text.length > 180) continue;
      const countries = findCountriesInText(text);
      if (countries.length !== 1) continue;
      const country = countries[0];
      const hasSelectionContext = /\b(?:destination|travel(?:ing|ling)?\s+to|fly(?:ing)?\s+to|depart(?:ure)?\s+to|headed\s+to|going\s+to|selected|route)\b/i.test(text);
      const compactText = text.length <= Math.max(country.length + 48, 96);
      if (!hasSelectionContext && !isInteractive && !compactText && !hasSelectedStateSignals(el)) continue;
      return {
        country,
        score: hasSelectionContext ? 90 : compactText ? 80 : 70,
        text,
      };
    }

    return null;
  }

  function collectVisibleCountryLabelNodes() {
    const candidates = [];
    const nodes = Array.from(document.querySelectorAll(
      'button,a,label,span,div,strong,b,h1,h2,h3,h4,h5,h6,li,p,input,[role="button"],[role="tab"],[role="option"],[role="radio"],[role="checkbox"]'
    ));

    for (const el of nodes) {
      if (isDroqsdbUiNode(el)) continue;
      if (!isVisible(el)) continue;
      const match = getCountryCandidateFromElement(el);
      if (!match) continue;
      candidates.push({
        el,
        country: match.country,
        score: match.score,
      });
    }

    return candidates.filter((candidate, index) => !candidates.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        other.country === candidate.country &&
        other.el.contains(candidate.el)
    ));
  }

  function hasSelectedStateSignals(el) {
    if (!el || el.nodeType !== 1) return false;
    if (["aria-selected", "aria-pressed", "data-selected", "data-active"].some((name) => String(el.getAttribute(name) || "").toLowerCase() === "true")) {
      return true;
    }

    const dataState = String(el.getAttribute("data-state") || "").toLowerCase();
    if (dataState === "active" || dataState === "selected" || dataState === "open") return true;

    const ariaCurrent = String(el.getAttribute("aria-current") || "").toLowerCase();
    if (ariaCurrent && ariaCurrent !== "false") return true;

    const tokenText = [
      typeof el.className === "string" ? el.className : "",
      el.id || "",
      dataState,
      String(el.getAttribute("data-status") || ""),
    ].join(" ").toLowerCase();

    return /(^|[^a-z])(selected|active|current)([^a-z]|$)/.test(tokenText);
  }

  function collectVisibleTravelActionButtons() {
    const buttons = [];
    const nodes = Array.from(document.querySelectorAll(
      'button,a,input[type="button"],input[type="submit"],[role="button"]'
    ));

    for (const el of nodes) {
      if (isDroqsdbUiNode(el)) continue;
      if (!isVisible(el)) continue;
      const text = norm(el.value || el.innerText || el.textContent || "");
      if (!/\b(?:travel|fly|depart|book|confirm|continue)\b/i.test(text)) continue;
      buttons.push(el);
    }

    return buttons;
  }

  function pickBestCountryFromScores(scored) {
    if (!Array.isArray(scored) || !scored.length) return null;

    const totals = new Map();
    for (const entry of scored) {
      if (!entry?.country || !Number.isFinite(entry.score)) continue;
      const previous = totals.get(entry.country) || 0;
      totals.set(entry.country, Math.max(previous, entry.score));
    }

    const ranked = Array.from(totals.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!ranked.length) return null;
    if (ranked[1] && ranked[1][1] === ranked[0][1] && ranked[1][0] !== ranked[0][0]) return null;
    return ranked[0][0];
  }

  function scoreCountryFromNodeContext(node, baseScore = 80, maxDepth = 4) {
    const scored = [];
    let current = node;
    let depth = 0;

    while (current && depth <= maxDepth) {
      if (!isDroqsdbUiNode(current)) {
        const match = getCountryCandidateFromElement(current);
        if (match) {
          scored.push({
            country: match.country,
            score: Math.max(1, baseScore + match.score - (depth * 12)),
          });
        }
      }
      current = current.parentElement;
      depth += 1;
    }

    return pickBestCountryFromScores(scored);
  }

  function getSelectedDestinationFromCheckedInputs() {
    const scored = [];
    const nodes = Array.from(document.querySelectorAll(
      'input[type="radio"]:checked,input[type="checkbox"]:checked,option:checked,[aria-checked="true"],[role="radio"][aria-checked="true"],[role="tab"][aria-selected="true"],[role="option"][aria-selected="true"]'
    ));

    for (const el of nodes) {
      if (isDroqsdbUiNode(el)) continue;

      const contextCountry = scoreCountryFromNodeContext(el, 70, 4);
      if (contextCountry) {
        scored.push({ country: contextCountry, score: 70 });
      }

      const elementId = String(el.getAttribute("id") || "").trim();
      if (!elementId) continue;
      const labelSelector = typeof CSS === "object" && CSS && typeof CSS.escape === "function"
        ? `label[for="${CSS.escape(elementId)}"]`
        : null;
      if (!labelSelector) continue;

      for (const label of Array.from(document.querySelectorAll(labelSelector))) {
        if (isDroqsdbUiNode(label) || !isVisible(label)) continue;
        const labelCountry = scoreCountryFromNodeContext(label, 90, 2);
        if (!labelCountry) continue;
        scored.push({ country: labelCountry, score: 90 });
      }
    }

    return pickBestCountryFromScores(scored);
  }

  function getSelectedDestinationFromMarkers(candidates = collectVisibleCountryLabelNodes()) {
    const scored = [];

    for (const candidate of candidates) {
      let score = 0;
      let node = candidate.el;
      let depth = 0;

      while (node && depth < 4) {
        if (hasSelectedStateSignals(node)) {
          score = Math.max(score, 60 - (depth * 10));
        }
        node = node.parentElement;
        depth += 1;
      }

      if (score > 0) scored.push({ country: candidate.country, score });
    }

    if (!scored.length) return null;
    scored.sort((a, b) => b.score - a.score || a.country.localeCompare(b.country));
    if (scored[1] && scored[1].score === scored[0].score && scored[1].country !== scored[0].country) return null;
    return scored[0].country;
  }

  function getSelectedDestinationFromActionContext() {
    const actionButtons = collectVisibleTravelActionButtons();
    const scored = [];

    for (const button of actionButtons) {
      let node = button;
      let depth = 0;

      while (node && depth < 6) {
        for (const text of getCountryDetectionTexts(node)) {
          if (!text || text.length > 240) continue;
          const countries = findCountriesInText(text);
          if (countries.length !== 1) continue;
          scored.push({
            country: countries[0],
            score: Math.max(1, 70 - (depth * 10)),
          });
        }
        node = node.parentElement;
        depth += 1;
      }
    }

    return pickBestCountryFromScores(scored);
  }

  function getSelectedDestinationFromSummaryContext() {
    const scored = [];
    const nodes = Array.from(document.querySelectorAll("button,a,label,span,div,p,strong,b,h1,h2,h3,h4,h5,h6,li"));

    for (const el of nodes) {
      if (isDroqsdbUiNode(el)) continue;
      if (!isVisible(el)) continue;

      for (const text of getCountryDetectionTexts(el)) {
        if (!text || text.length > 180) continue;
        if (!/\b(?:destination|travel(?:ing|ling)?\s+to|fly(?:ing)?\s+to|depart(?:ure)?\s+to|headed\s+to|going\s+to|selected)\b/i.test(text)) {
          continue;
        }
        const countries = findCountriesInText(text);
        if (countries.length !== 1) continue;
        scored.push({
          country: countries[0],
          score: 85,
        });
      }
    }

    return pickBestCountryFromScores(scored);
  }

  function getSelectedTravelDestinationCountry(candidates = collectVisibleCountryLabelNodes()) {
    return getSelectedDestinationFromCheckedInputs() ||
      getSelectedDestinationFromMarkers(candidates) ||
      getSelectedDestinationFromActionContext() ||
      getSelectedDestinationFromSummaryContext() ||
      null;
  }

  function setTravelPlannerSelectedCountry(country, reason = "selection-confirmed") {
    const nextCountry = KNOWN_COUNTRIES.has(String(country || "").trim()) ? String(country).trim() : null;
    if (!nextCountry) return null;

    const previousCountry = travelPlannerSelectionState.country || null;
    travelPlannerSelectionState.country = nextCountry;
    travelPlannerSelectionState.clearRequestedAt = 0;
    if (previousCountry !== nextCountry) {
      logSelectedCountryTransition(previousCountry, nextCountry, reason);
    }
    return nextCountry;
  }

  function resetTravelPlannerSelectedCountry(reason = "selection-cleared") {
    const previousCountry = travelPlannerSelectionState.country || null;
    travelPlannerSelectionState.country = null;
    travelPlannerSelectionState.clearRequestedAt = 0;
    travelPlannerSelectionState.lastEligibleAt = 0;
    if (previousCountry) {
      logSelectedCountryTransition(previousCountry, null, reason);
    }
  }

  function resolveTravelPlannerSelectedCountry({
    pageText,
    travelAgency,
    shopPage,
    inFlight,
    detectedSelectedCountry,
    countryOptionCount,
  }) {
    if (!isTravelPage()) {
      resetTravelPlannerSelectedCountry("left-travel-page");
      return null;
    }

    if (shopPage) {
      resetTravelPlannerSelectedCountry("entered-shop-page");
      return null;
    }

    if (inFlight) {
      resetTravelPlannerSelectedCountry("entered-in-flight-state");
      return null;
    }

    if (travelAgency) {
      travelPlannerSelectionState.lastEligibleAt = Date.now();
    }

    if (detectedSelectedCountry) {
      travelPlannerSelectionState.lastEligibleAt = Date.now();
      return setTravelPlannerSelectedCountry(detectedSelectedCountry);
    }

    const stickyCountry = travelPlannerSelectionState.country || null;
    if (!stickyCountry) {
      travelPlannerSelectionState.clearRequestedAt = 0;
      return null;
    }

    if (!travelAgency) {
      if (
        travelPlannerSelectionState.lastEligibleAt > 0 &&
        (Date.now() - travelPlannerSelectionState.lastEligibleAt) <= TRAVEL_PLANNER_LAYOUT_GRACE_MS
      ) {
        return stickyCountry;
      }
      resetTravelPlannerSelectedCountry("left-eligible-travel-selection-state");
      return null;
    }

    const clearlyDeselected = hasTravelDestinationPrompt(pageText) && countryOptionCount >= 2;
    if (!clearlyDeselected) {
      travelPlannerSelectionState.clearRequestedAt = 0;
      return stickyCountry;
    }

    if (!travelPlannerSelectionState.clearRequestedAt) {
      travelPlannerSelectionState.clearRequestedAt = Date.now();
      return stickyCountry;
    }

    if ((Date.now() - travelPlannerSelectionState.clearRequestedAt) < TRAVEL_SELECTION_CLEAR_GRACE_MS) {
      return stickyCountry;
    }

    resetTravelPlannerSelectedCountry("destination-clearly-deselected");
    return null;
  }

  function getTravelPlannerPageContext(settings = getSettings()) {
    const context = {
      eligible: false,
      mode: "planner",
      selectedCountry: null,
      country: null,
    };

    if (!isTravelPage()) {
      clearCompanionDebugSignatures();
      resetTravelPlannerSelectedCountry("left-travel-page");
      return context;
    }

    const pageText = getVisibleTravelPageText();
    const travelPlannerEnabled = shouldEnableTravelPlanner(settings);
    const shopPage = Boolean(pageText) && (Boolean(getTravelPageCountryFromBanner(pageText)) || hasKnownShopHeaders());
    const inFlight = !shopPage && isLikelyInFlight(pageText);
    const countryLabelNodes = collectVisibleCountryLabelNodes();
    const detectedSelectedCountry = !shopPage && !inFlight
      ? getSelectedTravelDestinationCountry(countryLabelNodes)
      : null;
    const travelAgency = !shopPage && !inFlight && isTravelAgencySelectionState(pageText, {
      countryOptionCount: countryLabelNodes.length,
      selectedCountry: detectedSelectedCountry,
    });
    const selectedCountry = resolveTravelPlannerSelectedCountry({
      pageText,
      travelAgency,
      shopPage,
      inFlight,
      detectedSelectedCountry,
      countryOptionCount: countryLabelNodes.length,
    });
    const recentlyEligible = travelPlannerSelectionState.lastEligibleAt > 0 &&
      (Date.now() - travelPlannerSelectionState.lastEligibleAt) <= TRAVEL_PLANNER_LAYOUT_GRACE_MS;

    context.eligible = travelPlannerEnabled && !shopPage && !inFlight && (
      travelAgency ||
      recentlyEligible ||
      Boolean(selectedCountry)
    );
    context.selectedCountry = context.eligible ? selectedCountry : null;
    logTravelPlannerDetection({
      eligible: context.eligible,
      inFlight,
      travelAgency,
      selectedCountry: context.selectedCountry,
      detectedSelectedCountry,
      stickySelectedCountry: travelPlannerSelectionState.country,
      countryOptionCount: countryLabelNodes.length,
    });
    return context;
  }

  function getCountryHelperPageContext(settings = getSettings()) {
    const context = {
      eligible: false,
      mode: "country-helper",
      selectedCountry: null,
      country: null,
    };

    if (!isTravelPage()) return context;

    const pageText = getVisibleTravelPageText();
    const country = getCountryName();
    const shopPage = Boolean(country) && hasKnownShopHeaders();
    const inFlight = !shopPage && isLikelyInFlight(pageText);

    context.eligible = shouldEnableCountryHelper(settings) && shopPage && !inFlight;
    context.country = context.eligible ? country : null;
    logCountryHelperDetection({
      eligible: context.eligible,
      inFlight,
      shopPage,
      country: context.country || country,
    });
    return context;
  }

  function getCompanionPanelPageContext(settings = getSettings()) {
    const plannerContext = getTravelPlannerPageContext(settings);
    if (plannerContext.eligible) return plannerContext;

    const countryHelperContext = getCountryHelperPageContext(settings);
    if (countryHelperContext.eligible) return countryHelperContext;

    return {
      eligible: false,
      mode: "hidden",
      selectedCountry: null,
      country: null,
    };
  }

  function getTravelPlannerSettingsSignature(settings) {
    return [
      settings.profit.sellWhere,
      settings.profit.applyTax ? "1" : "0",
      settings.profit.flightType,
      String(settings.profit.capacity),
      settings.filters.roundTripHours === null ? "" : String(settings.filters.roundTripHours),
      settings.filters.countries.join(","),
      settings.filters.categories.join(","),
      settings.filters.itemNames.join(","),
      getTravelPlannerGeneralResultsCount(settings),
      TRAVEL_PLANNER_SPECIAL_CATEGORY_OPTIONS
        .map((option) => isTravelPlannerCategoryGroupEnabled(settings, option.value) ? option.value : "")
        .filter(Boolean)
        .join(","),
    ].join("|");
  }

  function getCountryHelperSettingsSignature(settings) {
    return [
      settings.profit.sellWhere,
      settings.profit.applyTax ? "1" : "0",
      settings.profit.flightType,
      String(settings.profit.capacity),
      settings.filters.categories.join(","),
      settings.filters.itemNames.join(","),
    ].join("|");
  }

  function getCompanionPanelSignature(context, settings) {
    if (context?.mode === "country-helper") {
      return [
        currentPageToken,
        context.mode,
        context.country || "",
        getCountryHelperSettingsSignature(settings),
      ].join("::");
    }

    return [
      currentPageToken,
      context?.mode || "planner",
      context?.selectedCountry || "",
      getTravelPlannerSettingsSignature(settings),
    ].join("::");
  }

  function clearCompanionStateTimer() {
    if (!companionStateTimer) return;
    clearTimeout(companionStateTimer);
    companionStateTimer = null;
  }

  function scheduleCompanionStateCheck(delayMs = COMPANION_STATE_DEBOUNCE_MS) {
    clearCompanionStateTimer();
    companionStateTimer = setTimeout(() => {
      companionStateTimer = null;
      refreshCompanionPanelForCurrentState();
    }, delayMs);
  }

  function resetCompanionResultState(target, { status = "hidden", country = null } = {}) {
    target.status = status;
    if (Object.prototype.hasOwnProperty.call(target, "country")) target.country = country;
    target.payload = null;
    target.runs = [];
    target.emptyReason = null;
    if (Object.prototype.hasOwnProperty.call(target, "emptyStateGuidance")) target.emptyStateGuidance = null;
  }

  function resetCompanionPanelState(context, settings) {
    companionPanelState.context = context;
    resetCompanionResultState(companionPanelState.global, { status: "idle" });
    resetCompanionResultState(companionPanelState.selected);
    resetCompanionResultState(companionPanelState.countryHelper);
    companionPanelState.categoryGroups = [];

    if (context.mode === "country-helper") {
      resetCompanionResultState(companionPanelState.countryHelper, {
        status: "loading",
        country: context.country,
      });
      return;
    }

    companionPanelState.global.status = "loading";
    companionPanelState.categoryGroups = getTravelPlannerCategoryGroupConfigs(settings)
      .map((group) => createTravelPlannerCategoryGroupState(group, "queued"));

    if (context.selectedCountry) {
      resetCompanionResultState(companionPanelState.selected, {
        status: "loading",
        country: context.selectedCountry,
      });
    }
  }

  function invalidateCompanionPanelSignature() {
    companionPanelState.signature = null;
    companionPanelState.requestToken += 1;
  }

  function isActiveCompanionPanelRequest(requestToken, signature) {
    return requestToken === companionPanelState.requestToken && companionPanelState.signature === signature;
  }

  async function refreshCompanionPanelForCurrentState() {
    const settings = getSettings();
    const context = getCompanionPanelPageContext(settings);
    companionPanelState.context = context;
    syncCompanionPanelVisibility(context);

    if (!context.eligible) {
      clearCompanionGuidanceTimer();
      companionPanelState.signature = null;
      return;
    }

    const signature = getCompanionPanelSignature(context, settings);
    if (signature === companionPanelState.signature) return;

    companionPanelState.signature = signature;
    companionPanelState.requestToken += 1;
    const requestToken = companionPanelState.requestToken;
    resetCompanionPanelState(context, settings);
    ensureCompanionPanel();
    renderCompanionPanel();

    if (context.mode === "country-helper") {
      const countryPayload = await safePostCompanionJson(
        COMPANION_COUNTRY_HELPER_API_URL,
        buildCountryHelperQueryBody(settings, context.country)
      );
      if (!isActiveCompanionPanelRequest(requestToken, signature)) return;
      applyCountryHelperPayload(context.country, countryPayload, companionPanelState.countryHelper);
      renderCompanionPanel();
      return;
    }

    const categoryGroups = getTravelPlannerCategoryGroupConfigs(settings);
    const requestedLimit = getTravelPlannerResultsLimit(settings);
    const globalPayload = await safePostCompanionJson(
      COMPANION_TRAVEL_PLANNER_API_URL,
      buildTravelPlannerQueryBody(settings, { limit: requestedLimit })
    );
    if (!isActiveCompanionPanelRequest(requestToken, signature)) return;

    applyTravelPlannerPayload(globalPayload);
    renderCompanionPanel();

    if (context.selectedCountry) {
      const selectedPayload = await safePostCompanionJson(
        COMPANION_TRAVEL_PLANNER_API_URL,
        buildTravelPlannerQueryBody(settings, {
          limit: requestedLimit,
          countries: [context.selectedCountry],
        })
      );
      if (!isActiveCompanionPanelRequest(requestToken, signature)) return;
      applyTravelPlannerPayload(selectedPayload, companionPanelState.selected);
      companionPanelState.selected.country = context.selectedCountry;
      renderCompanionPanel();
    } else {
      resetCompanionResultState(companionPanelState.selected);
    }

    if (!categoryGroups.length) return;

    companionPanelState.categoryGroups.forEach((group) => {
      if (group?.status === "queued") {
        group.status = "loading";
      }
    });
    renderCompanionPanel();

    const categoryTasks = categoryGroups.map((group, index) => (async () => {
      const categoryPayload = await safePostCompanionJson(
        COMPANION_TRAVEL_PLANNER_API_URL,
        buildTravelPlannerQueryBody(settings, {
          limit: requestedLimit,
          categories: [group.value],
        })
      );
      if (!isActiveCompanionPanelRequest(requestToken, signature)) return;
      applyTravelPlannerPayload(categoryPayload, companionPanelState.categoryGroups[index]);
      renderCompanionPanel();
    })());

    await Promise.all(categoryTasks);
  }

  function scheduleCompanionPanelRefreshAfterUpload(pageStateKey, country) {
    if (!country || !pageStateKey) return;
    if (getPageStateKey(country) !== pageStateKey) return;
    clearCompanionResponseCache();
    invalidateCompanionPanelSignature();
    scheduleCompanionStateCheck(0);
  }

  function installCompanionStateObserver() {
    if (companionStateObserver) return;

    companionStateObserver = new MutationObserver(() => {
      scheduleCompanionStateCheck();
    });
    companionStateObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener("click", () => {
      if (companionInteractionTimer) clearTimeout(companionInteractionTimer);
      companionInteractionTimer = setTimeout(() => {
        companionInteractionTimer = null;
        scheduleCompanionStateCheck(0);
      }, 0);
    }, true);
  }

  // ---------------- Utils ----------------
  function norm(s) {
    return String(s || "").replace(/\s+/g, " ").trim();
  }

  function getElementText(el) {
    return norm(el?.innerText || el?.textContent || "");
  }

  function toNameKey(name) {
    return norm(name).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "").toLowerCase();
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function parseScaledInteger(text, { requireCurrency = false, allowCurrency = true } = {}) {
    const t = norm(text).replace(/\u00A0/g, " ");
    if (!t) return null;
    if (!allowCurrency && t.includes("$")) return null;

    const m = requireCurrency
      ? t.match(/\$\s*([0-9][0-9,\s]*(?:\.[0-9]+)?)(?:\s*([kKmMbB]))?/)
      : t.match(/(?:^|[^A-Za-z0-9])([0-9][0-9,\s]*(?:\.[0-9]+)?)(?:\s*([kKmMbB]))?(?=$|[^A-Za-z0-9])/);
    if (!m) return null;

    let n = Number(String(m[1]).replace(/[,\s]/g, ""));
    if (!Number.isFinite(n)) return null;

    const suffix = (m[2] || "").toLowerCase();
    if (suffix === "k") n *= 1e3;
    else if (suffix === "m") n *= 1e6;
    else if (suffix === "b") n *= 1e9;

    n = Math.round(n);
    return Number.isFinite(n) ? n : null;
  }

  function parseMoney(text) {
    return parseScaledInteger(text, { requireCurrency: true });
  }

  function parseStockValue(text) {
    return parseScaledInteger(text, { allowCurrency: false });
  }

  function normalizeWholeNumber(value, primaryParser, fallbackParser = null) {
    if (value !== null && value !== undefined && value !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return Math.round(numeric);
    }

    if (typeof value !== "string") return null;
    return primaryParser(value) ?? (typeof fallbackParser === "function" ? fallbackParser(value) : null);
  }

  function normalizeItemId(value) {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(String(value).trim());
    if (!Number.isInteger(n) || n <= 0) return null;
    return n;
  }

  function isValidName(name) {
    const n = norm(name);
    if (n.length < 2 || n.length > 80) return false;
    if (n.startsWith("$")) return false;
    if (!/[A-Za-z]/.test(n)) return false;     // must contain letters
    if (/^[\d\s,$.-]+$/.test(n)) return false; // reject numeric/currency-only
    if (BLOCKED_ITEM_NAME_KEYS.has(toNameKey(n))) return false;
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

  function isTravelPage() {
    return location.href.includes("page.php?sid=travel");
  }

  function getPageStateUrl() {
    return `${location.origin}${location.pathname}${location.search}`;
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (!style) return false;
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    const r = el.getBoundingClientRect?.();
    if (!r) return true;
    return r.width > 0 && r.height > 0;
  }

  function nextElementInDocumentOrder(n) {
    if (n.firstElementChild) return n.firstElementChild;
    while (n) {
      if (n.nextElementSibling) return n.nextElementSibling;
      n = n.parentElement;
    }
    return null;
  }

  function getElementsBetween(startEl, endEl) {
    const out = [];
    let node = nextElementInDocumentOrder(startEl);

    while (node && node !== endEl) {
      if (node.nodeType === 1) out.push(node);
      node = nextElementInDocumentOrder(node);
    }

    return out;
  }

  function getVisibleElementChildren(el) {
    return Array.from(el?.children || []).filter(isVisible);
  }

  function getClassTokens(el) {
    return Array.from(el?.classList || []).map((token) => String(token || "").toLowerCase()).filter(Boolean);
  }

  function isLikelyStockCellText(text) {
    const t = norm(text);
    if (!t || t.includes("$")) return false;
    if (parseStockValue(t) === null) return false;
    if (STOCK_LABEL_RE.test(t) || STOCK_PHRASE_RE.test(t)) return true;
    if (/[A-Za-z]/.test(t)) return false;
    return /^[0-9][0-9,\s]*(?:\.[0-9]+)?(?:\s*[kKmMbB])?$/.test(t);
  }

  function buildExtractedItem(name, stock, cost, shop, rowEl, category = null) {
    const normalizedName = norm(name);
    const normalizedStock = normalizeWholeNumber(stock, parseStockValue, parseScaledInteger);
    const normalizedCost = normalizeWholeNumber(cost, parseMoney, parseScaledInteger);
    if (!isValidName(normalizedName) || normalizedStock === null || normalizedCost === null) return null;

    const item = {
      name: normalizedName,
      stock: normalizedStock,
      cost: normalizedCost,
      shop,
      category: category || shop,
    };

    const itemId = extractExplicitItemId(rowEl);
    if (itemId !== null) item.itemId = itemId;

    return item;
  }

  function extractExplicitItemId(rowEl) {
    if (!rowEl || rowEl.nodeType !== 1) return null;

    const ids = new Set();
    const nodes = [rowEl, ...Array.from(rowEl.querySelectorAll("*"))];

    for (const el of nodes) {
      for (const attr of Array.from(el.attributes || [])) {
        const attrName = String(attr.name || "");
        const attrValue = String(attr.value || "").trim();
        if (!attrValue) continue;

        let candidate = null;
        if (/item[_-]?id/i.test(attrName)) {
          const m = attrValue.match(/\d{1,9}/);
          candidate = m ? normalizeItemId(m[0]) : null;
        } else if (/^data-item$/i.test(attrName) && /^\d{1,9}$/.test(attrValue)) {
          candidate = normalizeItemId(attrValue);
        } else if (/^(href|src|data-src)$/i.test(attrName)) {
          const m = attrValue.match(/(?:item(?:id)?[=/:_-]|\/items?\/)(\d{1,9})(?:\D|$)/i);
          candidate = m ? normalizeItemId(m[1]) : null;
        }

        if (candidate !== null) ids.add(candidate);
      }
    }

    return ids.size === 1 ? Array.from(ids)[0] : null;
  }

  function makeTextCell(el, text = null) {
    const candidateText = norm(text === null ? getElementText(el) : text);
    if (!candidateText || candidateText.length > TEXT_ONLY_CELL_MAX_LENGTH) return null;
    return { el, text: candidateText };
  }

  function collectLeafTextCells(rowEl) {
    const out = [];
    const seen = new Set();
    const nodes = Array.from(rowEl.querySelectorAll("button,a,span,div,td,th,li,p,strong,b,small,label"));

    for (const el of nodes) {
      if (!isVisible(el)) continue;

      const text = getElementText(el);
      if (!text || text.length > TEXT_ONLY_CELL_MAX_LENGTH) continue;

      const hasVisibleTextChildren = getVisibleElementChildren(el).some((child) => !!getElementText(child));
      const tag = (el.tagName || "").toLowerCase();
      if (hasVisibleTextChildren && !["button", "a", "td", "th", "li"].includes(tag)) continue;

      const key = `${tag}::${text}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const cell = makeTextCell(el, text);
      if (cell) out.push(cell);
    }

    return out;
  }

  function getStructuredTextCells(rowEl) {
    const directCells = [];
    const directSeen = new Set();

    for (const child of getVisibleElementChildren(rowEl)) {
      const cell = makeTextCell(child);
      if (!cell) continue;
      const key = `${(child.tagName || "").toLowerCase()}::${cell.text}`;
      if (directSeen.has(key)) continue;
      directSeen.add(key);
      directCells.push(cell);
    }

    const directHasSignals =
      directCells.some((cell) => parseMoney(cell.text) !== null) &&
      directCells.some((cell) => isLikelyStockCellText(cell.text));
    if (directHasSignals) return directCells;

    const leafCells = collectLeafTextCells(rowEl);
    return leafCells.length ? leafCells : directCells;
  }

  function pickPriceCell(rowEl, cells) {
    const explicit = rowEl.querySelector('span[class*="displayPrice"]');
    if (explicit) {
      const value = parseMoney(getElementText(explicit));
      if (value !== null) return { el: explicit, text: getElementText(explicit), value };
    }

    const matches = cells
      .map((cell) => {
        const value = parseMoney(cell.text);
        return value === null ? null : { ...cell, value };
      })
      .filter(Boolean)
      .sort((a, b) => a.text.length - b.text.length);

    return matches[0] || null;
  }

  function pickStockCell(rowEl, cells) {
    const explicit = rowEl.querySelector('[data-tt-content-type="stock"]');
    if (explicit) {
      const value = parseStockValue(getElementText(explicit));
      if (value !== null) return { el: explicit, text: getElementText(explicit), value };
    }

    const matches = cells
      .map((cell) => {
        if (!isLikelyStockCellText(cell.text)) return null;
        const value = parseStockValue(cell.text);
        if (value === null) return null;
        const score = STOCK_LABEL_RE.test(cell.text) || STOCK_PHRASE_RE.test(cell.text) ? 0 : 1;
        return { ...cell, value, score };
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || a.text.length - b.text.length);

    return matches[0] || null;
  }

  function pickNameCell(rowEl, cells, excludedElements = []) {
    const explicitNames = [];
    const nameButton = rowEl.querySelector('button[class*="itemNameButton"]');
    if (nameButton) explicitNames.push(getElementText(nameButton));

    for (const img of Array.from(rowEl.querySelectorAll("img[alt],img[title]"))) {
      explicitNames.push(norm(img.getAttribute("alt") || img.getAttribute("title") || ""));
    }

    for (const text of explicitNames) {
      if (isValidName(text)) return { el: rowEl, text };
    }

    const excluded = new Set(excludedElements.filter(Boolean));
    for (const cell of cells) {
      if (excluded.has(cell.el)) continue;
      if (PRICE_TEXT_RE.test(cell.text)) continue;
      if (isLikelyStockCellText(cell.text)) continue;
      if (!isValidName(cell.text)) continue;
      return cell;
    }

    return null;
  }

  function isMaybeStructuredRow(node) {
    if (!node || node.nodeType !== 1 || !isVisible(node)) return false;

    const text = getElementText(node);
    if (!text || text.length > ROW_TEXT_MAX_LENGTH) return false;
    if (BLOCKED_ITEM_NAME_KEYS.has(toNameKey(text))) return false;
    if (!PRICE_TEXT_RE.test(text) && !node.querySelector('span[class*="displayPrice"]')) return false;
    if (
      !STOCK_LABEL_RE.test(text) &&
      !STOCK_PHRASE_RE.test(text) &&
      !node.querySelector('[data-tt-content-type="stock"]') &&
      !getVisibleElementChildren(node).some((child) => isLikelyStockCellText(getElementText(child)))
    ) {
      return false;
    }

    const tag = (node.tagName || "").toLowerCase();
    const role = String(node.getAttribute?.("role") || "").toLowerCase();
    const classTokens = getClassTokens(node);
    const hasRowClass = classTokens.some(
      (token) => token === "row" || token.startsWith("row") || token.endsWith("row") || token.includes("itemrow")
    );
    const childCount = getVisibleElementChildren(node).length;
    const hasStructuredCells = !!node.querySelector('td,[role="cell"],[data-tt-content-type="stock"],span[class*="displayPrice"]');

    return tag === "tr" || tag === "li" || role === "row" || hasRowClass || hasStructuredCells || (childCount >= 2 && childCount <= 8);
  }

  function getStructuredRowsBetween(startEl, endEl) {
    const candidates = getElementsBetween(startEl, endEl).filter(isMaybeStructuredRow);
    return candidates.filter(
      (row, rowIndex) => !candidates.some((other, otherIndex) => otherIndex !== rowIndex && row.contains(other))
    );
  }

  function extractItemFromStructuredRow(rowEl, shop) {
    const cells = getStructuredTextCells(rowEl);
    if (!cells.length) return null;

    const price = pickPriceCell(rowEl, cells);
    const stock = pickStockCell(rowEl, cells);
    if (!price || !stock) return null;

    const name = pickNameCell(rowEl, cells, [price.el, stock.el]);
    if (!name) return null;

    return buildExtractedItem(name.text, stock.value, price.value, shop, rowEl, shop);
  }

  function sanitizeItemsForUpload(items) {
    const out = [];
    const seen = new Set();

    for (const source of Array.isArray(items) ? items : []) {
      const shop = normalizeShop(source?.shop || source?.category);
      const category = normalizeShop(source?.category) || shop;
      const name = norm(source?.name);
      const stock = normalizeWholeNumber(source?.stock, parseStockValue, parseScaledInteger);
      const cost = normalizeWholeNumber(source?.cost, parseMoney, parseScaledInteger);
      const itemId = normalizeItemId(source?.itemId);

      if (!shop || !isValidName(name) || stock === null || cost === null) continue;

      const dedupeKey = `${shop}::${itemId !== null ? `id:${itemId}` : name.toLowerCase()}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const item = {
        name,
        stock,
        cost,
        shop,
        category,
      };
      if (itemId !== null) item.itemId = itemId;

      out.push(item);
    }

    return out;
  }

  // ---------------- Country detection ----------------
  function getCountryName() {
    // Use the info banner text: "You are in Mexico and have $."
    const pageText = norm(document.body?.innerText || "");
    const m = pageText.match(/You are in\s+([A-Za-z ]+?)\s+and have\b/i);
    if (m) {
      const candidate = norm(m[1]);
      if (KNOWN_COUNTRIES.has(candidate)) return candidate;
    }

    // Backup: exact header match
    const headers = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
      .map((el) => norm(el.textContent))
      .filter(Boolean);

    for (const h of headers) {
      if (KNOWN_COUNTRIES.has(h)) return h;
    }

    return null;
  }

  // ---------------- Scrape (STRICT desktop DOM — unchanged) ----------------
  function getShopHeadersStrict() {
    // <h5 class="shopHeader___.">General Store</h5>
    return Array.from(document.querySelectorAll('h5[class*="shopHeader"]'))
      .map((el) => ({ el, text: norm(el.textContent) }))
      .filter((h) => SHOP_NAMES.includes(h.text));
  }

  function getRowsBetweenStrict(startEl, endEl) {
    return getElementsBetween(startEl, endEl).filter(
      (node) => node.classList && Array.from(node.classList).some((c) => c.startsWith("row___"))
    );
  }

  function extractItemFromRowStrict(rowEl, shop) {
    const nameBtn = rowEl.querySelector('button[class*="itemNameButton"]');
    const name = nameBtn ? norm(nameBtn.textContent) : null;
    if (!isValidName(name)) return null;

    const priceEl = rowEl.querySelector('span[class*="displayPrice"]');
    const cost = priceEl ? parseMoney(priceEl.textContent) : null;

    const stockEl = rowEl.querySelector('div[data-tt-content-type="stock"]');
    const stock = stockEl ? parseStockValue(stockEl.textContent) : null;

    return buildExtractedItem(name, stock, cost, shop, rowEl, shop);
  }

  function collectItemsStrict() {
    const shopHeaders = getShopHeadersStrict();
    if (!shopHeaders.length) return [];

    const allItems = [];
    const seen = new Set();

    for (let i = 0; i < shopHeaders.length; i++) {
      const { el: headerEl, text: shopText } = shopHeaders[i];
      const shop = normalizeShop(shopText);
      if (!shop) continue;

      const endEl = shopHeaders[i + 1]?.el || null;
      const rows = getRowsBetweenStrict(headerEl, endEl);

      for (const row of rows) {
        const item = extractItemFromRowStrict(row, shop);
        if (!item) continue;

        const key = `${item.shop}::${item.name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push(item);
      }
    }

    return allItems;
  }

  // ---------------- Bounded mobile/TornPDA section scraper ----------------
  function findShopHeaderElementsLoose() {
    const candidates = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6,div,span"))
      .map((el) => {
        const text = norm(el.textContent);
        return { el, text };
      })
      .filter((x) => !isDroqsdbUiNode(x.el))
      .filter((x) => SHOP_NAMES.includes(x.text))
      .filter((x) => isVisible(x.el));

    const out = [];
    const seen = new Set();
    for (const x of candidates) {
      const key = x.text + "::" + (x.el.tagName || "") + "::" + (x.el.id || "");
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(x);
    }
    return out.filter(
      (candidate, index) =>
        !out.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            candidate.text === other.text &&
            candidate.el.contains(other.el)
        )
    );
  }

  async function collectItemsTornPDA() {
    const headers = findShopHeaderElementsLoose();
    if (!headers.length) {
      debugBadge("DroqsDB: TornPDA fallback\nNo shop headers found");
      return [];
    }

    const allItems = [];
    const seen = new Set();

    for (let i = 0; i < headers.length; i++) {
      const headerEl = headers[i].el;
      const shop = normalizeShop(headers[i].text);
      if (!shop) continue;

      const endEl = headers[i + 1]?.el || null;
      const rows = getStructuredRowsBetween(headerEl, endEl);

      for (const row of rows) {
        const item = extractItemFromStructuredRow(row, shop);
        if (!item) continue;

        const key = `${shop}::${item.itemId ?? item.name}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);

        allItems.push(item);
      }
    }

    if (allItems.length < MIN_FALLBACK_ITEMS) {
      debugBadge(`DroqsDB: TornPDA fallback\nToo few items (${allItems.length}) — abort`);
      return [];
    }

    return allItems;
  }

  // ---------------- Upload ----------------
  function parseUploadResponseText(text) {
    try {
      return JSON.parse(String(text || ""));
    } catch {
      throw new Error("Invalid response JSON");
    }
  }

  function requireConfirmedUpload(body) {
    if (!body || body.ok !== true) {
      throw new Error(String(body?.message || "Upload rejected"));
    }

    const savedCount = Number(body.savedCount);
    if (!Number.isFinite(savedCount)) {
      throw new Error("Invalid response JSON");
    }
    if (savedCount <= 0) {
      throw new Error("No items saved");
    }

    return { savedCount };
  }

  async function uploadReport(country, items) {
    const payload = JSON.stringify({ country, items });

    const headers = {
      "Content-Type": "application/json",
      "X-DroqsDB-Client": "userscript",
      "X-DroqsDB-Version": SCRIPT_VERSION,
    };

    if (typeof GM_xmlhttpRequest === "function") {
      return await new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: "POST",
          url: API_URL,
          headers,
          data: payload,
          timeout: 20000,
          onload: (res) => {
            if (res.status < 200 || res.status >= 300) {
              reject(new Error(`HTTP ${res.status}`));
              return;
            }

            try {
              resolve(requireConfirmedUpload(parseUploadResponseText(res.responseText)));
            } catch (e) {
              reject(e);
            }
          },
          onerror: () => reject(new Error("Network error")),
          ontimeout: () => reject(new Error("Timeout")),
        });
      });
    }

    const res = await fetch(API_URL, {
      method: "POST",
      headers,
      body: payload,
      mode: "cors",
      credentials: "omit",
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return requireConfirmedUpload(parseUploadResponseText(await res.text()));
  }

  // ---------------- Run loop ----------------
  const completedPageStates = new Set();
  let isBusy = false;
  let scanObserver = null;
  let scanObserverTimeout = null;
  let scanTimer = null;
  let navigationTimer = null;
  let currentPageToken = 0;

  async function collectItemsSmart() {
    const strictItems = collectItemsStrict();
    if (strictItems.length) {
      debugBadge(`DroqsDB: strict OK\nItems: ${strictItems.length}`);
      return { items: strictItems, mode: "strict" };
    }

    const fallbackItems = await collectItemsTornPDA();
    if (fallbackItems.length) {
      debugBadge(`DroqsDB: fallback OK\nItems: ${fallbackItems.length}`);
      return { items: fallbackItems, mode: "tornpda" };
    }

    return { items: [], mode: "none" };
  }

  function getPageStateKey(country) {
    if (!country) return null;

    // A travel URL + foreign country is the stable page state for this repair pass.
    // Ordinary DOM churn inside that state should not trigger another upload.
    return `${getPageStateUrl()}::${country}::${currentPageToken}`;
  }

  function hasKnownShopHeaders() {
    return getShopHeadersStrict().length > 0 || findShopHeaderElementsLoose().length > 0;
  }

  function clearScanTimer() {
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
  }

  function disconnectScanObserver() {
    if (scanObserver) {
      scanObserver.disconnect();
      scanObserver = null;
    }
    if (scanObserverTimeout) {
      clearTimeout(scanObserverTimeout);
      scanObserverTimeout = null;
    }
  }

  function armScanObserver() {
    if (scanObserver || !isTravelPage()) return;

    // Only watch mutations while waiting for the current travel page to become scannable.
    scanObserver = new MutationObserver(() => {
      clearScanTimer();
      scanTimer = setTimeout(() => {
        scanTimer = null;
        maybeScanCurrentPageState();
      }, PAGE_READY_DEBOUNCE_MS);
    });

    scanObserver.observe(document.documentElement, { childList: true, subtree: true });
    scanObserverTimeout = setTimeout(() => {
      disconnectScanObserver();
    }, PAGE_READY_OBSERVER_TIMEOUT_MS);
  }

  function resetPageStateWatch(delayMs = PAGE_READY_DEBOUNCE_MS) {
    disconnectScanObserver();
    clearScanTimer();
    if (!isTravelPage()) return;

    scanTimer = setTimeout(() => {
      scanTimer = null;
      maybeScanCurrentPageState();
    }, delayMs);
    armScanObserver();
  }

  function startNewPageStateWatch(delayMs = PAGE_READY_DEBOUNCE_MS) {
    currentPageToken += 1;
    syncSettingsLauncherVisibility(getSettings());
    scheduleCompanionStateCheck(delayMs);
    resetPageStateWatch(delayMs);
  }

  function maybeScanCurrentPageState() {
    if (isBusy || !isTravelPage()) {
      if (!isTravelPage()) disconnectScanObserver();
      return;
    }

    const country = getCountryName();
    if (!country) return;

    const pageStateKey = getPageStateKey(country);
    if (!pageStateKey) return;
    if (completedPageStates.has(pageStateKey)) {
      disconnectScanObserver();
      return;
    }

    if (!hasKnownShopHeaders()) return;

    disconnectScanObserver();
    void scanAndMaybeUpload(pageStateKey, country);
  }

  async function scanAndMaybeUpload(pageStateKey, country) {
    if (isBusy) return;
    isBusy = true;

    try {
      if (!isTravelPage()) return;
      country = country || getCountryName();
      if (!country) return;
      pageStateKey = pageStateKey || getPageStateKey(country);
      if (!pageStateKey || completedPageStates.has(pageStateKey)) return;

      const { items: rawItems, mode } = await collectItemsSmart();
      const items = sanitizeItemsForUpload(rawItems);
      if (!items.length) {
        armScanObserver();
        return;
      }

      if (getPageStateKey(country) !== pageStateKey) return;

      showBadge(`DroqsDB Uploading…\n${country}\nItems: ${items.length}\nMode: ${mode}`);

      try {
        await uploadReport(country, items);
        completedPageStates.add(pageStateKey);
        showBadge(`DroqsDB Uploaded ✓\n${country}\nItems: ${items.length}\nMode: ${mode}`);
        hideBadgeSoon(900);
        scheduleCompanionPanelRefreshAfterUpload(pageStateKey, country);
      } catch (e) {
        completedPageStates.add(pageStateKey);
        showBadge(`DroqsDB Upload Failed\n${country}\n${String(e.message || e)}`);
        hideBadgeSoon(2000);
      }
    } finally {
      isBusy = false;
    }
  }

  function installNavigationHooks() {
    const onPotentialPageChange = () => {
      if (navigationTimer) clearTimeout(navigationTimer);
      navigationTimer = setTimeout(() => {
        navigationTimer = null;
        startNewPageStateWatch();
      }, 0);
    };

    window.addEventListener("pageshow", onPotentialPageChange);
    window.addEventListener("popstate", onPotentialPageChange);
    window.addEventListener("hashchange", onPotentialPageChange);

    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function") continue;

      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(onPotentialPageChange, 0);
        return result;
      };
    }
  }

  registerUserscriptMenuCommands();
  window.addEventListener("resize", () => syncSettingsLauncherVisibility(getSettings()));
  window.addEventListener("orientationchange", () => syncSettingsLauncherVisibility(getSettings()));
  syncUiVisibilityWithSettings(getSettings());
  installCompanionStateObserver();
  installNavigationHooks();
  startNewPageStateWatch();
})();
