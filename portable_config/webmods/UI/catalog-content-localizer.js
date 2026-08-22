/**
 * @name Catalog Content Localizer
 * @description Localizes Stremio catalog cards and Hero Banner with Chinese TMDB metadata.
 *
 * Text fallback order:
 *   1. zh-HK
 *   2. zh-TW
 *   3. zh-MO / regionless / other Chinese
 *   4. zh-CN
 *   5. zh-SG
 *   6. English
 *
 * Poster/logo note:
 * TMDB currently tags images with ISO-639-1 only, so it cannot distinguish
 * zh-HK vs zh-TW vs zh-CN artwork. For images the closest enforceable order is:
 *   Chinese (zh) -> English (en) -> keep the existing artwork.
 */
(function () {
  "use strict";

  if (window.KaiCatalogContentLocalizer?.initialized) return;

  const API_BASE = "https://api.themoviedb.org/3";
  const IMAGE_BASE = "https://image.tmdb.org/t/p/";
  const FETCH_TIMEOUT_MS = 8000;
  const CONCURRENCY = 4;
  const SCAN_DELAY_MS = 220;

  const SELECTORS = {
    CATALOG_CONTAINERS:
      ".meta-items-container-n8vNz, .meta-items-container-qcuUA, .meta-items-container-IKrND",
    POSTER: "img.poster-image-NiV7O",
    POSTER_GENERIC: 'img[src*="poster"], .poster-container-qkw48 img',
  };

  const metadataCache = new Map();
  let observer = null;
  let debounceTimer = null;
  let scanSerial = 0;

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

  function escapeHTML(value) {
    if (typeof value !== "string") return value;
    return value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#x27;");
  }

  function normalizeTranslation(entry) {
    if (!entry || !entry.iso_639_1) return null;
    const lang = String(entry.iso_639_1).toLowerCase();
    const region = String(entry.iso_3166_1 || "").toUpperCase();
    const data = entry.data || {};

    return {
      lang,
      region,
      title:
        typeof data.title === "string"
          ? data.title.trim()
          : typeof data.name === "string"
            ? data.name.trim()
            : "",
      overview: typeof data.overview === "string" ? data.overview.trim() : "",
      tagline: typeof data.tagline === "string" ? data.tagline.trim() : "",
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

  function selectLocalizedField(translations, field) {
    return (Array.isArray(translations) ? translations : [])
      .map(normalizeTranslation)
      .filter(Boolean)
      .sort((a, b) => translationRank(a) - translationRank(b))
      .filter((entry) => translationRank(entry) < 99)
      .map((entry) => entry[field])
      .find((value) => typeof value === "string" && value.trim()) || null;
  }

  function imagePopularity(image) {
    const votes = Number(image?.vote_count || 0);
    const avg = Number(image?.vote_average || 0);
    return avg * Math.max(votes, 1);
  }

  function selectImage(images, type) {
    const list = Array.isArray(images) ? images.filter((img) => img?.file_path) : [];
    if (!list.length) return null;

    const size = type === "logo" ? "original" : "w500";
    const sortBest = (arr) => [...arr].sort((a, b) => imagePopularity(b) - imagePopularity(a));

    // TMDB image language is ISO-639-1 only. All regional Chinese artwork is "zh".
    const chinese = sortBest(list.filter((img) => img.iso_639_1 === "zh"))[0];
    const english = sortBest(list.filter((img) => img.iso_639_1 === "en"))[0];
    const selected = chinese || english || null;

    return selected ? `${IMAGE_BASE}${size}${selected.file_path}` : null;
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
    if (/^tt\d+$/i.test(rawId)) return { type, imdbId: rawId, tmdbId: null };
    if (/^tmdb:\d+$/i.test(rawId)) {
      return { type, imdbId: null, tmdbId: Number(rawId.replace(/^tmdb:/i, "")) };
    }
    return { type, imdbId: null, tmdbId: null };
  }

  function parseCatalogItem(item) {
    const href = item.getAttribute?.("href") || item.closest?.("a[href]")?.getAttribute("href") || "";
    let info = parseDetailHref(href);

    const poster =
      item.querySelector?.(SELECTORS.POSTER) ||
      item.querySelector?.(SELECTORS.POSTER_GENERIC) ||
      null;

    if (!info) {
      const id = item.id || item.closest?.("[id]")?.id || "";
      if (/^tt\d+$/i.test(id)) info = { type: null, imdbId: id, tmdbId: null };
      else if (/^tmdb:\d+$/i.test(id)) {
        info = { type: null, imdbId: null, tmdbId: Number(id.replace(/^tmdb:/i, "")) };
      }
    }

    if (!info && poster?.src) {
      const imdbMatch = poster.src.match(/tt\d{7,}/i);
      if (imdbMatch) info = { type: null, imdbId: imdbMatch[0], tmdbId: null };
    }

    if (!info) return null;

    if (!info.type) {
      const anyHref = href || "";
      if (/\/series\//i.test(anyHref)) info.type = "series";
      else if (/\/movie\//i.test(anyHref)) info.type = "movie";
    }

    return { ...info, poster };
  }

  async function resolveTmdbId(info) {
    if (Number.isFinite(info.tmdbId)) return info.tmdbId;
    if (!info.imdbId || !info.type) return null;

    const tmdbFetcher = getTmdbFetcher();
    if (!tmdbFetcher?.convertToTmdbId || !tmdbFetcher?.isAvailable?.()) return null;
    return tmdbFetcher.convertToTmdbId(info.imdbId, info.type);
  }

  async function fetchLocalizedMetadata(info) {
    const tmdbId = await resolveTmdbId(info);
    if (!tmdbId || !info.type) return null;

    const key = `${info.type}:${tmdbId}`;
    if (metadataCache.has(key)) return metadataCache.get(key);

    const promise = (async () => {
      const apiKey = getApiKey();
      const fetchUtils = getFetchUtils();
      if (!apiKey || !fetchUtils?.makeRequest) return null;

      const mediaType = info.type === "series" ? "tv" : "movie";
      const url = `${API_BASE}/${mediaType}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&language=zh-HK&append_to_response=translations,images&include_image_language=zh,en,null`;

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
        const title =
          selectLocalizedField(translations, "title") ||
          data.title ||
          data.name ||
          null;
        const overview =
          selectLocalizedField(translations, "overview") || data.overview || null;
        const tagline =
          selectLocalizedField(translations, "tagline") || data.tagline || null;

        return {
          tmdbId,
          title,
          overview,
          tagline,
          poster: selectImage(data.images?.posters, "poster"),
          logo: selectImage(data.images?.logos, "logo"),
        };
      } catch (error) {
        console.debug(`[Catalog Localizer] TMDB fetch failed for ${key}:`, error);
        return null;
      }
    })();

    metadataCache.set(key, promise);
    return promise;
  }

  function findOriginalTitle(item, poster) {
    if (item.dataset.kaiOriginalTitle) return item.dataset.kaiOriginalTitle;

    const candidates = [
      item.getAttribute?.("title"),
      poster?.getAttribute?.("alt"),
      item.getAttribute?.("aria-label"),
    ];

    const original = candidates.find(
      (value) =>
        typeof value === "string" &&
        value.trim() &&
        !/^(poster|image|thumbnail)$/i.test(value.trim()),
    );

    if (original) {
      item.dataset.kaiOriginalTitle = original.trim();
      return original.trim();
    }

    // Last-resort DOM fallback for builds that do not expose a title/alt attribute.
    // Prefer a meaningful leaf text node outside the poster overlay.
    const textCandidates = [];
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNode.parentElement?.closest?.(".poster-container-qkw48")) continue;
      const value = (textNode.nodeValue || "").trim();
      if (!value || /^(watched|unwatched|play)$/i.test(value)) continue;
      if (/^\d+(?:[.:/%-]\d+)*$/.test(value)) continue;
      textCandidates.push(value);
    }

    const fallback = textCandidates.sort((a, b) => b.length - a.length)[0] || null;
    if (fallback) item.dataset.kaiOriginalTitle = fallback;
    return fallback;
  }

  function replaceVisibleTitle(item, originalTitle, localizedTitle) {
    if (!localizedTitle || localizedTitle === originalTitle) return;

    const normalizedOriginal = (originalTitle || "").trim();
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    let replaced = false;
    for (const textNode of nodes) {
      const value = (textNode.nodeValue || "").trim();
      if (!value) continue;

      // Do not rewrite watched/progress overlays inside the poster itself.
      if (textNode.parentElement?.closest?.(".poster-container-qkw48")) continue;

      if (normalizedOriginal && value === normalizedOriginal) {
        textNode.nodeValue = textNode.nodeValue.replace(normalizedOriginal, localizedTitle);
        replaced = true;
      }
    }

    // Some builds expose the title only through the card's title/aria attributes.
    if (item.getAttribute?.("title")) item.setAttribute("title", localizedTitle);
    if (item.getAttribute?.("aria-label") === normalizedOriginal) {
      item.setAttribute("aria-label", localizedTitle);
    }

    if (replaced) item.dataset.kaiLocalizedTitle = localizedTitle;
  }

  function applyPoster(poster, localizedPoster) {
    if (!poster || !localizedPoster) return;
    if (!poster.dataset.kaiOriginalPoster) poster.dataset.kaiOriginalPoster = poster.src || "";
    if (poster.src === localizedPoster) return;

    poster.src = localizedPoster;
    poster.removeAttribute("srcset");
    poster.dataset.kaiLocalizedPoster = localizedPoster;
  }

  async function localizeCatalogItem(item) {
    if (!item?.isConnected) return;
    const info = parseCatalogItem(item);
    if (!info || !info.type || (!info.imdbId && !info.tmdbId)) return;

    const localized = await fetchLocalizedMetadata(info);
    if (!localized || !item.isConnected) return;

    const originalTitle = findOriginalTitle(item, info.poster);
    if (localized.title) {
      replaceVisibleTitle(item, originalTitle, localized.title);
    }
    if (localized.poster) applyPoster(info.poster, localized.poster);
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

  function getCatalogItems() {
    const results = new Set();
    document.querySelectorAll(SELECTORS.CATALOG_CONTAINERS).forEach((container) => {
      container.querySelectorAll("a, div[tabindex]").forEach((item) => {
        if (
          item.querySelector?.(SELECTORS.POSTER) ||
          item.querySelector?.(SELECTORS.POSTER_GENERIC) ||
          item.getAttribute?.("href")?.includes("/detail/")
        ) {
          results.add(item);
        }
      });
    });
    return Array.from(results);
  }

  async function localizeHero() {
    const state = window.HeroPlugin?.State;
    const ui = window.HeroPlugin?.UI;
    const titles = state?.heroTitles;
    if (!Array.isArray(titles) || titles.length === 0 || !ui?.updateHeroContent) return;

    const index = Number(state.currentIndex || 0);
    const current = titles[index];
    if (!current) return;

    const info = {
      type: current.type === "series" ? "series" : "movie",
      imdbId: typeof current.imdb === "string" && /^tt\d+$/i.test(current.imdb) ? current.imdb : null,
      tmdbId:
        current.tmdbId != null && Number.isFinite(Number(current.tmdbId))
          ? Number(current.tmdbId)
          : null,
    };
    if (!info.imdbId && !info.tmdbId) return;

    const localized = await fetchLocalizedMetadata(info);
    if (!localized) return;

    let changed = false;
    if (localized.title) {
      const safeTitle = escapeHTML(localized.title);
      if (current.title !== safeTitle) {
        current.title = safeTitle;
        current.extractedTitle = safeTitle;
        changed = true;
      }
    }
    if (localized.overview) {
      const safePlot = escapeHTML(localized.overview);
      if (current.plot !== safePlot) {
        current.plot = safePlot;
        changed = true;
      }
    }
    if (localized.tagline) {
      const safeTagline = escapeHTML(localized.tagline);
      if (current.tagline !== safeTagline) {
        current.tagline = safeTagline;
        changed = true;
      }
    }
    if (localized.logo && current.logo !== localized.logo) {
      current.logo = localized.logo;
      changed = true;
    }

    if (changed) ui.updateHeroContent(current, false);
    localizeHeroChrome();
  }

  function localizeHeroChrome() {
    const meta = document.querySelector("#heroMetaRow .hero-meta-text");
    if (meta?.textContent) {
      meta.textContent = meta.textContent
        .replace(/\b(\d+)\s+Seasons?\b/gi, "$1 季")
        .replace(/\b(\d+)\s+Episodes?\b/gi, "$1 集")
        .replace(/\bMovie\b/gi, "電影")
        .replace(/\b(\d+)\s*min\b/gi, "$1 分鐘")
        .replace(/Ongoing/gi, "連載中");
    }

    const watchButton = document.querySelector(".hero-overlay-button-watch");
    if (watchButton) {
      const textNodes = Array.from(watchButton.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE);
      for (const node of textNodes) {
        if ((node.nodeValue || "").includes("Watch Now")) {
          node.nodeValue = node.nodeValue.replace("Watch Now", "立即觀看");
        }
      }
    }
  }

  async function scan() {
    const serial = ++scanSerial;
    if (!isChineseMode()) return;
    if (!getApiKey()) return;

    const items = getCatalogItems();
    await Promise.all([
      mapWithConcurrency(items, CONCURRENCY, async (item) => {
        if (serial !== scanSerial) return;
        await localizeCatalogItem(item);
      }),
      localizeHero(),
    ]);
  }

  function scheduleScan(delay = SCAN_DELAY_MS) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      scan().catch((error) => console.debug("[Catalog Localizer] Scan failed:", error));
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
    window.addEventListener("metadata-modules-ready", () => scheduleScan(100));
    document.body.addEventListener("click", () => scheduleScan(300), true);

    // Hero slides change without necessarily changing route; this light poll only
    // reuses cached metadata after the first request.
    setInterval(() => {
      if (isChineseMode()) localizeHero().catch(() => {});
    }, 1200);

    scheduleScan(500);
  }

  window.KaiCatalogContentLocalizer = {
    initialized: true,
    refresh: () => scheduleScan(0),
    clearCache: () => metadataCache.clear(),
    get cacheSize() {
      return metadataCache.size;
    },
  };

  init();
})();
