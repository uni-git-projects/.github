import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { ThemeModalTrans } from "./i18n";

export interface GitHubOrg {
  login: string;
  avatarUrl: string;
  profileUrl: string;
  websiteUrl?: string;
}

interface LinkIcon {
  title: string;
  viewBox: string;
  body: string;
}

export interface IconLink {
  key: string;
  label: string;
  url: string;
  icon?: LinkIcon;
  fallbackIcon?: "email" | "link" | "website";
  rel?: string;
  isOpenTab: boolean;
}

export interface SourceProfile {
  locale: string;
  title: string;
  tagline: string;
  themeModal: ThemeModalTrans;
  readmeHTML: string;
  version: string;
}

interface ThemeData {
  names: string[];
  defaultName: string;
  colors: Record<string, { light: string; dark: string }>;
  themeColor: string | null;
}

interface StyleData {
  names: string[];
  defaultName: string;
}

interface Layout {
  theme: ThemeData;
  style: StyleData;
  themeCss: string;
  styleCss: string;
  themeColorInlineCss: string | null;
  fixedThemeTone: "light" | "dark" | null;
  lightThemeColor: string | null;
  darkThemeColor: string | null;
  uncoloredLightThemeColor: string | null;
  uncoloredDarkThemeColor: string | null;
}

interface PageConfig {
  githubName: string;
  githubProfileUrl: string;
  githubAvatarUrl: string;
  tabName?: string;
  description: string;
  gaId: string;
  theme: string;
  language: string;
}

export interface SiteData {
  repoName: string;
  config: PageConfig;
  localeSrc: string;
  locales: string[];
  profile: SourceProfile;
  layout: Layout;
  favUrl: string | null;
  iconLinks: IconLink[];
  orgBadges: GitHubOrg[];
}

export async function readSiteData(): Promise<SiteData> {
  const path: string = resolve(process.cwd(), ".cache/site.json");
  try {
    const raw: string = await readFile(path, "utf8");
    const data: Partial<SiteData> | null = JSON.parse(
      raw,
    ) as Partial<SiteData> | null;
    if (!data?.config || !data.layout || !data.profile) {
      throw new Error("Site preprocessing output is incomplete.");
    }
    return data as SiteData;
  } catch (error) {
    throw new Error("Missing or invalid site data. Run: npm run i18n.", {
      cause: error,
    });
  }
}
