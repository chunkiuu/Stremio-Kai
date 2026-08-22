/**
 * @name Continue Watching Localizer
 * @description Localizes Continue Watching card titles and posters with TMDB Chinese metadata.
 *
 * Text fallback order:
 *   zh-HK -> zh-TW -> zh-MO/generic Chinese -> zh-CN -> zh-SG -> English
 *
 * TMDB image language is ISO-639-1 only, so posters use:
 *   Chinese (zh) -> English (en) -> keep Stremio artwork
 */
(function () {
  "use strict";

  if (window.KaiContinueWatchingLocalizer?.initialized) return;

  const API_BASE = "https://api.themoviedb.org/3";
  const IMAGE_BASE = "https://image.tmdb.org/t/p/";
  const FETCH_TIMEOUT_MS = 8000;
  const CONCURRENCY = 4;
  const SCAN_DELAY_MS = 220;
  const STANDARD_CATALOG_CONTAINERS =
    ".meta-items-container-n8vNz, .meta-items-container-qcuUA, .meta-items-container-IKrND";
  const POSTER_SELECTOR =
    "img.poster-image-NiV7O, .poster-container-qkw48 img, img[src*='poster']";

  const metadataCache = new Map();
  const idCache = new Map();
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

  function normalizeTranslation(entry) {
    if (!entry?.iso_639_1) return null;
    const lang = String(entry.iso_639_1).toLowerCase();
    const region = String(entry.iso_3166_1 || "").toUpperCase();
    const data = entry.data || {};
    return {
      lang,
      region,
      title: String(data.title || data.name || "").trim(),
    };
  }

  function translationRank(entry) {
    if (entry.lang === "zh") {
      if (entry.region === "HK") return 0;
      if (entry.region === "TW") return 1;
      if (entry.region === "MO" || entry.region === "") return 2;
      if (entry.region !== "CN" && entry.region !== "SG") return 2;
      if (entry.region === "CN") return 3;
      if (entry.region === "SG") return 4;
    }
    if (entry.lang === "en") return 5;
    return 99;
  }

  function selectLocalizedTitle(translations) {
    return (Array.isArray(translations) ? translations : [])
      .map(normalizeTranslation)
      .filter(Boolean)
      .sort((a, b) => translationRank(a) - translationRank(b))
      .filter((entry) => translationRank(entry) < 99)
      .map((entry) => entry.title)
      .find(Boolean) || null;
  }

  function imagePopularity(image) {
    const votes = Number(image?.vote_count || 0);
    const avg = Number(image?.vote_average || 0);
    return avg * Math.max(votes, 1);
  }

  function selectPoster(images) {
    const list = Array.isArray(images) ? images.filter((img) => img?.file_path) : [];
    if (!list.length) return null;
    const sortBest = (arr) =>
      [...arr].sort((a, b) => imagePopularity(b) - imagePopularity(a));
    const chinese = sortBest(list.filter((img) => img.iso_639_1 === "zh"))[0];
    const english = sortBest(list.filter((img) => img.iso_639_1 === "en"))[0];
    const selected = chinese || english || null;
    return selected ? `${IMAGE_BASE}w500${selected.file_path}` : null;
  }

  function extractImdbId(item, poster) {
    const values = [
      item.id,
      item.getAttribute?.("data-id"),
      item.getAttribute?.("data-video-id"),
      item.getAttribute?.("data-meta-id"),
      item.getAttribute?.("aria-label"),
      item.getAttribute?.("title"),
      item.closest?.("a[href]")?.getAttribute("href"),
      item.querySelector?.("a[href]")?.getAttribute("href"),
      poster?.src,
      poster?.getAttribute?.("data-src"),
    ];

    for (const value of values) {
      const match = String(value || "").match(/tt\d{7,}/i);
      if (match) return match[0];
    }
    return null;
  }

  function inferTypeFromHref(item) {
    const href =
      item.closest?.("a[href]")?.getAttribute("href") ||
      item.querySelector?.("a[href]")?.getAttribute("href") ||
      "";
    if (/\/detail\/series\//i.test(href) || /\/series\//i.test(href)) return "series";
    if (/\/detail\/movie\//i.test(href) || /\/movie\//i.test(href)) return "movie";
    return null;
  }

  async function resolveTmdbIdentity(imdbId, hintedType) {
    if (!imdbId) return null;
    const cacheKey = `${hintedType || "unknown"}:${imdbId}`;
    if (idCache.has(cacheKey)) return idCache.get(cacheKey);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return null;

      if (hintedType) {
        const fetcher = window.MetadataModules?.tmdbFetcher;
        if (fetcher?.convertToTmdbId && fetcher?.isAvailable?.()) {
          try {
            const id = await fetcher.convertToTmdbId(imdbId, hintedType);
            if (id) return { tmdbId: id, type: hintedType };
          } catch (_) {}
        }
      }

      const url = `${API_BASE}/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`;
      try {
        const result = await fetchUtils.makeRequest(url, { timeout: FETCH_TIMEOUT_MS });
        if (!result?.ok) return null;
        const data = result.data || {};

        if (hintedType === "series" && data.tv_results?.[0]?.id) {
          return { tmdbId: data.tv_results[0].id, type: "series" };
        }
        if (hintedType === "movie" && data.movie_results?.[0]?.id) {
          return { tmdbId: data.movie_results[0].id, type: "movie" };
        }
        if (data.tv_results?.[0]?.id && !data.movie_results?.[0]?.id) {
          return { tmdbId: data.tv_results[0].id, type: "series" };
        }
        if (data.movie_results?.[0]?.id && !data.tv_results?.[0]?.id) {
          return { tmdbId: data.movie_results[0].id, type: "movie" };
        }
        const tv = data.tv_results?.[0] || null;
        const movie = data.movie_results?.[0] || null;
        if (tv && movie) {
          return Number(tv.popularity || 0) >= Number(movie.popularity || 0)
            ? { tmdbId: tv.id, type: "series" }
            : { tmdbId: movie.id, type: "movie" };
        }
        return null;
      } catch (error) {
        console.debug(`[Continue Localizer] TMDB ID lookup failed for ${imdbId}:`, error);
        return null;
      }
    })();

    idCache.set(cacheKey, promise);
    return promise;
  }

  async function fetchLocalizedMetadata(identity) {
    if (!identity?.tmdbId || !identity?.type) return null;
    const key = `${identity.type}:${identity.tmdbId}`;
    if (metadataCache.has(key)) return metadataCache.get(key);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return null;
      const mediaType = identity.type === "series" ? "tv" : "movie";
      const url = `${API_BASE}/${mediaType}/${identity.tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=zh-HK&append_to_response=translations,images&include_image_language=zh,en,null`;

      try {
        const result = await fetchUtils.makeRequest(url, { timeout: FETCH_TIMEOUT_MS });
        if (!result?.ok) {
          if (result?.status === 429) {
            window.MetadataModules?.apiKeys?.markRateLimited?.("TMDB");
          }
          return null;
        }
        const data = result.data || {};
        const translations = data.translations?.translations || [];
        return {
          title:
            selectLocalizedTitle(translations) || data.title || data.name || null,
          poster: selectPoster(data.images?.posters),
        };
      } catch (error) {
        console.debug(`[Continue Localizer] TMDB metadata failed for ${key}:`, error);
        return null;
      }
    })();

    metadataCache.set(key, promise);
    return promise;
  }

  function findVisibleTitleNode(item) {
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    const candidates = [];
    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest(".poster-container-qkw48")) continue;
      if (parent.closest(".kai-english-original-title")) continue;
      const text = (node.nodeValue || "").trim();
      if (!text) continue;
      if (/^(watched|unwatched|play|resume)$/i.test(text)) continue;
      if (/^\d+(?:[.:/%-]\d+)*$/.test(text)) continue;
      candidates.push({ node, text });
    }

    return candidates.sort((a, b) => b.text.length - a.text.length)[0] || null;
  }

  function applyTitle(item, localizedTitle) {
    if (!localizedTitle) return;

    let originalTitle = item.dataset.kaiOriginalTitle || "";
    const candidate = findVisibleTitleNode(item);

    if (!originalTitle && candidate?.text) {
      originalTitle = candidate.text;
      item.dataset.kaiOriginalTitle = originalTitle;
    }

    if (!candidate) return;

    if (candidate.text !== localizedTitle) {
      candidate.node.nodeValue = candidate.node.nodeValue.replace(candidate.text, localizedTitle);
    }

    item.dataset.kaiLocalizedTitle = localizedTitle;
    if (item.getAttribute?.("title") != null && item.getAttribute("title") !== localizedTitle) {
      item.setAttribute("title", localizedTitle);
    }
  }

  function applyPoster(poster, localizedPoster) {
    if (!poster || !localizedPoster) return;
    if (!poster.dataset.kaiOriginalPoster) {
      poster.dataset.kaiOriginalPoster = poster.currentSrc || poster.src || "";
    }

    if (poster.src !== localizedPoster) poster.src = localizedPoster;
    if (poster.getAttribute("srcset")) poster.removeAttribute("srcset");
    if (poster.hasAttribute("data-src")) poster.setAttribute("data-src", localizedPoster);
    poster.closest("picture")?.querySelectorAll("source[srcset]").forEach((source) => {
      source.removeAttribute("srcset");
    });
    poster.dataset.kaiLocalizedPoster = localizedPoster;
  }

  function getContinueWatchingCards() {
    const cards = [];
    document.querySelectorAll("div[tabindex]").forEach((item) => {
      if (item.closest(".video-container-ezBpK")) return;
      if (item.closest(STANDARD_CATALOG_CONTAINERS)) return;
      if (item.closest(".metadata-hover-popup")) return;
      const poster = item.querySelector?.(POSTER_SELECTOR);
      if (!poster) return;
      cards.push({ item, poster });
    });
    return cards;
  }

  async function processCard(card) {
    const { item, poster } = card;
    if (!item?.isConnected || !poster) return;

    const imdbId = extractImdbId(item, poster);
    if (!imdbId) return;

    const hintedType = inferTypeFromHref(item);
    const identity = await resolveTmdbIdentity(imdbId, hintedType);
    if (!identity || !item.isConnected) return;

    item.dataset.kaiContentType = identity.type;
    item.dataset.kaiImdbId = imdbId;

    const localized = await fetchLocalizedMetadata(identity);
    if (!localized || !item.isConnected) return;

    if (localized.title) applyTitle(item, localized.title);
    if (localized.poster) applyPoster(poster, localized.poster);
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

  async function scan() {
    const serial = ++scanSerial;
    if (!isChineseMode() || !getApiKey()) return;

    const cards = getContinueWatchingCards();
    await mapWithConcurrency(cards, CONCURRENCY, async (card) => {
      if (serial !== scanSerial) return;
      await processCard(card);
    });

    window.KaiEnglishOriginalTitleCompanion?.refresh?.();
  }

  function scheduleScan(delay = SCAN_DELAY_MS) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      scan().catch((error) =>
        console.debug("[Continue Localizer] Scan failed:", error),
      );
    }, delay);
  }

  function initObserver() {
    if (!document.body || observer) return;
    observer = new MutationObserver((mutations) => {
      if (!isChineseMode()) return;
      const relevant = mutations.some(
        (mutation) =>
          mutation.type === "childList" &&
          (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0),
      );
      if (relevant) scheduleScan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function init() {
    if (!document.body) {
      setTimeout(init, 250);
      return;
    }
    initObserver();
    window.addEventListener("hashchange", () => scheduleScan(100));
    window.addEventListener("metadata-modules-ready", () => scheduleScan(120));
    document.body.addEventListener("click", () => scheduleScan(300), true);
    scheduleScan(700);
  }

  window.KaiContinueWatchingLocalizer = {
    initialized: true,
    refresh: () => scheduleScan(0),
    clearCache: () => {
      metadataCache.clear();
      idCache.clear();
    },
    get cacheSize() {
      return metadataCache.size;
    },
  };

  init();
})();
