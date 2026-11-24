(() => {
  const root = document.documentElement;
  const fixedTone = root.dataset.fixedThemeTone;

  if (fixedTone === "light" || fixedTone === "dark") {
    root.classList.remove("dark");
    root.dataset.theme = "fixed";
    root.style.colorScheme = fixedTone;
    return;
  }

  let savedTheme = null;
  try {
    savedTheme = localStorage.getItem("gh-profile-theme");
  } catch {}

  const allThemeMode = Boolean(document.getElementById("all-theme-data"));
  const theme =
    savedTheme === "light" || savedTheme === "dark"
      ? savedTheme
      : allThemeMode
        ? "dark"
        : matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";

  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;

  const themeMeta = document.querySelector('meta[name="theme-color"]');
  if (themeMeta instanceof HTMLMetaElement) {
    const color =
      theme === "dark" ? themeMeta.dataset.dark : themeMeta.dataset.light;
    if (color) themeMeta.content = color;
  }
})();

export {};
