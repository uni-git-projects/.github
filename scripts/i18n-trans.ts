import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import emojiRegex from "emoji-regex";
import { fetchReadMe, type ReadmeRes } from "../src/lib/gh.ts";
import { type ThemeModalTrans, themeModalSrc } from "../src/lib/i18n.ts";
import { localeNorm, type ModelRoute, modelRoute } from "./i18n-model.ts";
import { transHTML } from "./i18n-profile.ts";
import {
  type GenOpts,
  type Pipeline,
  Small100Translator,
  type TranslationOutput,
} from "./i18n-small100.ts";

type JsonMap = Record<string, unknown>;
type Config = {
  githubName?: string;
  repoName?: string;
  language?: string;
  locales?: string[];
  tabName?: string;
  tagline?: string;
  tabSuffix?: string;
};
type Part = { literal: string } | { unit: number };
type SrcPlan = { str: string; memKey: string; parts: Part[] };
type ValidRes = { ok: boolean; reason?: string };
type EmojiPart = { type: "text" | "emoji"; value: string };
type ProtectedPart = { protected: boolean; value: string };
type GenDoc = {
  locale?: string;
  localeSrc?: string;
  srcHash?: string;
  generator?: JsonMap;
  tabSuffix?: string;
  tagline?: string;
  themeModal?: ThemeModalTrans;
  readme?: Awaited<ReturnType<typeof fetchReadMe>>;
};

const PATTERN_MODEL_TXT: RegExp = /[\p{L}\p{N}]/u;
const TAB_SUFFIX: string = "GitHub Profile";

const GEN_DIR: string = resolve(
  process.cwd(),
  process.env.I18N_OUTPUT_DIR?.trim() || "src/gen/i18n",
);
const PUB_DIR: string = resolve(
  process.cwd(),
  process.env.I18N_PUBLIC_DIR?.trim() || "public/i18n",
);
const MODEL_CACHE_DIR: string = resolve(
  process.cwd(),
  process.env.HF_TRANSFORMERS_CACHE?.trim() || ".cache/huggingface",
);
const MODEL_LOCALE_MAP: Readonly<Record<string, string>> = Object.freeze(
  JSON.parse(
    await readFile(new URL("../src/locales.json", import.meta.url), "utf8"),
  ) as Record<string, string>,
);
const MODEL_LOCALE_SET: ReadonlySet<string> = new Set<string>(
  Object.values(MODEL_LOCALE_MAP).map((locale: string): string =>
    localeNorm(locale).toLowerCase(),
  ),
);
const MODEL_LOCALE_MAP_HASH: string = createHash("sha256")
  .update(JSON.stringify(MODEL_LOCALE_MAP))
  .digest("hex")
  .slice(0, 16);
function modelMeta(src: string, dest: string): JsonMap {
  const route: ModelRoute = modelRoute(src, dest, MODEL_LOCALE_SET);
  return {
    provider: "transformers.js",
    model: route.id,
    dtype: route.dtype,
    task: route.task,
    emoji: "preserve",
    localeMap: MODEL_LOCALE_MAP_HASH,
  };
}

const MAX_SEG_CHARS: number = Math.max(
  80,
  Number.parseInt(process.env.HF_TRANS_MAX_CHARS || "320", 10) || 320,
);
const MAX_NEW_TOKENS: number = Math.max(
  32,
  Number.parseInt(process.env.HF_TRANS_MAX_NEW_TOKENS || "384", 10) || 384,
);

const HTML_ESC: Readonly<Record<string, string>> = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

const SENTENCE_SEGMENTER: Intl.Segmenter | undefined = (():
  | Intl.Segmenter
  | undefined => {
  try {
    return new Intl.Segmenter(undefined, { granularity: "sentence" });
  } catch {
    return undefined;
  }
})();

const HTML_MAP: Map<string, string> = new Map<string, string>([
  ["amp", "&"],
  ["apos", "'"],
  ["copy", "©"],
  ["gt", ">"],
  ["hellip", "…"],
  ["laquo", "«"],
  ["ldquo", "“"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["nbsp", "\u00a0"],
  ["ndash", "–"],
  ["quot", '"'],
  ["raquo", "»"],
  ["rdquo", "”"],
  ["reg", "®"],
  ["rsquo", "’"],
  ["trade", "™"],
]);

function decodeHTML(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z][\da-z]+));/gi,
    (match, dec, hexDec, named): string => {
      if (!dec && !hexDec) {
        return HTML_MAP.get(String(named).toLowerCase()) ?? match;
      }
      const codePnt: number = Number.parseInt(
        dec ? dec : hexDec,
        dec ? 10 : 16,
      );
      return Number.isSafeInteger(codePnt) &&
        codePnt >= 0 &&
        codePnt <= 0x10ffff
        ? String.fromCodePoint(codePnt)
        : match;
    },
  );
}

