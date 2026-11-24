import themeModal from "../theme-modal.json";

export interface ThemeModalTrans {
  title: string;
  description: string;
  mode: string;
  style: string;
  searchThemes: string;
  previewTitle: string;
  previewHTML: string;
  themePalette: string;
  styleLayers: string;
}

export const themeModalSrc: ThemeModalTrans = themeModal;

export function localeNorm(locale: unknown): string {
  return String(locale ?? "")
    .trim()
    .replaceAll("_", "-")
    .toLowerCase();
}
