type SvgCarrier = {
  url: string;
  carrier: HTMLSourceElement | HTMLImageElement;
  apply: (url: string) => void;
};

(() => {
  const root = document.documentElement;
  const browserTheme = matchMedia("(prefers-color-scheme: dark)");
  const isI18n = Boolean(document.getElementById("i18n-data"));

  let readmeElement: HTMLElement | null = null;
  let localRun = 0;
  let postprocessFrame = 0;
  let isPendingSync = false;

  const srcCache: Map<string, Promise<string | null>> = new Map<
    string,
    Promise<string | null>
  >();
  const localCache: Map<string, string | null> = new Map<
    string,
    string | null
  >();
  const activeObjectUrls: Set<string> = new Set<string>();
  let svgObserver: IntersectionObserver | null = null;

  const getReadme = (): HTMLElement | null => {
    if (readmeElement?.isConnected) return readmeElement;

    const found = document.querySelector(".gh-readme");
    readmeElement = found instanceof HTMLElement ? found : null;
    return readmeElement;
  };

  const activeReadmeImageTheme = () => {
    const fixedTone = root.dataset.fixedThemeTone;
    if (fixedTone === "dark" || fixedTone === "light") {
      return browserTheme.matches ? "dark" : "light";
    }

    return root.classList.contains("dark") ? "dark" : "light";
  };

  const syncReadmeThemeImages = () => {
    const theme = activeReadmeImageTheme();
    root.dataset.readmeImageTheme = theme;

    const readme = getReadme();
    if (!readme) return;

    for (const image of readme.querySelectorAll(
      'img[src*=".svg" i], img[data-i18n-svg-source]',
    )) {
      if (image instanceof HTMLImageElement) {
        image.style.colorScheme = theme;
      }
    }

    for (const source of readme.querySelectorAll(
      'picture source[media*="prefers-color-scheme"], picture source[data-theme-media]',
    )) {
      if (!(source instanceof HTMLSourceElement)) continue;

      const originalMedia =
        source.dataset.themeMedia ?? source.getAttribute("media") ?? "";
      source.dataset.themeMedia = originalMedia;

      const wantsDark = /prefers-color-scheme\s*:\s*dark/i.test(originalMedia);
      const wantsLight = /prefers-color-scheme\s*:\s*light/i.test(
        originalMedia,
      );
      if (!wantsDark && !wantsLight) continue;

      const matches = wantsDark ? theme === "dark" : theme === "light";
      source.media = matches ? "all" : "not all";
    }
  };

  const localeNorm = (locale: string): string =>
    String(locale ?? "")
      .trim()
      .replaceAll("_", "-")
      .toLowerCase();

  const localeMatches = (systemLanguage: string, locale: string): boolean => {
    const requested = localeNorm(locale);
    if (!requested) return false;

    const requestedParts = requested.split("-");
    const requestedTags: string[] = [];
    for (let length = requestedParts.length; length >= 1; length -= 1) {
      requestedTags.push(requestedParts.slice(0, length).join("-"));
    }

    return String(systemLanguage ?? "")
      .split(",")
      .map((tag) => localeNorm(tag))
      .filter(Boolean)
      .some((tag) =>
        requestedTags.some(
          (requestedTag) =>
            tag === requestedTag ||
            tag.startsWith(`${requestedTag}-`) ||
            requestedTag.startsWith(`${tag}-`),
        ),
      );
  };

  const fetchSvg = (url: string): Promise<string | null> => {
    if (!srcCache.has(url)) {
      srcCache.set(
        url,
        fetch(url, { cache: "force-cache" })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            return response.text();
          })
          .catch((error) => {
            console.warn(`[README SVG i18n] Could not load ${url}:`, error);
            return null;
          }),
      );
      while (srcCache.size > 64) {
        const oldest: string | undefined = srcCache.keys().next().value;
        if (oldest === undefined) break;
        srcCache.delete(oldest);
      }
    }

    return srcCache.get(url) ?? Promise.resolve(null);
  };

  const applySvgLocale = (documentSvg: Document, locale: string): Document => {
    for (const switchElement of documentSvg.querySelectorAll("switch")) {
      const children = Array.from(switchElement.children);
      const selected = children.find((child) => {
        const systemLanguage = child.getAttribute("systemLanguage");
        return systemLanguage === null || localeMatches(systemLanguage, locale);
      });

      for (const child of children) {
        if (child !== selected) child.remove();
      }
      selected?.removeAttribute("systemLanguage");
    }

    for (const element of documentSvg.querySelectorAll("[systemLanguage]")) {
      const systemLanguage = element.getAttribute("systemLanguage");
      if (systemLanguage && localeMatches(systemLanguage, locale)) {
        element.removeAttribute("systemLanguage");
      } else {
        element.remove();
      }
    }

    const svg = documentSvg.documentElement;
    svg.setAttribute("lang", locale);
    svg.setAttribute("data-locale", locale);
    svg.setAttributeNS(
      "http://www.w3.org/XML/1998/namespace",
      "xml:lang",
      locale,
    );

    return documentSvg;
  };

  const localizeSvg = (source: string, locale: string): string | null => {
    if (!/\bsystemLanguage\s*=/i.test(source) && !/:lang\s*\(/i.test(source)) {
      return null;
    }

    const documentSvg = new DOMParser().parseFromString(
      source,
      "image/svg+xml",
    );
    if (documentSvg.querySelector("parsererror")) return null;

    return new XMLSerializer().serializeToString(
      applySvgLocale(documentSvg, locale),
    );
  };

  const syncInlineSvgLanguage = (
    readme: HTMLElement,
    locale: string,
    run: number,
  ): void => {
    const localeKey = localeNorm(locale);
    const svgs: NodeListOf<SVGSVGElement> =
      readme.querySelectorAll<SVGSVGElement>("svg");
    let idx = 0;
    const process = () => {
      if (run !== localRun) return;
      const end = Math.min(idx + 8, svgs.length);
      while (idx < end) {
        const svg = svgs[idx++];
        if (!svg?.isConnected || svg.dataset.i18nSvgLocale === localeKey)
          continue;
        if (
          !svg.querySelector("[systemLanguage]") &&
          !svg.outerHTML.includes(":lang(")
        )
          continue;
        const localized = localizeSvg(svg.outerHTML, locale);
        if (!localized) continue;
        const parsed = new DOMParser().parseFromString(
          localized,
          "image/svg+xml",
        );
        if (parsed.querySelector("parsererror")) continue;
        const replacement = document.importNode(parsed.documentElement, true);
        replacement.dataset.i18nSvgLocale = localeKey;
        svg.replaceWith(replacement);
      }
      if (idx < svgs.length) runWhenIdle(process);
    };
    runWhenIdle(process);
  };

  const firstSrcCandidate = (srcset: string): string =>
    String(srcset ?? "")
      .split(",")[0]
      ?.trim()
      .split(/\s+/)[0] ?? "";

  const svgCarriersForImage = (image: HTMLImageElement): SvgCarrier[] => {
    const carriers: SvgCarrier[] = [];
    const picture = image.closest("picture");

    if (picture) {
      for (const source of picture.querySelectorAll("source")) {
        if (!(source instanceof HTMLSourceElement)) continue;

        const original =
          source.dataset.i18nSvgSource || source.getAttribute("srcset") || "";
        const candidate = firstSrcCandidate(original);
        if (!candidate?.toLowerCase().includes(".svg")) {
          continue;
        }

        source.dataset.i18nSvgSource = original;
        carriers.push({
          url: new URL(candidate, document.baseURI).href,
          carrier: source,
          apply: (localizedUrl: string): void => {
            source.srcset = localizedUrl;
          },
        });
      }
    }

    const original =
      image.dataset.i18nSvgSource || image.getAttribute("src") || "";
    if (original.toLowerCase().includes(".svg")) {
      image.dataset.i18nSvgSource = original;

      if (/#gh-dark-mode-only(?:$|[?&])/i.test(original)) {
        image.dataset.ghThemeOnly = "dark";
      } else if (/#gh-light-mode-only(?:$|[?&])/i.test(original)) {
        image.dataset.ghThemeOnly = "light";
      }

      carriers.push({
        url: new URL(original, document.baseURI).href,
        carrier: image,
        apply: (localizedUrl: string): void => {
          image.src = localizedUrl;
        },
      });
    }

    return carriers;
  };

  const localUrl = async (
    url: string,
    locale: string,
  ): Promise<string | null> => {
    const variantKey = `${url}|${localeNorm(locale)}`;
    if (localCache.has(variantKey)) {
      return localCache.get(variantKey) ?? null;
    }

    const svgText = await fetchSvg(url);
    if (!svgText) {
      localCache.set(variantKey, null);
      return null;
    }

    const localized = localizeSvg(svgText, locale);
    if (!localized) {
      localCache.set(variantKey, null);
      return null;
    }

    const blobUrl = URL.createObjectURL(
      new Blob([localized], { type: "image/svg+xml" }),
    );
    localCache.set(variantKey, blobUrl);
    activeObjectUrls.add(blobUrl);
    return blobUrl;
  };

  const syncReadmeSvgLanguage = (): void => {
    if (!isI18n) return;

    const readme = getReadme();
    if (!readme) return;

    const run = ++localRun;
    const locale = root.dataset.locale || root.lang || "en";
    svgObserver?.disconnect();
    svgObserver = null;
    syncInlineSvgLanguage(readme, locale, run);

    const imgs: HTMLImageElement[] = Array.from(
      readme.querySelectorAll<HTMLImageElement>(
        'img[src*=".svg" i], img[data-i18n-svg-source], picture img',
      ),
    );
    const pending: HTMLImageElement[] = [];
    const queued: WeakSet<HTMLImageElement> = new WeakSet<HTMLImageElement>();
    let running = 0;
    const maxRunning = 3;

    const process = async (img: HTMLImageElement): Promise<void> => {
      if (run !== localRun || !img.isConnected) return;
      const carriers = svgCarriersForImage(img);
      for (const { url, carrier, apply } of carriers) {
        const localizedUrl = await localUrl(url, locale);
        if (run !== localRun || !img.isConnected || !carrier.isConnected)
          return;
        if (localizedUrl) apply(localizedUrl);
      }
      const theme = root.dataset.readmeImageTheme;
      if (theme === "light" || theme === "dark") img.style.colorScheme = theme;
    };

    const drain = () => {
      while (running < maxRunning && pending.length) {
        const img = pending.shift();
        if (!img || run !== localRun) continue;
        running += 1;
        void process(img).finally(() => {
          running -= 1;
          if (run === localRun) drain();
        });
      }
    };

    const queue = (img: HTMLImageElement): void => {
      if (queued.has(img) || run !== localRun) return;
      queued.add(img);
      pending.push(img);
      drain();
    };

    if ("IntersectionObserver" in window) {
      svgObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            svgObserver?.unobserve(entry.target);
            if (entry.target instanceof HTMLImageElement) queue(entry.target);
          }
        },
        { rootMargin: "400px 0px" },
      );
      for (const img of imgs) {
        if (img instanceof HTMLImageElement) svgObserver.observe(img);
      }
    } else {
      for (const img of imgs) {
        if (img instanceof HTMLImageElement) queue(img);
      }
    }
  };

  const copyIcon = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/>
            <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/>
          </svg>
        `;

  const checkIcon = `
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
            <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/>
          </svg>
        `;

  const addCopyButtons = () => {
    const readme = getReadme();
    if (!readme) return;

    for (const pre of readme.querySelectorAll("pre")) {
      if (pre.querySelector(".copy-code-button")) continue;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "copy-code-button";
      button.ariaLabel = "Copy code to clipboard";
      button.innerHTML = copyIcon;
      pre.append(button);
    }
  };

  const scheduleReadmePostprocess = (withSvg = false) => {
    isPendingSync ||= withSvg;
    if (postprocessFrame) return;

    postprocessFrame = requestAnimationFrame(() => {
      postprocessFrame = 0;
      const shouldSyncSvg = isPendingSync;
      isPendingSync = false;

      syncReadmeThemeImages();
      addCopyButtons();

      if (shouldSyncSvg) {
        void syncReadmeSvgLanguage();
      }
    });
  };

  const runWhenIdle = (callback: () => void): void => {
    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(callback, { timeout: 1000 });
    } else {
      setTimeout(callback, 0);
    }
  };

  const initialReadmeSetup = () => {
    scheduleReadmePostprocess(false);

    if (isI18n) {
      runWhenIdle(() => {
        scheduleReadmePostprocess(true);
      });
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialReadmeSetup, {
      once: true,
    });
  } else {
    initialReadmeSetup();
  }

  window.addEventListener("i18n-before-readme", () => {
    localRun += 1;
    svgObserver?.disconnect();
    const activeLocale = localeNorm(root.dataset.locale || root.lang || "en");
    setTimeout(() => {
      const used: Set<string> = new Set<string>();
      for (const el of document.querySelectorAll(
        ".gh-readme img, .gh-readme source",
      )) {
        const src = el.getAttribute("src");
        const srcset = el.getAttribute("srcset");
        if (src?.startsWith("blob:")) used.add(src);
        if (srcset?.startsWith("blob:")) used.add(srcset);
      }
      for (const [key, url] of localCache) {
        if (key.endsWith(`|${activeLocale}`) || !url || used.has(url)) continue;
        URL.revokeObjectURL(url);
        activeObjectUrls.delete(url);
        localCache.delete(key);
      }
    }, 3000);
  });

  window.addEventListener("i18n-toggle-readme", () => {
    scheduleReadmePostprocess(true);
  });

  window.addEventListener("readme-theme-change", () => {
    scheduleReadmePostprocess(false);
  });

  browserTheme.addEventListener("change", () => {
    if (root.dataset.fixedThemeTone) {
      scheduleReadmePostprocess(false);
    }
  });

  document.addEventListener("click", async (event) => {
    const button =
      event.target instanceof Element
        ? event.target.closest(".copy-code-button")
        : null;
    if (!(button instanceof HTMLButtonElement)) return;

    const pre = button.closest("pre");
    if (!pre) return;

    const text =
      pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
    try {
      await navigator.clipboard.writeText(text);

      button.innerHTML = checkIcon;
      button.ariaLabel = "Code copied";
      button.classList.add("copied");

      setTimeout(() => {
        if (!button.isConnected) return;
        button.innerHTML = copyIcon;
        button.ariaLabel = "Copy code to clipboard";
        button.classList.remove("copied");
      }, 2000);
    } catch (error) {
      console.error("Failed to copy code:", error);
    }
  });

  window.addEventListener(
    "pagehide",
    () => {
      localRun += 1;
      svgObserver?.disconnect();

      if (postprocessFrame) {
        cancelAnimationFrame(postprocessFrame);
        postprocessFrame = 0;
      }

      for (const url of activeObjectUrls) {
        URL.revokeObjectURL(url);
      }
      activeObjectUrls.clear();
      localCache.clear();
    },
    { once: true },
  );
})();

export {};
