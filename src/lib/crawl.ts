type CrawlEls = {
  scene: HTMLElement;
  motion: HTMLElement;
  head: HTMLElement;
  controls: HTMLElement;
  readme: HTMLElement;
  btn: HTMLButtonElement | null;
};

export class CrawlController {
  private readonly els: CrawlEls;
  private readonly probe: HTMLDivElement;
  private readonly probeEnd: HTMLSpanElement;
  private readonly resize: ResizeObserver;
  private readonly mode: MediaQueryList;
  private readonly onResize: () => void;
  private readonly onMode: () => void;
  private readonly onTheme: () => void;
  private readonly onToggle: () => void;
  private readonly onLoad: () => void;
  private timer: number | undefined;
  private frame: number | undefined;
  private last: string = "";

  constructor(els: CrawlEls) {
    this.els = els;
    this.mode = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.probe = document.createElement("div");
    this.probe.className = "star-wars-crawl-probe";
    this.probe.setAttribute("aria-hidden", "true");
    this.probeEnd = document.createElement("span");
    this.probeEnd.className = "star-wars-crawl-probe-end";
    this.probe.append(this.probeEnd);
    this.els.motion.after(this.probe);
    this.onResize = (): void => this.schedule();
    this.onMode = (): void => this.sync();
    this.onTheme = (): void => this.sync();
    this.onToggle = (): void => this.toggle();
    this.onLoad = (): void => this.schedule();
    this.resize = new ResizeObserver(this.onResize);
    this.resize.observe(els.scene);
    this.resize.observe(els.head);
    this.resize.observe(els.controls);
    this.resize.observe(els.readme);
    els.motion.addEventListener("load", this.onLoad, true);
    els.btn?.addEventListener("click", this.onToggle);
    window.addEventListener("resize", this.onResize, { passive: true });
    window.addEventListener("i18n-toggle-readme", this.onResize);
    window.addEventListener("site-theme-change", this.onTheme);
    this.mode.addEventListener("change", this.onMode);
    void document.fonts.ready.then(this.onResize);
    window.addEventListener("pagehide", (): void => this.dispose(), {
      once: true,
    });
    this.sync();
  }

  private sync(): void {
    const theme: string = document.documentElement.dataset.siteTheme ?? "";
    const disabled: boolean = theme === "star_wars" || theme === "stars";
    for (const id of ["site-style-toggle", "theme-toggle"]) {
      const btn: HTMLElement | null = document.getElementById(id);
      if (!(btn instanceof HTMLButtonElement)) continue;
      btn.disabled = disabled;
      btn.setAttribute("aria-disabled", String(disabled));
      btn.removeAttribute("title");
    }
    this.last = "";
    this.schedule(true);
  }

  private toggle(): void {
    const btn: HTMLButtonElement | null = this.els.btn;
    if (!btn) return;
    const paused: boolean = this.els.scene.dataset.crawlPaused !== "true";
    this.els.scene.dataset.crawlPaused = String(paused);
    btn.setAttribute("aria-pressed", String(paused));
    btn.setAttribute(
      "aria-label",
      paused ? "Play README crawl" : "Pause README crawl",
    );
    btn.title = paused ? "play" : "pause";
  }

  private schedule(immediate = false): void {
    if (this.timer !== undefined) {
      if (!immediate) return;
      window.clearTimeout(this.timer);
    }
    this.timer = window.setTimeout(
      (): void => {
        this.timer = undefined;
        if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
        this.frame = window.requestAnimationFrame((): void => this.measure());
      },
      immediate ? 0 : 450,
    );
  }

  private measure(): void {
    this.frame = undefined;
    const { scene, head, controls, readme, motion } = this.els;
    const rect: DOMRect = scene.getBoundingClientRect();
    const height: number = readme.offsetHeight;
    if (rect.height <= 0 || height <= 0) return;
    const cutoff: number = Math.min(
      rect.height,
      Math.max(
        0,
        Math.ceil(
          Math.max(
            head.getBoundingClientRect().bottom,
            controls.getBoundingClientRect().bottom,
          ) -
            rect.top +
            24,
        ),
      ),
    );
    const boundary: string = `${cutoff}px`;
    if (scene.style.getPropertyValue("--sw-crawl-cutoff") !== boundary) {
      scene.style.setProperty("--sw-crawl-cutoff", boundary);
    }
    scene.dataset.crawlReady = "true";
    if (
      document.documentElement.dataset.siteTheme !== "star_wars" ||
      this.mode.matches
    ) {
      this.last = "";
      return;
    }
    const key: string = `${Math.round(rect.width)}/${Math.round(rect.height)}/${Math.round(height)}/${cutoff}`;
    if (key === this.last) return;
    this.last = key;
    this.probe.style.height = `${height + 1}px`;
    const limit: number = rect.top + cutoff - 12;
    const isHidden: (dist: number) => boolean = (dist: number): boolean => {
      this.probe.style.transform = `translate3d(-50%, -${dist}px, 0)`;
      return this.probeEnd.getBoundingClientRect().top <= limit;
    };
    let low: number = height + 1;
    let high: number = low + Math.max(rect.height * 2, 1200);
    for (
      let attempt: number = 0;
      attempt < 7 && !isHidden(high);
      attempt += 1
    ) {
      high += Math.max(rect.height * 2, 1200) * 2 ** attempt;
    }
    if (isHidden(high)) {
      for (let idx: number = 0; idx < 12; idx += 1) {
        const middle: number = (low + high) / 2;
        if (isHidden(middle)) high = middle;
        else low = middle;
      }
    }
    const step: number = Math.ceil(high + 12);
    motion.style.setProperty("--crawl-step", `${step}px`);
    motion.style.setProperty("--crawl-duration", `${(step / 43).toFixed(3)}s`);
  }

  dispose(): void {
    this.resize.disconnect();
    this.mode.removeEventListener("change", this.onMode);
    this.els.motion.removeEventListener("load", this.onLoad, true);
    this.els.btn?.removeEventListener("click", this.onToggle);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("i18n-toggle-readme", this.onResize);
    window.removeEventListener("site-theme-change", this.onTheme);
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    if (this.frame !== undefined) window.cancelAnimationFrame(this.frame);
    this.probe.remove();
  }
}
