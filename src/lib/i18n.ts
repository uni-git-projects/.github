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

export const themeModalSrc: ThemeModalTrans = {
  title: "Theme",
  description: "Preview and choose the site theme.",
  mode: "Mode",
  style: "Style",
  searchThemes: "Search themes",
  previewTitle: "Theme preview",
  previewHTML:
    'GitHub profile README Markdown content, <span class="site-theme-preview-link">links</span> and <span class="site-theme-preview-inline-code">code</span>.',
  themePalette: "Theme palette",
  styleLayers: "Style layers",
};
