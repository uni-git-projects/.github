import { readFile } from "node:fs/promises";
import {
  AutoModelForSeq2SeqLM,
  AutoTokenizer,
  env,
  type ModelOutput,
  Tensor,
} from "@huggingface/transformers";

export type GenOpts = {
  do_sample: false;
  num_beams: 1;
  max_new_tokens: number;
  no_repeat_ngram_size: number;
  repetition_penalty: number;
  src_lang: string;
  tgt_lang: string;
};

export type TranslationOutput = { readonly translation_text: string };

export type Pipeline = ((
  txt: string,
  opts: GenOpts,
) => Promise<TranslationOutput[]>) & {
  dispose?: () => Promise<void>;
};

type LangTokens = { readonly lang_to_id: Readonly<Record<string, number>> };

export class Small100Translator {
  private readonly tokenizer: Awaited<
    ReturnType<typeof AutoTokenizer.from_pretrained>
  >;
  private readonly model: Awaited<
    ReturnType<typeof AutoModelForSeq2SeqLM.from_pretrained>
  >;
  private readonly langToId: Readonly<Record<string, number>>;

  private constructor(
    tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>,
    model: Awaited<ReturnType<typeof AutoModelForSeq2SeqLM.from_pretrained>>,
    langToId: Readonly<Record<string, number>>,
  ) {
    this.tokenizer = tokenizer;
    this.model = model;
    this.langToId = langToId;
  }

  static async load(id: string, cacheDir: string): Promise<Small100Translator> {
    env.cacheDir = cacheDir;
    env.allowLocalModels = true;
    env.allowRemoteModels = true;

    const langTokens: LangTokens = JSON.parse(
      await readFile(
        new URL("./small100-lang-tokens.json", import.meta.url),
        "utf8",
      ),
    ) as LangTokens;
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(id),
      AutoModelForSeq2SeqLM.from_pretrained(id),
    ]);
    return new Small100Translator(tokenizer, model, langTokens.lang_to_id);
  }

  async trans(
    txt: string,
    dest: string,
    opts: GenOpts,
  ): Promise<TranslationOutput[]> {
    const id: number | undefined = this.langToId[dest];
    if (id === undefined) {
      throw new Error(`Unsupported SMaLL-100 locale: ${dest}`);
    }

    const enc = this.tokenizer(txt);
    const ids: bigint[] = [
      BigInt(id),
      ...Array.from(enc.input_ids.data, BigInt),
    ];
    const input_ids: Tensor = new Tensor("int64", BigInt64Array.from(ids), [
      1,
      ids.length,
    ]);
    const attention_mask: Tensor = new Tensor(
      "int64",
      BigInt64Array.from(ids, (): bigint => 1n),
      [1, ids.length],
    );
    const res: ModelOutput | Tensor = await this.model.generate({
      input_ids,
      attention_mask,
      do_sample: opts.do_sample,
      num_beams: opts.num_beams,
      max_new_tokens: opts.max_new_tokens,
      no_repeat_ngram_size: opts.no_repeat_ngram_size,
      repetition_penalty: opts.repetition_penalty,
    });
    const out: Tensor | undefined =
      res instanceof Tensor
        ? res
        : "sequences" in res && res.sequences instanceof Tensor
          ? res.sequences
          : undefined;
    if (!out) throw new Error("SMaLL-100 returned no output.");
    const translation_text: string = this.tokenizer.decode(
      Array.from(out.data, Number),
      { skip_special_tokens: true },
    );
    return [{ translation_text }];
  }

  async dispose(): Promise<void> {
    await this.model.dispose();
  }
}
