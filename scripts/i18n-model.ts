export const fastModelId: string = "casawolice/small100-onnx";

export function localeNorm(locale: string): string {
  return locale.trim().replaceAll("_", "-");
}

export type ModelRoute = {
  readonly id: string;
  readonly dtype: "int8";
  readonly task: "translation";
  readonly srcLang: string;
  readonly destLang: string;
};

export function modelRoute(
  src: string,
  dest: string,
  supported: ReadonlySet<string>,
): ModelRoute {
  const srcLang: string = localeNorm(src).toLowerCase();
  const destLang: string = localeNorm(dest).toLowerCase();
  for (const locale of [srcLang, destLang]) {
    if (!supported.has(locale))
      throw new Error(`Unsupported translation locale: ${locale}`);
  }
  return {
    id: fastModelId,
    dtype: "int8",
    task: "translation",
    srcLang,
    destLang,
  };
}
