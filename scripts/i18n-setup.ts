import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const HF_MODEL: string = "Xenova/nllb-200-distilled-600M";
const MODEL_FILES: readonly string[] = [
  "config.json",
  "generation_config.json",
  "quantize_config.json",
  "sentencepiece.bpe.model",
  "special_tokens_map.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
];
const NUM_RETRIES: number = 8;
const TIMEOUT_MS: number = 30 * 60 * 1000;
const PROGRESS_STEP: number = 25 * 1024 * 1024;

type ModelArgs = { modelId?: string; revision?: string; token?: string };
type DownloadArgs = {
  modelId: string;
  revision: string;
  file: string;
  token: string;
};

class ModelDownloader {
  private readonly root: string;

  constructor() {
    this.root = resolve(
      process.cwd(),
      process.env.HF_TRANS_LOCAL_DIR?.trim() || ".models",
    );
  }

  directory(modelId: string): string {
    return resolve(this.root, ...modelId.split("/"));
  }

  private static envInt(name: string, fallback: number, min = 1): number {
    const val: number = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(val) && val >= min ? val : fallback;
  }

  private static async size(path: string): Promise<number> {
    try {
      return (await stat(path)).size;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && err.code === "ENOENT")
        return 0;
      throw err;
    }
  }

  private static total(res: Response, offset: number): number | undefined {
    const range: string | null = res.headers.get("content-range");
    const match: RegExpExecArray | null = /bytes\s+\d+-\d+\/(\d+)/i.exec(
      range ?? "",
    );
    if (match?.[1]) return Number.parseInt(match[1], 10);
    const len: number = Number.parseInt(
      res.headers.get("content-length") ?? "",
      10,
    );
    return Number.isFinite(len) && len >= 0 ? offset + len : undefined;
  }

  private static mib(bytes: number): string {
    return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  }

  private url(modelId: string, revision: string, file: string): string {
    const enc: (val: string) => string = (val: string): string =>
      val.split("/").map(encodeURIComponent).join("/");
    return `https://huggingface.co/${enc(modelId)}/resolve/${encodeURIComponent(revision)}/${enc(file)}?download=true`;
  }

  private async download({
    modelId,
    revision,
    file,
    token,
  }: DownloadArgs): Promise<void> {
    const dest: string = resolve(this.directory(modelId), ...file.split("/"));
    const part: string = `${dest}.part`;
    if ((await ModelDownloader.size(dest)) > 0) {
      console.log(`Model file ready: ${file}`);
      return;
    }
    await mkdir(dirname(dest), { recursive: true });
    const retries: number = ModelDownloader.envInt(
      "HF_TRANS_DOWNLOAD_RETRIES",
      NUM_RETRIES,
    );
    const timeoutMs: number = ModelDownloader.envInt(
      "HF_TRANS_DOWNLOAD_TIMEOUT_MS",
      TIMEOUT_MS,
      1000,
    );
    let lastErr: unknown;

    for (let attempt: number = 1; attempt <= retries; attempt += 1) {
      let offset: number = await ModelDownloader.size(part);
      try {
        const headers: Record<string, string> = {
          "User-Agent": "github-profile-readme-site/1.0",
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (offset > 0) headers.Range = `bytes=${offset}-`;
        console.log(
          `${offset > 0 ? "Resuming" : "Downloading"} ${file}${offset > 0 ? ` from ${ModelDownloader.mib(offset)}` : ""} (attempt ${attempt}/${retries})...`,
        );
        const res: Response = await fetch(this.url(modelId, revision, file), {
          headers,
          redirect: "follow",
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 416 && offset > 0) {
          const match: RegExpExecArray | null = /bytes\s+\*\/(\d+)/i.exec(
            res.headers.get("content-range") ?? "",
          );
          const total: number | undefined = match?.[1]
            ? Number.parseInt(match[1], 10)
            : undefined;
          if (total !== undefined && offset === total) {
            await rename(part, dest);
            console.log(
              `Model file ready: ${file} (${ModelDownloader.mib(total)})`,
            );
            return;
          }
        }
        if (!res.ok && res.status !== 206)
          throw new Error(
            `Hugging Face returned ${res.status} ${res.statusText} for ${file}.`,
          );
        if (!res.body)
          throw new Error(`Hugging Face returned an empty body for ${file}.`);
        let flags: "a" | "w" = "a";
        if (offset > 0 && res.status !== 206) {
          await rm(part, { force: true });
          offset = 0;
          flags = "w";
        } else if (offset === 0) {
          flags = "w";
        }
        const expected: number | undefined = ModelDownloader.total(res, offset);
        let downloaded: number = offset;
        let next: number =
          Math.floor(downloaded / PROGRESS_STEP) * PROGRESS_STEP +
          PROGRESS_STEP;
        const progress: Transform = new Transform({
          transform(
            chunk: Buffer,
            _encoding: BufferEncoding,
            callback: (err?: Error | null, data?: Buffer) => void,
          ): void {
            downloaded += chunk.length;
            if (downloaded >= next) {
              const suffix: string = expected
                ? ` / ${ModelDownloader.mib(expected)}`
                : "";
              console.log(
                `  ${file}: ${ModelDownloader.mib(downloaded)}${suffix}`,
              );
              next += PROGRESS_STEP;
            }
            callback(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(
            res.body as import("node:stream/web").ReadableStream<Uint8Array>,
          ),
          progress,
          createWriteStream(part, { flags }),
        );
        const size: number = await ModelDownloader.size(part);
        if (expected !== undefined && size !== expected) {
          throw new Error(
            `Incomplete download for ${file}: ${size} bytes of ${expected} bytes.`,
          );
        }
        await rename(part, dest);
        console.log(`Model file ready: ${file} (${ModelDownloader.mib(size)})`);
        return;
      } catch (err: unknown) {
        lastErr = err;
        if (attempt === retries) break;
        const backoff: number = Math.min(30_000, 1500 * 2 ** (attempt - 1));
        console.warn(
          `Model download interrupted for ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        console.warn(
          `Retrying in ${(backoff / 1000).toFixed(1)}s; partial data will be resumed.`,
        );
        await delay(backoff);
      }
    }
    throw new Error(
      `Failed to download ${file} after ${retries} attempts. Re-run the command to resume from the saved .part file.`,
      { cause: lastErr },
    );
  }

  async ensure(args: ModelArgs = {}): Promise<string> {
    const modelId: string = args.modelId ?? HF_MODEL;
    const revision: string =
      args.revision ?? (process.env.HF_TRANS_REVISION?.trim() || "main");
    const token: string = args.token ?? (process.env.HF_TOKEN?.trim() || "");
    if (modelId !== HF_MODEL)
      throw new Error(
        `The resumable local downloader is configured for ${HF_MODEL}, not ${modelId}.`,
      );
    await mkdir(this.directory(modelId), { recursive: true });
    for (const file of MODEL_FILES)
      await this.download({ modelId, revision, file, token });
    return this.root;
  }
}

const downloader: ModelDownloader = new ModelDownloader();
export async function assertModel(args: ModelArgs = {}): Promise<string> {
  return downloader.ensure(args);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assertModel({ modelId: process.env.HF_TRANS_MODEL?.trim() || HF_MODEL })
    .then((root: string): void =>
      console.log(`Local model ready under ${root}`),
    )
    .catch((err: unknown): void => {
      console.error("Failed to prepare translation model.", err);
      process.exitCode = 1;
    });
}
