(() => {
  const root = document.documentElement;
  const dataElement = document.getElementById("all-style-data");
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

    const isKnown = (name: string): boolean => names.includes(name);
    const defaultName =
      typeof payload.defaultName === "string" && isKnown(payload.defaultName)
        ? payload.defaultName
        : (names[0] ?? "");
    let current = defaultName;

    try {
      const saved = localStorage.getItem("gh-profile-site-style");
      if (saved && isKnown(saved)) current = saved;
    } catch {}

    const applyStyle = (name: string, persist: boolean = false): void => {
      if (!isKnown(name)) return;
      current = name;
      root.dataset.themeStyle = name;

      if (persist) {
        try {
          localStorage.setItem("gh-profile-site-style", name);
        } catch {}
      }

      window.dispatchEvent(
        new CustomEvent("site-style-change", {
          detail: { style: name },
        }),
      );
    };

    applyStyle(current);
    window.addEventListener("site-style-select", (event: Event): void => {
      const style: unknown = (event as CustomEvent<{ style?: unknown }>).detail
        ?.style;
      if (typeof style === "string") applyStyle(style, true);
    });
    window.addEventListener("pageshow", () => applyStyle(current));
  } catch (error) {
    console.error("Failed to initialize all-style mode:", error);
  }
})();

export {};
