/**
 * @name Title & Summary Localizer
 * @description Applies Chinese TMDB translation fallbacks to detail-page text.
 *
 * Chinese fallback order:
 *   1. Traditional Chinese (Hong Kong)
 *   2. Traditional Chinese (Taiwan)
 *   3. Other/generic Traditional Chinese (Macau/regionless)
 *   4. Simplified Chinese (China/Singapore)
 *   5. English
 */
(function () {
  "use strict";

  if (window.KaiTitleSummaryLocalizer?.initialized) return;

  const API_BASE = "https://api.themoviedb.org/3";
  const FETCH_TIMEOUT_MS = 8000;

  const SELECTORS = {
    META_CONTAINER: ".meta-info-container-ub8AH",
    EPISODES_CONTAINER: ".videos-container-msX8s",
    PLOT: ".show-page-injected-plot",
    TAGLINE: ".show-page-tagline",
    TITLE_PLACEHOLDER: ".logo-placeholder-rE1ld",
  };

  const cache = new Map();
  let observer = null;
  let debounceTimer = null;
  let runSerial = 0;

  function getPreferenceLanguage() {
    return window.MetadataModules?.preferences?.get("language") || "en";
  }

  function isChineseMode() {
    return /^zh(?:-|$)/i.test(getPreferenceLanguage());
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

  function getVisibleMetaContainer() {
    const containers = document.querySelectorAll(SELECTORS.META_CONTAINER);
    for (const container of containers) {
      const rect = container.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return container;
    }
    return containers[0] || null;
  }

  function parseRoute() {
    const hash = window.location.hash || "";
    const match = hash.match(/^#\/detail\/(movie|series)\/([^/?#]+)/i);

    if (match) {
      const type = match[1].toLowerCase();
      const rawId = decodeURIComponent(match[2]);
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
    }

    // Discover/library detail pages can retain a non-detail hash. Fall back to
    // the visible IMDb link and infer the media type from the episodes list.
    const container = getVisibleMetaContainer();
    if (!container) return null;

    const imdbLink = container.querySelector('a[href*="imdb.com/title/tt"], a[href*="/tt"]');
    const href = imdbLink?.getAttribute("href") || "";
    const imdbMatch = href.match(/tt\d+/i);
    if (!imdbMatch) return null;

    return {
      type: container.querySelector(SELECTORS.EPISODES_CONTAINER)
        ? "series"
        : "movie",
      imdbId: imdbMatch[0],
      tmdbId: null,
    };
  }

  async function resolveTmdbId(routeInfo) {
    if (routeInfo.tmdbId) return routeInfo.tmdbId;
    if (!routeInfo.imdbId) return null;

    const tmdbFetcher = getTmdbFetcher();
    if (!tmdbFetcher?.convertToTmdbId || !tmdbFetcher?.isAvailable?.()) {
      return null;
    }

    return tmdbFetcher.convertToTmdbId(routeInfo.imdbId, routeInfo.type);
  }

  function normalizeTranslation(entry) {
    if (!entry) return null;
    const language = String(entry.iso_639_1 || "").toLowerCase();
    const region = String(entry.iso_3166_1 || "").toUpperCase();
    const data = entry.data || {};
    return { language, region, data };
  }

  function chineseRank(entry) {
    if (entry.language !== "zh") return Number.POSITIVE_INFINITY;
    if (entry.region === "HK") return 0;
    if (entry.region === "TW") return 1;
    if (entry.region === "MO" || entry.region === "") return 2;
    if (entry.region !== "CN" && entry.region !== "SG") return 2;
    if (entry.region === "CN") return 3;
    if (entry.region === "SG") return 4;
    return 5;
  }

  function getField(data, keys) {
    for (const key of keys) {
      const value = data?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  }

  /**
   * Select each field independently. This matters when, for example, Hong Kong
   * has a title but no overview while Taiwan has a complete overview.
   */
  function selectField(translations, keys, topLevelFallback) {
    const normalized = (translations || [])
      .map(normalizeTranslation)
      .filter(Boolean);

    const chineseValue = normalized
      .filter((entry) => entry.language === "zh")
      .sort((a, b) => chineseRank(a) - chineseRank(b))
      .map((entry) => getField(entry.data, keys))
      .find(Boolean);

    if (chineseValue) return chineseValue;

    const englishValue = normalized
      .filter((entry) => entry.language === "en")
      .map((entry) => getField(entry.data, keys))
      .find(Boolean);

    return englishValue || topLevelFallback || null;
  }

  function selectLocalizedMetadata(data, type) {
    const translations = data?.translations?.translations || [];
    const titleKeys = type === "series" ? ["name", "title"] : ["title", "name"];
    const topTitle = type === "series" ? data?.name : data?.title;

    return {
      title: selectField(translations, titleKeys, topTitle || null),
      overview: selectField(translations, ["overview"], data?.overview || null),
      tagline: selectField(translations, ["tagline"], data?.tagline || null),
    };
  }

  async function fetchLocalizedMetadata(tmdbId, type) {
    const cacheKey = `${type}:${tmdbId}`;
    if (cache.has(cacheKey)) return cache.get(cacheKey);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return null;

      const mediaType = type === "series" ? "tv" : "movie";
      const url = `${API_BASE}/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=en-US&append_to_response=translations`;

      try {
        const result = await fetchUtils.makeRequest(url, {
          timeout: FETCH_TIMEOUT_MS,
        });
        if (!result?.ok) {
          if (result?.status === 429) {
            window.MetadataModules?.apiKeys?.markRateLimited?.("TMDB");
          }
          return null;
        }
        return selectLocalizedMetadata(result.data, type);
      } catch (error) {
        console.debug("[Title Summary Localizer] TMDB request failed:", error);
        return null;
      }
    })();

    cache.set(cacheKey, promise);
    return promise;
  }

  function applyLocalizedMetadata(localized) {
    if (!localized) return false;
    let changed = false;

    // The details enhancer creates this span for the visible summary. Updating
    // only our injected node avoids mutating React-managed children.
    const plotEl = document.querySelector(SELECTORS.PLOT);
    if (plotEl && localized.overview) {
      if (plotEl.textContent !== localized.overview) {
        plotEl.textContent = localized.overview;
        changed = true;
      }
      plotEl.dataset.kaiLocalized = "zh";
    }

    // Text title is visible only when no image logo is available. Image logos
    // continue to be handled by the existing TMDB image-language logic.
    const titleEl = document.querySelector(SELECTORS.TITLE_PLACEHOLDER);
    if (titleEl && localized.title) {
      if (titleEl.textContent !== localized.title) {
        titleEl.textContent = localized.title;
        changed = true;
      }
      titleEl.dataset.kaiLocalized = "zh";
    }

    const taglineEl = document.querySelector(SELECTORS.TAGLINE);
    if (taglineEl && localized.tagline) {
      if (taglineEl.textContent !== localized.tagline) {
        taglineEl.textContent = localized.tagline;
        changed = true;
      }
      taglineEl.dataset.kaiLocalized = "zh";
    }

    return changed;
  }

  async function localizeDetailPage() {
    const serial = ++runSerial;
    if (!isChineseMode()) return;

    const routeInfo = parseRoute();
    if (!routeInfo) return;

    const tmdbId = await resolveTmdbId(routeInfo);
    if (!tmdbId || serial !== runSerial) return;

    const localized = await fetchLocalizedMetadata(tmdbId, routeInfo.type);
    if (!localized || serial !== runSerial) return;

    applyLocalizedMetadata(localized);
  }

  function scheduleLocalize(delay = 180) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      localizeDetailPage().catch((error) => {
        console.debug("[Title Summary Localizer] Update failed:", error);
      });
    }, delay);
  }

  function initObserver() {
    if (!document.body || observer) return;

    observer = new MutationObserver((mutations) => {
      if (!isChineseMode()) return;

      const relevant = mutations.some((mutation) => {
        if (mutation.type !== "childList") return false;
        return Array.from(mutation.addedNodes).some(
          (node) =>
            node.nodeType === 1 &&
            (node.matches?.(SELECTORS.PLOT) ||
              node.querySelector?.(SELECTORS.PLOT) ||
              node.matches?.(SELECTORS.TITLE_PLACEHOLDER) ||
              node.querySelector?.(SELECTORS.TITLE_PLACEHOLDER)),
        );
      });

      if (relevant) scheduleLocalize(80);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 250);
      return;
    }

    initObserver();
    window.addEventListener("hashchange", () => scheduleLocalize(100));
    window.addEventListener("metadata-updated", () => scheduleLocalize(80));
    document.body.addEventListener("click", () => scheduleLocalize(250), true);
    scheduleLocalize(300);
  }

  window.KaiTitleSummaryLocalizer = {
    initialized: true,
    refresh: () => scheduleLocalize(0),
    clearCache: () => cache.clear(),
    get cacheSize() {
      return cache.size;
    },
  };

  init();
})();