function splitTxt(str: string): string[] {
  if (str.length <= MAX_SEG_CHARS) return [str];

  const strSeg: string[] = SENTENCE_SEGMENTER
    ? Array.from(
        SENTENCE_SEGMENTER.segment(str),
        ({ segment }: Intl.SegmentData): string => segment,
      )
    : str.split(/(?<=[.!?])\s+/u);

  const chunks: string[] = [];
  let cur: string = "";

  const pushCur: () => void = (): void => {
    if (cur) chunks.push(cur);
    cur = "";
  };

  for (const line of strSeg) {
    if (!line) continue;
    if (line.length <= MAX_SEG_CHARS) {
      if (cur && cur.length + line.length > MAX_SEG_CHARS) {
        pushCur();
      }
      cur += line;
      continue;
    }

    pushCur();
    const words: string[] = line.split(/(\s+)/u);
    for (const word of words) {
      if (cur && cur.length + word.length > MAX_SEG_CHARS) {
        pushCur();
      }
      if (word.length <= MAX_SEG_CHARS) {
        cur += word;
      } else {
        for (
          let offset: number = 0;
          offset < word.length;
          offset += MAX_SEG_CHARS
        ) {
          chunks.push(word.slice(offset, offset + MAX_SEG_CHARS));
        }
      }
    }
  }

  pushCur();
  return chunks.length ? chunks : [str];
}

function isWordsRepeat(value: string): boolean {
  const words: RegExpMatchArray | null = String(value ?? "")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length < 3) return false;

  for (
    let size: number = 1;
    size <= Math.min(4, Math.floor(words.length / 3));
    size += 1
  ) {
    for (let i: number = 0; i + size * 3 <= words.length; i += 1) {
      let repeatCnt: number = 1;
      while (i + size * (repeatCnt + 1) <= words.length) {
        let isDup: boolean = true;
        for (let j: number = 0; j < size; j += 1) {
          if (words[i + j] !== words[i + size * repeatCnt + j]) {
            isDup = false;
            break;
          }
        }
        if (!isDup) break;
        repeatCnt += 1;
      }
      if (repeatCnt >= 3) return true;
    }
  }

  return false;
}

function isCharsRepeat(value: string): boolean {
  const chars: string[] = Array.from(String(value ?? "").replace(/\s+/gu, ""));
  if (chars.length < 8) return false;

  for (
    let size: number = 1;
    size <= Math.min(8, Math.floor(chars.length / 4));
    size += 1
  ) {
    for (let i: number = 0; i + size * 4 <= chars.length; i += 1) {
      let repeatCnt: number = 1;

      while (i + size * (repeatCnt + 1) <= chars.length) {
        let isDup: boolean = true;

        for (let j: number = 0; j < size; j += 1) {
          if (chars[i + j] !== chars[i + size * repeatCnt + j]) {
            isDup = false;
            break;
          }
        }
        if (!isDup) break;
        repeatCnt += 1;
      }
      if (repeatCnt >= 4 && repeatCnt * size >= 8) return true;
    }
  }
  return false;
}

export function isTransValid(src: string, trans: string): ValidRes {
  const isTransValidRes: string = String(trans ?? "").trim();
  if (!isTransValidRes) return { ok: false, reason: "empty output" };

  const resLen: number = Array.from(isTransValidRes).length;
  const maxChars: number = Math.max(
    80,
    Array.from(String(src ?? "").trim()).length * 4 + 24,
  );
  if (resLen > maxChars) {
    return {
      ok: false,
      reason: `output (${resLen} > ${maxChars})`,
    };
  }

  if (isWordsRepeat(isTransValidRes) || isCharsRepeat(isTransValidRes)) {
    return { ok: false, reason: "repetition" };
  }
  return { ok: true };
}

