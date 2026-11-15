import type { ThemeModalTrans } from "../lib/i18n";

type LocaleEntry = { locale: string; localeNorm: string };
type LocaleInfo = { language: string; script: string };
type Translation = {
  locale: string;
  localeNorm: string;
  title: string;
  tagline: string;
  themeModal: ThemeModalTrans;
  readmeHTML: string;
  version?: string;
};

(() => {
  const root = document.documentElement;
  try {
    const payloadElement = document.getElementById("i18n-data");
    if (!payloadElement) return;
    const parsed: unknown = JSON.parse(payloadElement.textContent ?? "{}");
    if (!parsed || typeof parsed !== "object") return;
    const payload: Record<string, unknown> = parsed as Record<string, unknown>;
    const localeNorm = (locale: unknown): string =>
      String(locale ?? "")
        .trim()
        .replaceAll("_", "-")
        .toLowerCase();

    const locales: LocaleEntry[] = (
      Array.isArray(payload.locales) ? payload.locales : []
    )
      .map(
        (locale: unknown): LocaleEntry => ({
          locale: String(locale ?? "")
            .trim()
            .replaceAll("_", "-"),
          localeNorm: localeNorm(locale),
        }),
      )
      .filter(({ localeNorm }: LocaleEntry): boolean => Boolean(localeNorm));

    if (locales.length <= 1) return;

    const localeMap: Map<string, LocaleEntry> = new Map<string, LocaleEntry>(
      locales.map((entry: LocaleEntry): [string, LocaleEntry] => [
        entry.localeNorm,
        entry,
      ]),
    );
    const isThemeModal = (value: unknown): value is ThemeModalTrans =>
      !!value &&
      typeof value === "object" &&
      typeof (value as Record<string, unknown>).title === "string" &&
      typeof (value as Record<string, unknown>).description === "string" &&
      typeof (value as Record<string, unknown>).mode === "string" &&
      typeof (value as Record<string, unknown>).style === "string" &&
      typeof (value as Record<string, unknown>).searchThemes === "string" &&
      typeof (value as Record<string, unknown>).previewTitle === "string" &&
      typeof (value as Record<string, unknown>).previewHTML === "string";
    const isTranslation = (
      value: unknown,
    ): value is Omit<Translation, "localeNorm"> => {
      if (!value || typeof value !== "object") return false;
      const doc: Record<string, unknown> = value as Record<string, unknown>;
      return (
        typeof doc.locale === "string" &&
        typeof doc.title === "string" &&
        typeof doc.tagline === "string" &&
        isThemeModal(doc.themeModal) &&
        typeof doc.readmeHTML === "string"
      );
    };
    const srcRaw: unknown = payload.source;
    const src: Translation | undefined = isTranslation(srcRaw)
      ? { ...srcRaw, localeNorm: localeNorm(srcRaw.locale) }
      : undefined;

    if (!src?.localeNorm) return;

    const srcEntry: LocaleEntry = localeMap.get(src.localeNorm) ?? {
      locale: src.locale,
      localeNorm: src.localeNorm,
    };
    if (!localeMap.has(src.localeNorm)) {
      locales.unshift(srcEntry);
      localeMap.set(src.localeNorm, srcEntry);
    }

    const transBase: string = String(payload.transBase ?? "");
    const transVersion =
      typeof src.version === "string" ? src.version.trim() : "";
    const transCache: Map<string, Promise<Translation | undefined>> = new Map<
      string,
      Promise<Translation | undefined>
    >([[src.localeNorm, Promise.resolve(src)]]);
    const readmeTemplateCache: Map<string, HTMLTemplateElement> = new Map<
      string,
      HTMLTemplateElement
    >();

    const compileReadmeTemplate = (translation: Translation): void => {
      const localeKey = translation?.localeNorm;
      if (!localeKey || readmeTemplateCache.has(localeKey)) return;

      const template = document.createElement("template");
      template.innerHTML = translation.readmeHTML;
      readmeTemplateCache.set(localeKey, template);
    };

    const scheduleReadmeTemplate = (translation: Translation): void => {
      if (!translation?.localeNorm) return;

      const compile = () => compileReadmeTemplate(translation);
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(compile, { timeout: 1200 });
      } else {
        setTimeout(compile, 0);
      }
    };

    scheduleReadmeTemplate(src);

    const localeCache: Map<string, LocaleInfo> = new Map<string, LocaleInfo>();
    const localeInfo = (locale: string): LocaleInfo => {
      const key = localeNorm(locale);
      const cached: LocaleInfo | undefined = localeCache.get(key);
      if (cached) return cached;

      let info = {
        language: "",
        script: "",
      };
      try {
        const parsed = new Intl.Locale(locale).maximize();
        info = {
          language: parsed.language.toLowerCase(),
          script: parsed.script?.toLowerCase() ?? "",
        };
      } catch {
        info = {
          language: key.split("-")[0] ?? "",
          script: "",
        };
      }

      localeCache.set(key, info);
      return info;
    };

    const localeMatch = (locale: string): LocaleEntry | undefined => {
      const requested = localeNorm(locale);
      if (!requested) return undefined;

      const exact = localeMap.get(requested);
      if (exact) return exact;

      const requestedInfo = localeInfo(requested);
      if (requestedInfo.script) {
        const scriptMatch = locales.find((entry: LocaleEntry): boolean => {
          const info = localeInfo(entry.locale);
          return (
            info.language === requestedInfo.language &&
            info.script === requestedInfo.script
          );
        });
        if (scriptMatch) return scriptMatch;
      }

      const parts = requested.split("-");
      for (let len = parts.length - 1; len >= 1; len -= 1) {
        const lessSpecific = localeMap.get(parts.slice(0, len).join("-"));
        if (lessSpecific) return lessSpecific;
      }

      return locales.find(
        (entry: LocaleEntry): boolean =>
          localeInfo(entry.locale).language === requestedInfo.language,
      );
    };

    const localeDir = (locale: string): "rtl" | "ltr" => {
      try {
        const script = new Intl.Locale(locale).maximize().script;
        if (
          script &&
          ["Adlm", "Arab", "Hebr", "Nkoo", "Rohg", "Syrc", "Thaa"].includes(
            script,
          )
        ) {
          return "rtl";
        }
      } catch {}

      return /^(?:ace-arab|acm|acq|aeb|ajp|apc|ar|ars|ary|arz|azb|ckb|fa|he|ks|ku-arab|ps|sd|ug|ur|yi)(?:-|$)/i.test(
        locale,
      )
        ? "rtl"
        : "ltr";
    };

    const loadTrans = (
      entry: LocaleEntry | undefined,
    ): Promise<Translation | undefined> => {
      if (!entry) return Promise.resolve(undefined);

      const cached = transCache.get(entry.localeNorm);
      if (cached) return cached;

      const transUrl = `${transBase}${encodeURIComponent(entry.locale)}.json${
        transVersion ? `?v=${encodeURIComponent(transVersion)}` : ""
      }`;
      const request = fetch(transUrl, { cache: "no-cache" })
        .then((res) => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((translation: unknown): Translation => {
          if (!translation || typeof translation !== "object")
            throw new Error("Invalid translation payload");
          const item: Record<string, unknown> = translation as Record<
            string,
            unknown
          >;
          if (
            localeNorm(item.locale) !== entry.localeNorm ||
            typeof item.title !== "string" ||
            typeof item.tagline !== "string" ||
            typeof item.readmeHTML !== "string" ||
            (item.themeModal !== undefined && !isThemeModal(item.themeModal))
          ) {
            throw new Error("Invalid translation payload");
          }
          const normalizedTranslation: Translation = {
            locale: entry.locale,
            title: item.title,
            tagline: item.tagline,
            themeModal: {
              ...src.themeModal,
              ...(isThemeModal(item.themeModal) ? item.themeModal : {}),
            },
            readmeHTML: item.readmeHTML,
            localeNorm: entry.localeNorm,
          };
          scheduleReadmeTemplate(normalizedTranslation);
          return normalizedTranslation;
        })
        .catch((error) => {
          transCache.delete(entry.localeNorm);
          console.warn(`[i18n] Could not load ${entry.locale}:`, error);
          return undefined;
        });

      transCache.set(entry.localeNorm, request);
      return request;
    };

    const followingLocale = (currentNorm: string): LocaleEntry => {
      const currentIndex = locales.findIndex(
        ({ localeNorm: entryNorm }: LocaleEntry): boolean =>
          entryNorm === currentNorm,
      );
      return locales[(currentIndex + 1) % locales.length] ?? srcEntry;
    };

    const warmFollowingLocale = (currentNorm: string): void => {
      const next = followingLocale(currentNorm);
      if (next.localeNorm !== src.localeNorm) {
        void loadTrans(next);
      }
    };

    const warmRemainingTranslations = (currentNorm: string): void => {
      const queue = locales.filter(
        ({ localeNorm: entryNorm }: LocaleEntry): boolean =>
          entryNorm !== currentNorm &&
          entryNorm !== src.localeNorm &&
          entryNorm !== followingLocale(currentNorm).localeNorm,
      );

      const warmNext = () => {
        const entry = queue.shift();
        if (!entry) return;

        void loadTrans(entry).finally(() => {
          if ("requestIdleCallback" in window) {
            window.requestIdleCallback(warmNext, { timeout: 1500 });
          } else {
            setTimeout(warmNext, 16);
          }
        });
      };

      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(warmNext, { timeout: 1500 });
      } else {
        setTimeout(warmNext, 0);
      }
    };

    const applyTrans = (
      translation: Translation,
      isReplaceReadme: boolean = false,
    ): void => {
      if (!translation) return;

      const locale = translation.locale;
      root.lang = locale;
      root.dir = localeDir(locale);
      root.dataset.locale = locale;
      root.dataset.appliedLocale = translation.localeNorm;
      document.title = translation.title;

      const ogTitle = document.querySelector('meta[property="og:title"]');
      if (ogTitle) {
        ogTitle.setAttribute("content", translation.title);
      }

      const taglines = document.querySelectorAll<HTMLElement>(
        "[data-i18n-tagline]",
      );
      const taglineValue = translation.tagline.trim();
      for (const tagline of taglines) {
        tagline.textContent = taglineValue;
        tagline.hidden = !taglineValue;
      }

      const setThemeModalText = (selector: string, value: string): void => {
        for (const element of document.querySelectorAll(selector)) {
          element.textContent = value;
        }
      };
      const themeModal = translation.themeModal;
      setThemeModalText("[data-i18n-theme-modal-title]", themeModal.title);
      setThemeModalText(
        "[data-i18n-theme-modal-description]",
        themeModal.description,
      );
      setThemeModalText("[data-i18n-theme-modal-mode]", themeModal.mode);
      setThemeModalText("[data-i18n-theme-modal-style]", themeModal.style);
      for (const input of document.querySelectorAll<HTMLInputElement>(
        "[data-i18n-theme-modal-search]",
      )) {
        input.setAttribute("aria-label", themeModal.searchThemes);
      }
      setThemeModalText(
        "[data-i18n-theme-modal-preview-title]",
        themeModal.previewTitle,
      );
      setThemeModalText(
        "[data-i18n-theme-palette]",
        themeModal.themePalette ?? src.themeModal.themePalette,
      );
      setThemeModalText(
        "[data-i18n-style-layers]",
        themeModal.styleLayers ?? src.themeModal.styleLayers,
      );
      for (const previewBody of document.querySelectorAll(
        "[data-i18n-theme-modal-preview-body]",
      )) {
        previewBody.innerHTML = themeModal.previewHTML;
      }

      const readme = document.querySelector("[data-i18n-readme]");
      if (readme && isReplaceReadme) {
        window.dispatchEvent(new Event("i18n-before-readme"));

        const template = readmeTemplateCache.get(translation.localeNorm);
        if (template instanceof HTMLTemplateElement) {
          readme.replaceChildren(template.content.cloneNode(true));
        } else {
          readme.innerHTML = translation.readmeHTML;
          scheduleReadmeTemplate(translation);
        }

        window.dispatchEvent(
          new CustomEvent("i18n-toggle-readme", {
            detail: { locale },
          }),
        );
      }
    };

    let savedLocale = "";
    try {
      savedLocale = localeNorm(localStorage.getItem("gh-profile-locale") ?? "");
    } catch {}

    const findBrowserLocale = (): LocaleEntry | undefined => {
      const browserLocales =
        Array.isArray(navigator.languages) && navigator.languages.length
          ? navigator.languages
          : [navigator.language];

      for (const browserLocale of browserLocales) {
        const matched = localeMatch(browserLocale);
        if (matched) return matched;
      }

      return undefined;
    };

    const savedLocaleEntry = (): LocaleEntry | undefined =>
      localeMatch(savedLocale);

    const findInitLocale = (): LocaleEntry =>
      savedLocaleEntry() ??
      findBrowserLocale() ??
      localeMatch(String(payload.defLanguage ?? "")) ??
      srcEntry;

    let selectedLocaleNorm = src.localeNorm;
    let selectionRun = 0;

    const selectLocale = async (
      entry: LocaleEntry | undefined,
      {
        persist = false,
        replaceReadme = true,
      }: { persist?: boolean; replaceReadme?: boolean } = {},
    ): Promise<void> => {
      if (!entry) return;

      const run = ++selectionRun;
      selectedLocaleNorm = entry.localeNorm;
      warmFollowingLocale(entry.localeNorm);

      if (persist) {
        savedLocale = entry.localeNorm;
        try {
          localStorage.setItem("gh-profile-locale", savedLocale);
        } catch {}
      }

      const translation = await loadTrans(entry);
      if (run !== selectionRun || !translation) {
        if (run === selectionRun && !translation) {
          selectedLocaleNorm =
            localeNorm(root.dataset.appliedLocale) || src.localeNorm;
        }
        return;
      }

      const apply = () => {
        if (run !== selectionRun) return;
        applyTrans(translation, replaceReadme);
      };

      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", apply, {
          once: true,
        });
      } else {
        apply();
      }
    };

    const initialEntry = findInitLocale();
    const isInitSrc = initialEntry.localeNorm === src.localeNorm;

    void selectLocale(initialEntry, {
      persist: false,
      replaceReadme: !isInitSrc,
    });
    warmRemainingTranslations(initialEntry.localeNorm);

    window.addEventListener("i18n-toggle", () => {
      const curIdx = locales.findIndex(
        ({ localeNorm: entryNorm }: LocaleEntry): boolean =>
          entryNorm === selectedLocaleNorm,
      );
      const next = locales[(curIdx + 1) % locales.length] ?? srcEntry;

      void selectLocale(next, {
        persist: true,
        replaceReadme: true,
      });
    });

    window.addEventListener("i18n-select", (event: Event): void => {
      const requestedLocale: unknown = (
        event as CustomEvent<{ locale?: unknown }>
      ).detail?.locale;
      if (typeof requestedLocale !== "string") return;

      const entry = localeMatch(requestedLocale);
      if (!entry) return;

      void selectLocale(entry, {
        persist: true,
        replaceReadme: true,
      });
    });

    const followBrowserLocale = () => {
      if (savedLocaleEntry()) return false;

      const next =
        findBrowserLocale() ??
        localeMatch(String(payload.defLanguage ?? "")) ??
        srcEntry;

      if (next.localeNorm === selectedLocaleNorm) return false;

      void selectLocale(next, {
        persist: false,
        replaceReadme: true,
      });
      return true;
    };

    window.addEventListener("languagechange", followBrowserLocale);

    window.addEventListener("pageshow", () => {
      if (followBrowserLocale()) return;

      const current = localeMap.get(selectedLocaleNorm) ?? srcEntry;
      const applied = localeNorm(root.dataset.appliedLocale);
      if (applied && applied !== current.localeNorm) {
        void selectLocale(current, {
          persist: false,
          replaceReadme: true,
        });
      }
    });
  } catch (error) {
    console.error("Failed to select browser language:", error);
  }
})();
