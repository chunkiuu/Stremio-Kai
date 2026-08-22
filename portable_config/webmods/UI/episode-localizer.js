/**
 * @name Episode Localizer
 * @description Localizes TV episode titles and overviews from TMDB translations.
 *
 * Chinese fallback order for zh-HK mode:
 *   1. Traditional Chinese (Hong Kong)
 *   2. Traditional Chinese (Taiwan)
 *   3. Other/generic Traditional Chinese (e.g. Macau)
 *   4. Simplified Chinese (China/Singapore)
 *   5. Existing Stremio/Cinemeta English text (left untouched)
 *
 * The localizer also resolves numbering mismatches between Stremio/Cinemeta
 * and TMDB by matching episode air dates and English titles before falling
 * back to season/episode numbers. This is important for anime whose cours or
 * sequel seasons are grouped differently by the two databases.
 */
(function () {
  "use strict";

  if (window.KaiEpisodeLocalizer?.initialized) return;

  const API_BASE = "https://api.themoviedb.org/3";
  const FETCH_TIMEOUT_MS = 8000;
  const CONCURRENCY = 4;
  const SEASON_FETCH_CONCURRENCY = 3;

  const SELECTORS = {
    EPISODES_CONTAINER: ".videos-container-msX8s",
    EPISODE_ITEM: ".video-container-ezBpK",
    EPISODE_TITLE: ".title-container-NcfV9",
    INFO_CONTAINER: ".info-container-xyynk",
    DESCRIPTION: ".episode-description-spe",
    SEASONS_BAR: ".seasons-bar-Ma8vp",
    SEASON_LABEL: ".label-SoEGc",
  };

  const translationCache = new Map();
  const episodeIndexCache = new Map();
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

  function getRouteInfo() {
    const hash = window.location.hash || "";
    const match = hash.match(/^#\/detail\/series\/([^/?#]+)/i);
    if (!match) return null;

    const rawId = decodeURIComponent(match[1]);
    let imdbId = null;
    let tmdbId = null;

    if (/^tt\d+$/i.test(rawId)) {
      imdbId = rawId;
    } else if (/^tmdb:\d+$/i.test(rawId)) {
      tmdbId = Number(rawId.replace(/^tmdb:/i, ""));
    }

    // Fallback for detail routes whose primary ID is not IMDb.
    if (!imdbId && !tmdbId) {
      const imdbLink = document.querySelector('a[href*="imdb.com/title/tt"], a[href*="/tt"]');
      const href = imdbLink?.getAttribute("href") || "";
      const imdbMatch = href.match(/tt\d+/i);
      if (imdbMatch) imdbId = imdbMatch[0];
    }

    const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
    const routeSeason = new URLSearchParams(query).get("season");
    const season = routeSeason ? Number(routeSeason) : getSeasonFromDOM();

    return {
      imdbId,
      tmdbId: Number.isFinite(tmdbId) ? tmdbId : null,
      season: Number.isFinite(season) && season >= 0 ? season : 1,
    };
  }

  function getSeasonFromDOM() {
    const labels = document.querySelectorAll(
      `${SELECTORS.SEASONS_BAR} ${SELECTORS.SEASON_LABEL}`,
    );

    for (const label of labels) {
      const text = label.textContent?.trim() || "";
      const match = text.match(/(\d+)/);
      if (match) return Number(match[1]);
    }

    return 1;
  }

  function getEpisodeNumber(episodeEl) {
    const titleEl = episodeEl.querySelector(SELECTORS.EPISODE_TITLE);
    if (!titleEl) return null;
    const match = (titleEl.textContent || "").trim().match(/^(\d+)/);
    return match ? Number(match[1]) : null;
  }

  function getEpisodeTitle(episodeEl) {
    const titleEl = episodeEl.querySelector(SELECTORS.EPISODE_TITLE);
    if (!titleEl) return "";
    return (titleEl.textContent || "")
      .trim()
      .replace(/^\d+[.\-:\s]+/, "")
      .trim();
  }

  function getTitlePrefix(titleEl, episodeNumber) {
    const text = (titleEl.textContent || "").trim();
    const match = text.match(/^\d+[.\-:\s]+/);
    return match ? match[0] : `${episodeNumber}. `;
  }

  const MONTHS = {
    jan: "01", january: "01",
    feb: "02", february: "02",
    mar: "03", march: "03",
    apr: "04", april: "04",
    may: "05",
    jun: "06", june: "06",
    jul: "07", july: "07",
    aug: "08", august: "08",
    sep: "09", sept: "09", september: "09",
    oct: "10", october: "10",
    nov: "11", november: "11",
    dec: "12", december: "12",
  };

  function getEpisodeAirDate(episodeEl) {
    const text = episodeEl.textContent || "";
    const match = text.match(
      /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),\s+(\d{4})\b/i,
    );
    if (!match) return null;

    const month = MONTHS[match[1].toLowerCase()];
    if (!month) return null;
    return `${match[3]}-${month}-${String(Number(match[2])).padStart(2, "0")}`;
  }

  function normalizeComparableTitle(value) {
    if (!value || typeof value !== "string") return "";
    return value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/^episode\s*\d+[.\-:\s]*/i, "")
      .replace(/[\p{P}\p{S}]+/gu, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeTranslation(entry) {
    if (!entry || entry.iso_639_1 !== "zh") return null;

    const region = String(entry.iso_3166_1 || "").toUpperCase();
    const data = entry.data || {};

    return {
      region,
      name: typeof data.name === "string" ? data.name.trim() : "",
      overview: typeof data.overview === "string" ? data.overview.trim() : "",
    };
  }

  /**
   * Buckets Chinese TMDB translations into the requested preference order.
   * TMDB has regional language tags, but no universal zh-Hant episode tag.
   * Macau/regionless/other non-Simplified Chinese entries therefore form the
   * generic Traditional Chinese fallback bucket.
   */
  function translationRank(entry) {
    const region = entry.region;
    if (region === "HK") return 0;
    if (region === "TW") return 1;
    if (region === "MO" || region === "") return 2;
    if (region !== "CN" && region !== "SG") return 2;
    if (region === "CN") return 3;
    if (region === "SG") return 4;
    return 5;
  }

  function selectLocalizedField(translations, field) {
    return (
      translations
        .map(normalizeTranslation)
        .filter(Boolean)
        .sort((a, b) => translationRank(a) - translationRank(b))
        .map((entry) => entry[field])
        .find((value) => typeof value === "string" && value.trim()) || null
    );
  }

  function selectLocalizedEpisode(translations) {
    if (!Array.isArray(translations)) return null;

    const name = selectLocalizedField(translations, "name");
    const overview = selectLocalizedField(translations, "overview");

    if (!name && !overview) return null;
    return { name, overview };
  }

  async function resolveTmdbId(routeInfo) {
    if (routeInfo.tmdbId) return routeInfo.tmdbId;
    if (!routeInfo.imdbId) return null;

    const tmdbFetcher = getTmdbFetcher();
    if (!tmdbFetcher?.convertToTmdbId || !tmdbFetcher?.isAvailable?.()) {
      return null;
    }

    return tmdbFetcher.convertToTmdbId(routeInfo.imdbId, "series");
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

  /**
   * Fetch an English TMDB episode index for the whole show. The visible
   * Stremio season/episode numbering is not always the same as TMDB's (common
   * with anime cours and sequel seasons), so this index lets us match by title
   * and air date before requesting translations.
   */
  async function fetchEpisodeIndex(tmdbId) {
    if (episodeIndexCache.has(tmdbId)) return episodeIndexCache.get(tmdbId);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return [];

      const showUrl = `${API_BASE}/tv/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;

      try {
        const showResult = await fetchUtils.makeRequest(showUrl, {
          timeout: FETCH_TIMEOUT_MS,
        });
        if (!showResult?.ok) return [];

        const seasonNumbers = (showResult.data?.seasons || [])
          .filter(
            (season) =>
              Number.isFinite(Number(season?.season_number)) &&
              Number(season?.episode_count || 0) > 0,
          )
          .map((season) => Number(season.season_number));

        const rows = [];
        await mapWithConcurrency(
          seasonNumbers,
          SEASON_FETCH_CONCURRENCY,
          async (seasonNumber) => {
            const seasonUrl = `${API_BASE}/tv/${tmdbId}/season/${seasonNumber}?api_key=${encodeURIComponent(apiKey)}&language=en-US`;
            try {
              const seasonResult = await fetchUtils.makeRequest(seasonUrl, {
                timeout: FETCH_TIMEOUT_MS,
              });
              if (!seasonResult?.ok) return;

              for (const episode of seasonResult.data?.episodes || []) {
                rows.push({
                  season: Number(episode.season_number ?? seasonNumber),
                  episode: Number(episode.episode_number),
                  name: typeof episode.name === "string" ? episode.name.trim() : "",
                  airDate: episode.air_date || null,
                });
              }
            } catch (error) {
              console.debug(
                `[Episode Localizer] Season index fetch failed for season ${seasonNumber}:`,
                error,
              );
            }
          },
        );

        return rows;
      } catch (error) {
        console.debug("[Episode Localizer] Show index fetch failed:", error);
        return [];
      }
    })();

    episodeIndexCache.set(tmdbId, promise);
    return promise;
  }

  function findBestCoordinates(index, routeSeason, displayNumber, domTitle, domAirDate) {
    if (!Array.isArray(index) || index.length === 0) {
      return { season: routeSeason, episode: displayNumber };
    }

    const normalizedDomTitle = normalizeComparableTitle(domTitle);
    let best = null;
    let bestScore = -1;

    for (const candidate of index) {
      if (!Number.isFinite(candidate.season) || !Number.isFinite(candidate.episode)) {
        continue;
      }

      let score = 0;
      const normalizedCandidateTitle = normalizeComparableTitle(candidate.name);

      if (domAirDate && candidate.airDate === domAirDate) score += 1000;

      if (normalizedDomTitle && normalizedCandidateTitle) {
        if (normalizedDomTitle === normalizedCandidateTitle) {
          score += 800;
        } else if (
          Math.min(normalizedDomTitle.length, normalizedCandidateTitle.length) >= 6 &&
          (normalizedDomTitle.includes(normalizedCandidateTitle) ||
            normalizedCandidateTitle.includes(normalizedDomTitle))
        ) {
          score += 500;
        }
      }

      if (candidate.season === routeSeason) score += 60;
      if (candidate.episode === displayNumber) score += 40;

      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }

    // A season+episode numeric match alone scores 100 and is a safe fallback.
    if (best && bestScore >= 80) {
      return { season: best.season, episode: best.episode };
    }

    return { season: routeSeason, episode: displayNumber };
  }

  async function fetchEpisodeTranslation(tmdbId, season, episodeNumber) {
    const cacheKey = `${tmdbId}:${season}:${episodeNumber}`;
    if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return null;

      const url = `${API_BASE}/tv/${tmdbId}/season/${season}/episode/${episodeNumber}/translations?api_key=${encodeURIComponent(apiKey)}`;

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

        return selectLocalizedEpisode(result.data?.translations || []);
      } catch (error) {
        console.debug(
          `[Episode Localizer] Translation fetch failed for S${season}E${episodeNumber}:`,
          error,
        );
        return null;
      }
    })();

    translationCache.set(cacheKey, promise);
    return promise;
  }

  function applyTranslation(episodeEl, episodeNumber, localized) {
    if (!localized || !document.body.contains(episodeEl)) return;

    const titleEl = episodeEl.querySelector(SELECTORS.EPISODE_TITLE);
    if (titleEl && localized.name) {
      const prefix = getTitlePrefix(titleEl, episodeNumber);
      const nextTitle = `${prefix}${localized.name}`;
      if (titleEl.textContent !== nextTitle) {
        titleEl.textContent = nextTitle;
      }
      titleEl.dataset.kaiEpisodeLocalized = "zh";
    }

    if (localized.overview) {
      const infoContainer = episodeEl.querySelector(SELECTORS.INFO_CONTAINER);
      if (!infoContainer) return;

      let descEl = infoContainer.querySelector(SELECTORS.DESCRIPTION);
      if (!descEl) {
        descEl = document.createElement("p");
        descEl.className = SELECTORS.DESCRIPTION.slice(1);
        infoContainer.appendChild(descEl);
      }

      if (descEl.textContent !== localized.overview) {
        descEl.textContent = localized.overview;
      }
      descEl.dataset.kaiEpisodeLocalized = "zh";
    }
  }

  async function localizeVisibleEpisodes() {
    const serial = ++runSerial;

    if (!isChineseMode()) return;

    const container = document.querySelector(SELECTORS.EPISODES_CONTAINER);
    if (!container) return;

    const routeInfo = getRouteInfo();
    if (!routeInfo) return;

    const tmdbId = await resolveTmdbId(routeInfo);
    if (!tmdbId || serial !== runSerial) return;

    const episodeIndex = await fetchEpisodeIndex(tmdbId);
    if (serial !== runSerial) return;

    const episodeItems = Array.from(
      container.querySelectorAll(SELECTORS.EPISODE_ITEM),
    )
      .map((element) => ({
        element,
        number: getEpisodeNumber(element),
        title: getEpisodeTitle(element),
        airDate: getEpisodeAirDate(element),
      }))
      .filter((item) => Number.isFinite(item.number));

    await mapWithConcurrency(episodeItems, CONCURRENCY, async (item) => {
      const coordinates = findBestCoordinates(
        episodeIndex,
        routeInfo.season,
        item.number,
        item.title,
        item.airDate,
      );

      const localized = await fetchEpisodeTranslation(
        tmdbId,
        coordinates.season,
        coordinates.episode,
      );

      if (serial !== runSerial) return;
      applyTranslation(item.element, item.number, localized);
    });
  }

  function scheduleLocalize(delay = 180) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      localizeVisibleEpisodes().catch((error) => {
        console.debug("[Episode Localizer] Update failed:", error);
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
            (node.matches?.(SELECTORS.EPISODE_ITEM) ||
              node.querySelector?.(SELECTORS.EPISODE_ITEM) ||
              node.matches?.(SELECTORS.DESCRIPTION) ||
              node.querySelector?.(SELECTORS.DESCRIPTION)),
        );
      });

      if (relevant) scheduleLocalize();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 250);
      return;
    }

    initObserver();
    window.addEventListener("hashchange", () => scheduleLocalize(100));
    window.addEventListener("metadata-updated", () => scheduleLocalize(100));
    document.body.addEventListener("click", () => scheduleLocalize(250), true);
    scheduleLocalize(300);
  }

  window.KaiEpisodeLocalizer = {
    initialized: true,
    refresh: () => scheduleLocalize(0),
    clearCache: () => {
      translationCache.clear();
      episodeIndexCache.clear();
    },
    get cacheSize() {
      return translationCache.size;
    },
    get indexCacheSize() {
      return episodeIndexCache.size;
    },
  };

  init();
})();