export function maxTokens(src: string, cap = 384): number {
  return Math.min(
    Number.isFinite(cap) ? Math.max(16, cap) : 384,
    Math.max(16, Math.ceil(Array.from(String(src ?? "")).length * 2.5 + 8)),
  );
}

export function getPipelineTxt(res: unknown): string | undefined {
  const init: unknown = Array.isArray(res) ? res[0] : res;
  if (typeof init !== "object" || init === null) return undefined;
  const output: Record<string, unknown> = init as Record<string, unknown>;
  if (init && typeof output.translation_text === "string") {
    return output.translation_text as string;
  } else if (init && typeof output.generated_text === "string") {
    return output.generated_text as string;
  }
  return undefined;
}

function splitEmoji(str: string): EmojiPart[] {
  const txt: string = String(str ?? "");
  const seg: EmojiPart[] = [];
  let offset: number = 0;

  for (const match of txt.matchAll(emojiRegex())) {
    const idx: number = match.index ?? offset;
    if (idx > offset) {
      seg.push({ type: "text", value: txt.slice(offset, idx) });
    }
    seg.push({ type: "emoji", value: match[0] });
    offset = idx + match[0].length;
  }

  if (offset < txt.length) {
    seg.push({ type: "text", value: txt.slice(offset) });
  }
  return seg.length ? seg : [{ type: "text", value: txt }];
}

export function splitEmojiMap(str: string): ProtectedPart[] {
  return splitEmoji(str).map(
    (seg: EmojiPart): { protected: boolean; value: string } => ({
      protected: seg.type === "emoji",
      value: seg.value,
    }),
  );
}

export function isModelTxt(value: string): boolean {
  return PATTERN_MODEL_TXT.test(String(value ?? ""));
}

class TransHF {
  readonly localeSrc: string;
  private readonly pipelinePromises: Map<string, Promise<Pipeline>>;
  private readonly transMem: Map<string, string>;
  constructor(localeSrc: string) {
    this.localeSrc = localeNorm(localeSrc);
    this.pipelinePromises = new Map<string, Promise<Pipeline>>();
    this.transMem = new Map<string, string>();
  }

  async getPipeline(route: ModelRoute): Promise<Pipeline> {
    let promise: Promise<Pipeline> | undefined = this.pipelinePromises.get(
      route.id,
    );
    if (!promise) {
      promise = (async (): Promise<Pipeline> => {
        console.log(`Loading ${route.id} (${route.dtype}, ${route.task})...`);
        const model: Small100Translator = await Small100Translator.load(
          route.id,
          MODEL_CACHE_DIR,
        );
        const pipeline: Pipeline = Object.assign(
          (txt: string, opts: GenOpts): Promise<TranslationOutput[]> =>
            model.trans(txt, opts.tgt_lang, opts),
          { dispose: (): Promise<void> => model.dispose() },
        );
        return pipeline;
      })();
      this.pipelinePromises.set(route.id, promise);
    }
    return promise;
  }

  optsGen(src: string, route: ModelRoute, retry = false): GenOpts {
    const opts: GenOpts = {
      do_sample: false,
      num_beams: 1,
      src_lang: route.srcLang,
      tgt_lang: route.destLang,
      max_new_tokens: maxTokens(
        src,
        retry
          ? Math.max(16, Math.ceil(Array.from(src).length * 1.75 + 8))
          : MAX_NEW_TOKENS,
      ),
      no_repeat_ngram_size: retry ? 2 : 3,
      repetition_penalty: retry ? 1.35 : 1.15,
    };
    return opts;
  }

  async unitTrans(
    pipeline: Pipeline,
    src: string,
    locale: string,
    route: ModelRoute,
  ): Promise<string> {
    let isValidReason: string = "invalid response";
    for (const retry of [false, true]) {
      const res: unknown = await pipeline(src, this.optsGen(src, route, retry));
      const trans: string | undefined = getPipelineTxt(res);
      if (trans === undefined) {
        isValidReason = "invalid response";
        continue;
      }
      const isValid: ValidRes = isTransValid(src, trans);
      if (isValid.ok) return trans;
      isValidReason = isValid.reason ?? "invalid response";
    }

    console.warn(
      `Rejected ${this.localeSrc} -> ${localeNorm(locale)} translation (${isValidReason}): ${src.replace(/\s+/gu, " ").slice(0, 80)}`,
    );
    return src;
  }

