(() => {
  const root = document.documentElement;
  const dataElement = document.getElementById("all-theme-data");
  if (!dataElement) return;

  try {
    const parsed: unknown = JSON.parse(dataElement.textContent ?? "{}");
    if (!parsed || typeof parsed !== "object") return;
    const payload: Record<string, unknown> = parsed as Record<string, unknown>;
    const names = Array.isArray(payload.names)
      ? payload.names.filter(
          (name: unknown): name is string =>
            typeof name === "string" && Boolean(name.trim()),
        )
      : [];
    if (!names.length) return;

    const colors: Record<string, { light?: string; dark?: string }> =
      payload.colors &&
      typeof payload.colors === "object" &&
      !Array.isArray(payload.colors)
        ? (payload.colors as Record<string, { light?: string; dark?: string }>)
        : {};
    const fixedColor =
      typeof payload.themeColor === "string" && payload.themeColor
        ? payload.themeColor
        : null;
    const isKnown = (name: string): boolean => names.includes(name);
    const defaultName =
      typeof payload.defaultName === "string" && isKnown(payload.defaultName)
        ? payload.defaultName
        : (names[0] ?? "");
    let current = defaultName;

    try {
      const saved = localStorage.getItem("gh-profile-site-theme");
      if (saved && isKnown(saved)) current = saved;
    } catch {}

    const syncMeta = () => {
      const themeMeta = document.querySelector('meta[name="theme-color"]');
      if (!(themeMeta instanceof HTMLMetaElement)) return;

      const entry = colors[current] ?? {};
      const light = fixedColor ?? entry.light;
      const dark = fixedColor ?? entry.dark ?? light;
      if (light) themeMeta.dataset.light = light;
      if (dark) themeMeta.dataset.dark = dark;

      const color = root.classList.contains("dark") ? dark : light;
      if (color) themeMeta.content = color;
    };

    const applyTheme = (name: string, persist: boolean = false): void => {
      if (!isKnown(name)) return;
      current = name;
      root.dataset.siteTheme = name;
      syncMeta();

      if (persist) {
        try {
          localStorage.setItem("gh-profile-site-theme", name);
        } catch {}
      }

      window.dispatchEvent(
        new CustomEvent("site-theme-change", {
          detail: { theme: name },
        }),
      );
    };

    applyTheme(current);
    window.addEventListener("site-theme-select", (event: Event): void => {
      const theme: unknown = (event as CustomEvent<{ theme?: unknown }>).detail
        ?.theme;
      if (typeof theme === "string") applyTheme(theme, true);
    });
    window.addEventListener("readme-theme-change", syncMeta);
    window.addEventListener("pageshow", syncMeta);
  } catch (error) {
    console.error("Failed to initialize all-theme mode:", error);
  }
})();

export {};
