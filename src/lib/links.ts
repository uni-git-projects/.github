import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { SimpleIcon } from "simple-icons";
import * as simpleIcons from "simple-icons";

export type IconFB = "email" | "link" | "website";

export interface LinkIcon {
  title: string;
  viewBox: string;
  body: string;
}

export interface IconLink {
  key: string;
  label: string;
  url: string;
  icon?: LinkIcon;
  fallbackIcon?: IconFB;
  rel?: string;
  isOpenTab: boolean;
}

interface IconSrcBS {
  slug: string;
  path: string;
}

const iconCacheBS = new Map<string, Promise<LinkIcon | undefined>>();
let iconIdxPromiseBS: Promise<Map<string, IconSrcBS>> | undefined;

function getIconIdxBS(): Promise<Map<string, IconSrcBS>> {
  iconIdxPromiseBS ??= (async () => {
    const require: NodeJS.Require = createRequire(import.meta.url);
    const iconDir: string = resolve(
      dirname(require.resolve("bootstrap-icons/package.json")),
      "icons",
    );
    const files: string[] = await readdir(iconDir);
    const index = new Map<string, IconSrcBS>();

    for (const file of files.sort()) {
      if (!file.endsWith(".svg")) continue;
      const slug: string = file.slice(0, -4);
      index.set(norm(slug), { slug, path: resolve(iconDir, file) });
    }
    return index;
  })().catch((): Map<string, IconSrcBS> => new Map<string, IconSrcBS>());

  return iconIdxPromiseBS;
}

const iconIdxSimple = new Map<string, LinkIcon>();
for (const candidate of Object.values(simpleIcons)) {
  if (!isIconSimple(candidate)) {
    continue;
  }
  const icon: LinkIcon = getLinkIcon(candidate);
  iconIdxSimple.set(norm(candidate.slug), icon);
  iconIdxSimple.set(norm(candidate.title), icon);
}

function isIconSimple(linkIcon: unknown): linkIcon is SimpleIcon {
  if (typeof linkIcon !== "object" || linkIcon === null) {
    return false;
  }
  const icon = linkIcon as Partial<SimpleIcon>;
  return (
    typeof icon.slug === "string" &&
    typeof icon.title === "string" &&
    typeof icon.path === "string"
  );
}

function getLinkIcon(icon: SimpleIcon): LinkIcon {
  return {
    title: icon.title,
    viewBox: "0 0 24 24",
    body: `<path d="${icon.path}" />`,
  };
}

function isHttpsUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

function getIconsFromKey(key: string): string[] {
  const original: string = key.trim();
  const id: string =
    original
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      ?.replace(/^www\./i, "")
      .replace(/\.$/, "")
      .toLowerCase() ?? "";
  const lbl: string = id.split(".")[0] ?? "";
  return [...new Set([original, id, lbl].filter(Boolean))];
}

function norm(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseSvgBS(svg: string, title: string): LinkIcon | undefined {
  const svgMatch: RegExpMatchArray | null = svg.match(
    /<svg\b([^>]*)>([\s\S]*?)<\/svg>/i,
  );
  if (!svgMatch) {
    return undefined;
  }

  const attributes: string = svgMatch[1] ?? "";
  const body: string = svgMatch[2]?.trim() ?? "";
  if (!body) {
    return undefined;
  }

  const viewBox: string =
    attributes.match(/\bviewBox=["']([^"']+)["']/i)?.[1] ?? "0 0 16 16";

  return {
    title,
    viewBox,
    body,
  };
}

function loadIconBS(iconStr: string): Promise<LinkIcon | undefined> {
  const normIconStr: string = norm(iconStr);
  const cached: Promise<LinkIcon | undefined> | undefined =
    iconCacheBS.get(normIconStr);
  if (cached) {
    return cached;
  }

  const iconPromise: Promise<LinkIcon | undefined> = getIconIdxBS()
    .then(
      async (index: Map<string, IconSrcBS>): Promise<LinkIcon | undefined> => {
        const src: IconSrcBS | undefined = index.get(normIconStr);
        if (!src) return undefined;
        const svg: string = await readFile(src.path, "utf8");
        return parseSvgBS(svg, getLbl(src.slug));
      },
    )
    .catch((): undefined => undefined);

  iconCacheBS.set(normIconStr, iconPromise);
  return iconPromise;
}

async function findIcon(key: string): Promise<LinkIcon | undefined> {
  const keyCandidates: string[] = getIconsFromKey(key);
  for (const candidate of keyCandidates) {
    const icon: LinkIcon | undefined = iconIdxSimple.get(norm(candidate));
    if (icon) {
      return icon;
    }
  }

  for (const candidate of keyCandidates) {
    const icon: LinkIcon | undefined = await loadIconBS(candidate);
    if (icon) {
      return icon;
    }
  }
  return undefined;
}

function getLbl(key: string): string {
  const id: string =
    key
      .trim()
      .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
      .split(/[/?#]/, 1)[0]
      ?.replace(/^www\./i, "") ?? key;
  return id
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/^./, (char: string): string => char.toUpperCase());
}

function getIconFallBack(key: string, url: string): IconFB {
  const normKey: string = norm(key);
  const normUrl: string = url.toLowerCase();
  if (normUrl.startsWith("mailto:") || normKey.includes("email")) {
    return "email";
  } else if (
    normKey.includes("website") ||
    normKey.includes("portfolio") ||
    normKey.includes("homepage")
  ) {
    return "website";
  }
  return "link";
}

export async function getIconLinks(
  links: Record<string, string> = {},
): Promise<IconLink[]> {
  const iconLinks: IconLink[] = [];

  for (const [key, rawUrl] of Object.entries(links)) {
    const url: string = rawUrl.trim();
    if (!url) {
      continue;
    }
    const icon: LinkIcon | undefined = await findIcon(key);
    const isOpenTab: boolean = isHttpsUrl(url);

    iconLinks.push({
      key,
      label: icon?.title ?? getLbl(key),
      url,
      ...(icon ? { icon } : { fallbackIcon: getIconFallBack(key, url) }),
      ...(isOpenTab ? { rel: "noopener noreferrer" } : {}),
      isOpenTab,
    });
  }
  return iconLinks;
}

export function idUrls(iconLinks: IconLink[]): string[] {
  return iconLinks
    .filter(({ url }: IconLink): boolean => isHttpsUrl(url))
    .map(({ url }: IconLink): string => url);
}
