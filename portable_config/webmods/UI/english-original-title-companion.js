/**
 * @name English Original Title Companion
 * @description Shows the English/original title beside localized Chinese titles, but only for media whose TMDB original_language is English.
 *
 * Behaviour:
 * - Chinese/localized title remains primary.
 * - If TMDB says original_language === "en", show the English title as a secondary line.
 * - Non-English originals (Japanese anime, Korean dramas, etc.) do not get an English subtitle.
 * - The full Chinese + English pair is also written to the card tooltip.
 */
(function () {
  "use strict";

  if (window.KaiEnglishOriginalTitleCompanion?.initialized) return;

  const API_BASE = "https://api.themoviedb.org/3";
  const FETCH_TIMEOUT_MS = 7000;
  const SCAN_DELAY_MS = 260;
  const CONCURRENCY = 4;

  const CATALOG_CONTAINERS =
    ".meta-items-container-n8vNz, .meta-items-container-qcuUA, .meta-items-container-IKrND";
  const POSTER_SELECTOR =
    "img.poster-image-NiV7O, .poster-container-qkw48 img, img[src*='poster']";

  const cache = new Map();
  let observer = null;
  let timer = null;
  let scanSerial = 0;

  function isChineseMode() {
    const lang = window.MetadataModules?.preferences?.get("language") || "en";
    return /^zh(?:-|$)/i.test(lang);
  }

  function getApiKey() {
    return window.MetadataModules?.apiKeys?.getKey("TMDB") || null;
  }

  function getFetchUtils() {
    return window.MetadataModules?.fetchUtils || null;
  }

  function getTmdbFetcher() {
    return window.MetadataModules?.tmdbFetcher || null;
  }

  function ensureStyles() {
    if (document.getElementById("kai-english-original-title-style")) return;
    const style = document.createElement("style");
    style.id = "kai-english-original-title-style";
    style.textContent = `
      .kai-english-original-title {
        display: block;
        max-width: 100%;
        margin-top: 2px;
        font-size: 0.78em;
        line-height: 1.18;
        font-weight: 400;
        opacity: 0.66;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }

      .kai-hero-english-original-title {
        display: block;
        max-width: min(620px, 42vw);
        margin-top: 4px;
        margin-bottom: 6px;
        font-size: clamp(0.82rem, 0.75vw, 1rem);
        line-height: 1.25;
        font-weight: 500;
        letter-spacing: 0.01em;
        opacity: 0.68;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }
    `;
    document.head?.appendChild(style);
  }

  function parseDetailHref(href) {
    if (!href) return null;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch (_) {}

    const match = decoded.match(/\/detail\/(movie|series)\/([^/?#]+)/i);
    if (!match) return null;

    const type = match[1].toLowerCase();
    const rawId = match[2];
    if (/^tt\d+$/i.test(rawId)) {
      return { type, imdbId: rawId, tmdbId: null };
    }
    if (/^tmdb:\d+$/i.test(rawId)) {
      return {
        type,
        imdbId: null,
        tmdbId: Number(rawId.replace(/^tmdb:/i, "")),
      };
    }
    return null;
  }

  function parseItem(item) {
    const href =
      item.getAttribute?.("href") ||
      item.closest?.("a[href]")?.getAttribute("href") ||
      "";
    let info = parseDetailHref(href);

    if (!info) {
      const id = item.id || item.closest?.("[id]")?.id || "";
      if (/^tt\d+$/i.test(id)) {
        info = { type: null, imdbId: id, tmdbId: null };
      } else if (/^tmdb:\d+$/i.test(id)) {
        info = {
          type: null,
          imdbId: null,
          tmdbId: Number(id.replace(/^tmdb:/i, "")),
        };
      }
    }

    const poster = item.querySelector?.(POSTER_SELECTOR);
    if (!info && poster?.src) {
      const imdb = poster.src.match(/tt\d{7,}/i)?.[0] || null;
      if (imdb) info = { type: null, imdbId: imdb, tmdbId: null };
    }

    if (!info) return null;
    if (!info.type) {
      if (/\/series\//i.test(href)) info.type = "series";
      else if (/\/movie\//i.test(href)) info.type = "movie";
    }
    return info;
  }

  async function resolveTmdbId(info) {
    if (Number.isFinite(info?.tmdbId)) return info.tmdbId;
    if (!info?.imdbId || !info?.type) return null;
    const fetcher = getTmdbFetcher();
    if (!fetcher?.convertToTmdbId || !fetcher?.isAvailable?.()) return null;
    return fetcher.convertToTmdbId(info.imdbId, info.type);
  }

  async function fetchEnglishOriginInfo(info) {
    const tmdbId = await resolveTmdbId(info);
    if (!tmdbId || !info?.type) return null;

    const key = `${info.type}:${tmdbId}`;
    if (cache.has(key)) return cache.get(key);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return null;

      const mediaType = info.type === "series" ? "tv" : "movie";
      const url = `${API_BASE}/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;

      try {
        const result = await fetchUtils.makeRequest(url, {
          timeout: FETCH_TIMEOUT_MS,
        });
        if (!result?.ok) return null;

        const data = result.data || {};
        const originalLanguage = String(data.original_language || "").toLowerCase();
        const englishTitle = String(
          data.title ||
            data.name ||
            data.original_title ||
            data.original_name ||
            "",
        ).trim();

        return {
          tmdbId,
          originalLanguage,
          englishTitle: englishTitle || null,
        };
      } catch (error) {
        console.debug(`[English Title Companion] TMDB request failed for ${key}:`, error);
        return null;
      }
    })();

    cache.set(key, promise);
    return promise;
  }

  function findLocalizedTitleTextNode(item, localizedTitle) {
    if (!localizedTitle) return null;
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest?.(".poster-container-qkw48")) continue;
      if ((node.nodeValue || "").trim() === localizedTitle.trim()) return node;
    }
    return null;
  }

  function removeCardSubtitle(item) {
    item.querySelectorAll?.(".kai-english-original-title").forEach((el) => el.remove());
    delete item.dataset.kaiEnglishOriginalTitle;
  }

  function applyCardSubtitle(item, localizedTitle, englishTitle) {
    if (!item?.isConnected || !localizedTitle || !englishTitle) return;
    if (localizedTitle.trim().toLowerCase() === englishTitle.trim().toLowerCase()) {
      removeCardSubtitle(item);
      return;
    }

    const titleNode = findLocalizedTitleTextNode(item, localizedTitle);
    if (!titleNode?.parentElement) return;

    let subtitle = item.querySelector?.(".kai-english-original-title");
    if (!subtitle) {
      subtitle = document.createElement("span");
      subtitle.className = "kai-english-original-title";
      titleNode.parentElement.appendChild(subtitle);
    }

    subtitle.textContent = englishTitle;
    subtitle.title = englishTitle;
    item.dataset.kaiEnglishOriginalTitle = englishTitle;

    const bilingualTooltip = `${localizedTitle} / ${englishTitle}`;
    if (item.getAttribute?.("title") != null) item.setAttribute("title", bilingualTooltip);
    if (item.getAttribute?.("aria-label") != null) {
      item.setAttribute("aria-label", bilingualTooltip);
    }
  }

  async function processCatalogItem(item) {
    if (!item?.isConnected) return;

    // The Chinese catalog localizer sets this only after a visible title has
    // actually been replaced, so this companion never forces bilingual text
    // onto cards that are still showing their normal English title.
    const localizedTitle = item.dataset?.kaiLocalizedTitle || "";
    if (!localizedTitle) {
      removeCardSubtitle(item);
      return;
    }

    const info = parseItem(item);
    if (!info?.type || (!info.imdbId && !info.tmdbId)) return;

    const english = await fetchEnglishOriginInfo(info);
    if (!english || !item.isConnected) return;

    if (english.originalLanguage !== "en" || !english.englishTitle) {
      removeCardSubtitle(item);
      return;
    }

    applyCardSubtitle(item, localizedTitle, english.englishTitle);
  }

  function getCatalogItems() {
    const results = new Set();
    document.querySelectorAll(CATALOG_CONTAINERS).forEach((container) => {
      container.querySelectorAll("a, div[tabindex]").forEach((item) => {
        if (
          item.dataset?.kaiLocalizedTitle ||
          item.querySelector?.(POSTER_SELECTOR) ||
          item.getAttribute?.("href")?.includes("/detail/")
        ) {
          results.add(item);
        }
      });
    });
    return Array.from(results);
  }

  async function mapWithConcurrency(items, limit, worker) {
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(limit, Math.max(items.length, 1)) },
      async () => {
        while (cursor < items.length) {
          const index = cursor++;
          await worker(items[index], index);
        }
      },
    );
    await Promise.all(workers);
  }

  async function processHero() {
    const state = window.HeroPlugin?.State;
    const titles = state?.heroTitles;
    if (!Array.isArray(titles) || titles.length === 0) return;

    const current = titles[Number(state.currentIndex || 0)];
    if (!current) return;

    const info = {
      type: current.type === "series" ? "series" : "movie",
      imdbId:
        typeof current.imdb === "string" && /^tt\d+$/i.test(current.imdb)
          ? current.imdb
          : null,
      tmdbId:
        current.tmdbId != null && Number.isFinite(Number(current.tmdbId))
          ? Number(current.tmdbId)
          : null,
    };
    if (!info.imdbId && !info.tmdbId) return;

    const english = await fetchEnglishOriginInfo(info);
    if (!english) return;

    const localizedTitle = String(current.title || current.extractedTitle || "").trim();
    const host = document.querySelector(".hero-logo-container");
    if (!host) return;

    let subtitle = document.querySelector(".kai-hero-english-original-title");

    const shouldShow =
      english.originalLanguage === "en" &&
      english.englishTitle &&
      localizedTitle &&
      localizedTitle.toLowerCase() !== english.englishTitle.toLowerCase();

    if (!shouldShow) {
      subtitle?.remove();
      return;
    }

    if (!subtitle) {
      subtitle = document.createElement("div");
      subtitle.className = "kai-hero-english-original-title";
      host.insertAdjacentElement("afterend", subtitle);
    }

    subtitle.textContent = english.englishTitle;
    subtitle.title = english.englishTitle;
  }

  async function scan() {
    const serial = ++scanSerial;
    if (!isChineseMode() || !getApiKey()) return;

    ensureStyles();
    const items = getCatalogItems();
    await Promise.all([
      mapWithConcurrency(items, CONCURRENCY, async (item) => {
        if (serial !== scanSerial) return;
        await processCatalogItem(item);
      }),
      processHero(),
    ]);
  }

  function scheduleScan(delay = SCAN_DELAY_MS) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      scan().catch((error) =>
        console.debug("[English Title Companion] Scan failed:", error),
      );
    }, delay);
  }

  function initObserver() {
    if (!document.body || observer) return;
    observer = new MutationObserver((mutations) => {
      if (!isChineseMode()) return;
      if (
        mutations.some(
          (mutation) =>
            mutation.type === "childList" &&
            (mutation.addedNodes.length || mutation.removedNodes.length),
        )
      ) {
        scheduleScan();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 250);
      return;
    }

    ensureStyles();
    initObserver();
    window.addEventListener("hashchange", () => scheduleScan(100));
    window.addEventListener("metadata-modules-ready", () => scheduleScan(150));
    document.body.addEventListener("click", () => scheduleScan(320), true);

    // Hero slides can change without a route change. Requests are cached after
    // the first lookup, so this is intentionally lightweight.
    setInterval(() => {
      if (isChineseMode()) processHero().catch(() => {});
    }, 1300);

    // Catalog localizer may finish a fraction later than this script.
    scheduleScan(800);
  }

  window.KaiEnglishOriginalTitleCompanion = {
    initialized: true,
    refresh: () => scheduleScan(0),
    clearCache: () => cache.clear(),
    get cacheSize() {
      return cache.size;
    },
  };

  init();
})();
