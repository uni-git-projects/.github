import stylesObj from "../styles/styles.json";

interface StyleI {
  bg: string;
  bgSize?: string;
  bgPos?: string;
}

export type Style =
  | { type: "default" }
  | { type: "named"; name: string; style: StyleI };

const styles = stylesObj as Record<string, StyleI>;

for (const [name, style] of Object.entries(styles)) {
  if (!style?.bg?.trim()) {
    throw new Error(`Theme style "${name}" must define a background.`);
  }
}

const sortedStyleNames: string[] = Object.keys(styles).sort(
  (a: string, b: string): number => a.localeCompare(b),
);

export const styleNames: () => string[] = (): string[] => [...sortedStyleNames];

const css: (property: string, val?: string | undefined) => string = (
  property: string,
  val?: string,
): string => (val?.trim() ? `${property}:${val};` : "");

export const styleCSS: (
  name: string,
  style: StyleI,
  isPreview?: boolean,
) => string = (name: string, style: StyleI, isPreview = false): string => {
  const nameStr: string = JSON.stringify(name);
  const declarations: string = `${css("background", style.bg)}${css(
    "background-size",
    style.bgSize,
  )}${css("background-position", style.bgPos)}`;
  const siteRule: string = `html[data-theme-style=${nameStr}] body{${declarations}}`;

  const sharedStarsRule: string =
    name === "stars"
      ? `:root{--stars-style-background:${style.bg};--stars-style-background-size:${style.bgSize ?? "auto"};--stars-style-background-position:${style.bgPos ?? "center"};}`
      : "";

  const lightStarsRule: string =
    name === "stars"
      ? `html[data-theme-style=${nameStr}]:not(.dark) body{background:#fff;background-size:auto;background-position:0 0;}`
      : "";

  if (!isPreview) return `${sharedStarsRule}${siteRule}${lightStarsRule}`;

  const previewRule: string = `.site-theme-dialog[data-preview-style=${nameStr}] .site-theme-preview-style-layer,.site-style-dialog .site-theme-preview-style-layer[data-site-style-preview=${nameStr}]{${declarations}}`;
  const lightStarsPreviewRule: string =
    name === "stars"
      ? `.site-theme-dialog[data-preview-mode="light"][data-preview-style=${nameStr}] .site-theme-preview-style-layer,.site-style-dialog[data-preview-mode="light"] .site-theme-preview-style-layer[data-site-style-preview=${nameStr}]{background:#fff;background-size:auto;background-position:0 0;}`
      : "";
  return `${sharedStarsRule}${siteRule}${lightStarsRule}${previewRule}${lightStarsPreviewRule}`;
};

export const allStylesCSS: (names?: string[]) => string = (
  names: string[] = sortedStyleNames,
): string =>
  names
    .map((name: string): string => {
      const style: StyleI | undefined = styles[name];
      return style ? styleCSS(name, style, true) : "";
    })
    .join("");

export const resolveStyle: (val?: string | undefined) => Style = (
  val?: string,
): Style => {
  const styleVal: string = val?.trim() ?? "";
  if (!styleVal) return { type: "default" };

  if (styleVal === "all") {
    throw new Error(
      'Style "all" has been removed; use a style name such as "stars" or "solid". The style selector is always available.',
    );
  }

  const style: StyleI | undefined = styles[styleVal];
  if (!style) {
    const availStyles: string = Object.keys(styles).sort().join(", ");
    throw new Error(
      `Unknown style "${styleVal}". Available: ${availStyles || "none"}.`,
    );
  }

  return { type: "named", name: styleVal, style };
};