  async transMany(
    data: string[],
    locale: string,
  ): Promise<Map<string, string>> {
    const route: ModelRoute = modelRoute(
      this.localeSrc,
      locale,
      MODEL_LOCALE_SET,
    );
    if (localeNorm(locale).toLowerCase() === this.localeSrc.toLowerCase()) {
      return new Map<string, string>(
        data.map((str: string): [string, string] => [str, str]),
      );
    }

    const dataUniq: string[] = [...new Set(data.filter(Boolean))];
    const output: Map<string, string> = new Map<string, string>();
    const srcPlans: SrcPlan[] = [];
    const units: string[] = [];

    for (const str of dataUniq) {
      const memKey: string = `${route.id}:${route.dtype}:${route.srcLang}:${route.destLang}:${str}`;
      const mem: string | undefined = this.transMem.get(memKey);
      if (mem !== undefined) {
        output.set(str, mem);
        continue;
      }

      const parts: Part[] = [];
      for (const part of splitEmojiMap(str)) {
        if (part.protected || !isModelTxt(part.value)) {
          parts.push({ literal: part.value });
          continue;
        }

        const ws: RegExpExecArray | null = /^(\s*)([\s\S]*?)(\s*)$/u.exec(
          part.value,
        );
        const leading: string = ws?.[1] ?? "";
        const core: string = ws?.[2] ?? part.value;
        const trailing: string = ws?.[3] ?? "";
        if (leading) parts.push({ literal: leading });
        for (const chunk of splitTxt(core)) {
          if (!isModelTxt(chunk)) {
            parts.push({ literal: chunk });
            continue;
          }
          const unit: number = units.length;
          units.push(chunk);
          parts.push({ unit });
        }
        if (trailing) parts.push({ literal: trailing });
      }
      srcPlans.push({ str, memKey, parts });
    }

    const unitsTrans: string[] = [];
    if (units.length) {
      const pl: Pipeline = await this.getPipeline(route);
      for (const unit of units) {
        unitsTrans.push(await this.unitTrans(pl, unit, locale, route));
      }
    }

    for (const plan of srcPlans) {
      const trans: string = plan.parts
        .map((part: Part): string | undefined =>
          "literal" in part ? part.literal : unitsTrans[part.unit],
        )
        .join("");
      this.transMem.set(plan.memKey, trans);
      output.set(plan.str, trans);
    }
    return output;
  }

  async transHtml(html: string, locale: string): Promise<string> {
    return transHTML(
      html,
      async (encHTML: string[]): Promise<Map<string, string>> => {
        const decodedMap: Map<string, string> = new Map<string, string>(
          encHTML.map((str: string): [string, string] => [
            str,
            decodeHTML(str),
          ]),
        );
        const trans: Map<string, string> = await this.transMany(
          [...new Set(decodedMap.values())],
          locale,
        );
        return new Map<string, string>(
          encHTML.map((orig: string): [string, string] => {
            const decoded: string = decodedMap.get(orig) ?? orig;
            return [orig, escHTML(trans.get(decoded) ?? decoded)];
          }),
        );
      },
    );
  }

  async dispose(): Promise<void> {
    const pipelines: Promise<Pipeline>[] = [...this.pipelinePromises.values()];
    this.pipelinePromises.clear();
    await Promise.all(
      pipelines.map(async (promise: Promise<Pipeline>): Promise<void> => {
        const pl: Pipeline | undefined = await promise.catch(
          (): undefined => undefined,
        );
        if (pl?.dispose) await pl.dispose();
      }),
    );
  }
}

async function transThemeModal(
  translator: TransHF,
  locale: string,
): Promise<ThemeModalTrans> {
  const modalTxt: Map<string, string> = await translator.transMany(
    [
      themeModalSrc.title,
      themeModalSrc.description,
      themeModalSrc.mode,
      themeModalSrc.style,
      themeModalSrc.searchThemes,
      themeModalSrc.previewTitle,
      themeModalSrc.themePalette,
      themeModalSrc.styleLayers,
    ],
    locale,
  );

  return {
    title: modalTxt.get(themeModalSrc.title) ?? themeModalSrc.title,
    description:
      modalTxt.get(themeModalSrc.description) ?? themeModalSrc.description,
    mode: modalTxt.get(themeModalSrc.mode) ?? themeModalSrc.mode,
    style: modalTxt.get(themeModalSrc.style) ?? themeModalSrc.style,
    searchThemes:
      modalTxt.get(themeModalSrc.searchThemes) ?? themeModalSrc.searchThemes,
    previewTitle:
      modalTxt.get(themeModalSrc.previewTitle) ?? themeModalSrc.previewTitle,
    previewHTML: await translator.transHtml(themeModalSrc.previewHTML, locale),
    themePalette:
      modalTxt.get(themeModalSrc.themePalette) ?? themeModalSrc.themePalette,
    styleLayers:
      modalTxt.get(themeModalSrc.styleLayers) ?? themeModalSrc.styleLayers,
  };
}

