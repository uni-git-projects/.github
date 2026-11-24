import { existsSync, readFileSync } from "node:fs";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";

const config = JSON.parse(
  readFileSync(new URL("./site.config.json", import.meta.url), "utf8"),
);
const siteDataPath = new URL("./.cache/site.json", import.meta.url);
const repoName =
  config.basePath ||
  (existsSync(siteDataPath)
    ? JSON.parse(readFileSync(siteDataPath, "utf8")).repoName
    : config.repoName?.trim() || config.githubName);

export default defineConfig({
  site: config.siteUrl,
  base: repoName,
  output: "static",
  trailingSlash: "never",
  integrations: [sitemap()],
  build: {
    format: "directory",
  },
});
