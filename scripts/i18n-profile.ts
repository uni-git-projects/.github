type Ws = { leading: string; core: string; trailing: string };
type Plan =
  | { type: "literal"; value: string }
  | ({ type: "txt" } & Ws)
  | { type: "tag"; value: string; attrs: Set<string> };
type Tag = { name: string; excluded: boolean };
type Translator = (txts: string[]) => Promise<Map<string, string>>;

class HtmlTranslator {
  private static readonly excluded: ReadonlySet<string> = new Set([
    "a",
    "code",
    "kbd",
    "math",
    "pre",
    "samp",
    "script",
    "style",
    "svg",
  ]);
  private static readonly voids: ReadonlySet<string> = new Set([
    "area",
    "base",
    "br",
    "col",
    "embed",
    "hr",
    "img",
    "input",
    "link",
    "meta",
    "param",
    "source",
    "track",
    "wbr",
  ]);
  private static readonly attr: RegExp =
    /(\s)(alt|aria-label|title)(\s*=\s*)(["'])([\s\S]*?)\4/gi;
  private static readonly html: RegExp =
    /<!--[\s\S]*?-->|<![^>]*>|<\/?[A-Za-z][^>]*>|[^<]+/g;
  private static readonly nonTxt: RegExp =
    /^(?:https?:\/\/|mailto:|tel:|#[\w-]+$)/i;
  private static readonly tag: RegExp = /^<\s*(\/?)\s*([A-Za-z][\w:-]*)/;
  private static readonly translatable: RegExp = /[\p{L}\p{N}]/u;

  private readonly trans: Translator;

  constructor(trans: Translator) {
    this.trans = trans;
  }

  private isTxt(txt: string): boolean {
    const val: string = txt.trim();
    return (
      val.length > 0 &&
      HtmlTranslator.translatable.test(val) &&
      !HtmlTranslator.nonTxt.test(val)
    );
  }

  private splitWs(txt: string): Ws {
    const match: RegExpExecArray | null = /^(\s*)([\s\S]*?)(\s*)$/.exec(txt);
    return {
      leading: match?.[1] ?? "",
      core: match?.[2] ?? txt,
      trailing: match?.[3] ?? "",
    };
  }

  private tagIdx(stack: Tag[], name: string): number {
    for (let idx: number = stack.length - 1; idx >= 0; idx -= 1) {
      if (stack[idx]?.name === name) return idx;
    }
    return -1;
  }

  async run(html: string): Promise<string> {
    const tokens: string[] = html.match(HtmlTranslator.html) ?? [html];
    const plans: Plan[] = [];
    const txts: Set<string> = new Set<string>();
    const stack: Tag[] = [];
    let depth: number = 0;

    for (const token of tokens) {
      if (!token.startsWith("<")) {
        const ws: Ws = this.splitWs(token);
        if (depth > 0 || !this.isTxt(ws.core)) {
          plans.push({ type: "literal", value: token });
        } else {
          txts.add(ws.core);
          plans.push({ type: "txt", ...ws });
        }
        continue;
      }

      const match: RegExpExecArray | null = HtmlTranslator.tag.exec(token);
      if (!match) {
        plans.push({ type: "literal", value: token });
        continue;
      }
      const name: string = (match[2] ?? "").toLowerCase();
      if (match[1] === "/") {
        plans.push({ type: "literal", value: token });
        const idx: number = this.tagIdx(stack, name);
        if (idx >= 0) {
          for (const entry of stack.splice(idx)) if (entry.excluded) depth -= 1;
        }
        continue;
      }

      const excluded: boolean = HtmlTranslator.excluded.has(name);
      const attrs: Set<string> = new Set<string>();
      if (depth === 0 && !excluded) {
        for (const attr of token.matchAll(HtmlTranslator.attr)) {
          const orig: string = attr[5] ?? "";
          if (this.isTxt(orig)) {
            txts.add(orig);
            attrs.add(orig);
          }
        }
      }
      plans.push(
        attrs.size
          ? { type: "tag", value: token, attrs }
          : { type: "literal", value: token },
      );
      if (!/\/\s*>$/.test(token) && !HtmlTranslator.voids.has(name)) {
        stack.push({ name, excluded });
        if (excluded) depth += 1;
      }
    }

    const translated: Map<string, string> = await this.trans([...txts]);
    const result: string[] = [];
    for (const plan of plans) {
      if (plan.type === "literal") {
        result.push(plan.value);
      } else if (plan.type === "txt") {
        result.push(
          plan.leading +
            (translated.get(plan.core) ?? plan.core) +
            plan.trailing,
        );
      } else {
        result.push(
          plan.value.replace(
            HtmlTranslator.attr,
            (
              all: string,
              space: string,
              name: string,
              eq: string,
              quote: string,
              orig: string,
            ): string => {
              if (!plan.attrs.has(orig)) return all;
              const val: string | undefined = translated.get(orig);
              return val === undefined
                ? all
                : `${space}${name}${eq}${quote}${val}${quote}`;
            },
          ),
        );
      }
    }
    return result.join("");
  }
}

export async function transHTML(
  html: string,
  transData: Translator,
): Promise<string> {
  return new HtmlTranslator(transData).run(html);
}