function localesUniq(localeSrc: string, locales: string[]): string[] {
  return [
    ...new Set(
      [localeSrc, ...(Array.isArray(locales) ? locales : [])]
        .map(localeNorm)
        .filter(Boolean),
    ),
  ];
}

function isLocale(locale: string): void {
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(locale)) {
    throw new Error(`Invalid locale: ${locale}`);
  }
}

function escHTML(html: string): string {
  return html.replace(
    /[&<>"']/g,
    (char: string): string => HTML_ESC[char] ?? char,
  );
}

function genPath(locale: string): string {
  return resolve(GEN_DIR, `${locale}.json`);
}

function isCurTrans(
  existing: GenDoc | undefined,
  {
    locale,
    localeSrc,
    srcHash,
  }: { locale: string; localeSrc: string; srcHash: string },
): boolean {
  const meta: JsonMap = modelMeta(localeSrc, locale);
  return (
    existing?.locale === locale &&
    existing?.localeSrc === localeSrc &&
    existing?.srcHash === srcHash &&
    existing?.generator?.provider === meta.provider &&
    existing?.generator?.model === meta.model &&
    existing?.generator?.dtype === meta.dtype &&
    existing?.generator?.task === meta.task &&
    existing?.generator?.emoji === meta.emoji &&
    existing?.generator?.localeMap === meta.localeMap
  );
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function writeJson(path: string, data: unknown): Promise<void> {
  return writeFile(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function pubLocalePath(locale: string): string {
  return resolve(PUB_DIR, `${locale}.json`);
}

function trans(
  conf: Config,
  gen: GenDoc | undefined,
): {
  locale: string;
  title: string;
  tagline: string;
  themeModal: ThemeModalTrans;
  readmeHTML: string;
} {
  if (
    !gen ||
    typeof gen !== "object" ||
    typeof gen.locale !== "string" ||
    typeof gen.tagline !== "string" ||
    !gen.themeModal ||
    typeof gen.themeModal !== "object" ||
    typeof gen.themeModal.title !== "string" ||
    typeof gen.themeModal.description !== "string" ||
    typeof gen.themeModal.mode !== "string" ||
    typeof gen.themeModal.style !== "string" ||
    typeof gen.themeModal.searchThemes !== "string" ||
    typeof gen.themeModal.previewTitle !== "string" ||
    typeof gen.themeModal.previewHTML !== "string" ||
    !gen.readme ||
    typeof gen.readme.html !== "string"
  ) {
    throw new Error(
      `Generated translation for ${String(gen?.locale ?? "unknown")} is invalid.`,
    );
  }

  return {
    locale: gen.locale,
    title: `${String(conf.tabName || conf.githubName || "").trim()} — ${String(gen?.tabSuffix || TAB_SUFFIX)}`,
    tagline: gen.tagline,
    themeModal: { ...themeModalSrc, ...gen.themeModal },
    readmeHTML: gen.readme.html,
  };
}

async function pubTrans(locales: string[], conf: Config): Promise<void> {
  await rm(PUB_DIR, { recursive: true, force: true });
  if (locales.length <= 1) return;

  await mkdir(PUB_DIR, { recursive: true });
  await Promise.all(
    locales.map(async (locale: string): Promise<void> => {
      const gen: GenDoc | undefined = await readJson<GenDoc>(genPath(locale));
      if (!gen) {
        throw new Error(
          `Missing generated translation for ${locale}. Run: npm run i18n.`,
        );
      }
      await writeJson(pubLocalePath(locale), trans(conf, gen));
    }),
  );
}

async function main(): Promise<void> {
  const conf: Config | undefined = await readJson<Config>(
    resolve(process.cwd(), "site.config.json"),
  );
  if (!conf || typeof conf !== "object") {
    throw new Error("site.config.json could not be read.");
  }

  const localeSrc: string = localeNorm(conf.language ?? "") || "en";
  const locales: string[] = localesUniq(localeSrc, conf.locales ?? []);
  for (const locale of locales) isLocale(locale);

  const username: string = String(conf.githubName ?? "").trim();
  const repoName: string = String(conf.repoName ?? "").trim();
  const tagline: string = String(conf.tagline ?? "");
  const tabSuffix: string = String(conf.tabSuffix ?? "").trim() || TAB_SUFFIX;
  let readme: ReadmeRes = await fetchReadMe(username, repoName);
  if (!readme.isSuccess) {
    const prevSrc: GenDoc | undefined = await readJson<GenDoc>(
      genPath(localeSrc),
    );
    if (
      prevSrc?.readme?.isSuccess === true &&
      prevSrc.readme.owner === readme.owner &&
      prevSrc.readme.repoName === readme.repoName &&
      prevSrc.readme.readmeDir === readme.readmeDir
    ) {
      console.warn("Reverting to prior README from the same repo.");
      readme = prevSrc.readme;
    }
  }

  let uiTransHF: TransHF | undefined;
  const getUiTransHF: () => TransHF = (): TransHF => {
    uiTransHF ??= new TransHF("en");
    return uiTransHF;
  };
  const isEngSrc: boolean = localeSrc.toLowerCase().startsWith("en");
  const srcThemeModal: ThemeModalTrans = isEngSrc
    ? themeModalSrc
    : await transThemeModal(getUiTransHF(), localeSrc);

  const srcHash: string = createHash("sha256")
    .update(
      JSON.stringify({
        localeSrc,
        tabSuffix,
        tagline,
        themeModal: themeModalSrc,
        readme,
      }),
    )
    .digest("hex");

  const sharedDoc = { localeSrc, srcHash };
  await mkdir(GEN_DIR, { recursive: true });
  await writeJson(genPath(localeSrc), {
    ...sharedDoc,
    locale: localeSrc,
    generator: { provider: "source" },
    tabSuffix,
    tagline,
    themeModal: srcThemeModal,
    readme,
  });

  const targetLocales: string[] = locales.filter(
    (locale: string): boolean => locale !== localeSrc,
  );
  for (const locale of targetLocales)
    modelRoute(localeSrc, locale, MODEL_LOCALE_SET);

  const curTranslations: boolean[] = await Promise.all(
    targetLocales.map(
      async (locale: string): Promise<boolean> =>
        isCurTrans(await readJson<GenDoc>(genPath(locale)), {
          locale,
          localeSrc,
          srcHash,
        }),
    ),
  );
  const localesStale: string[] = targetLocales.filter(
    (_locale: string, index: number): boolean => !curTranslations[index],
  );
  if (!localesStale.length) {
    await pubTrans(locales, conf);
    if (uiTransHF) await uiTransHF.dispose();
    console.log("Translations are up to date.");
    return;
  }

  console.log(`Generating: ${localesStale.join(", ")}`);
  const transHF = new TransHF(localeSrc);
  const modalTransHF: TransHF = isEngSrc ? transHF : getUiTransHF();
  try {
    for (const locale of localesStale) {
      console.log(`Translating ${localeSrc} -> ${locale}...`);
      const txt: Map<string, string> = await transHF.transMany(
        [tabSuffix, tagline].filter(Boolean),
        locale,
      );
      const transTabSuffix: string = txt.get(tabSuffix) ?? tabSuffix;
      const transTagline: string = tagline ? (txt.get(tagline) ?? tagline) : "";
      const transReadme: string = await transHF.transHtml(readme.html, locale);

      const themeModal: ThemeModalTrans = await transThemeModal(
        modalTransHF,
        locale,
      );

      await writeJson(genPath(locale), {
        ...sharedDoc,
        locale,
        generator: modelMeta(localeSrc, locale),
        tabSuffix: transTabSuffix,
        tagline: transTagline,
        themeModal,
        readme: {
          ...readme,
          html: transReadme,
        },
      });
    }
  } finally {
    await transHF.dispose();
    if (uiTransHF && uiTransHF !== transHF) await uiTransHF.dispose();
  }

  await pubTrans(locales, conf);
  console.log("Profile translations complete.");
}

main().catch((error) => {
  console.error("Failed to translate profile.");
  console.error(error);
  process.exitCode = 1;
});
