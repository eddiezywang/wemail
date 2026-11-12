// Mono design tokens — the single source of truth for chart visuals.
// Ported from lieflat-charts/mono-tokens.js. Library-agnostic: Chart.js, ECharts, and
// hand-written SVG all consume these values. This module is pure data + math (no DOM),
// so it runs on the server renderer; client-only helpers (el/txt/obsReveal) live in the
// viewer runtime. Per the mono rule "明度即数据": the most important series is the darkest
// ladder step, assigned in fixed order — never cycled or re-ordered by rank.

export const MONO = {
  INK: "#1C1C1A", // 墨：主数据、标题、强调
  PAPER: "#F0EFEB", // 纸：页面/浅卡底色（卡片无边框，靠留白分卡）
  MUTED: "#8F8E88", // 次级文字、副标题
  FAINT: "#C6C5BF", // 来源行、辅助刻度（注意可读性下限 —— 渲染时按需加深）
  GRID: "#DEDDD6", // 网格线、发丝线
  // 7 级灰阶 ladder：多系列时按重要性从黑到浅分配
  L: ["#1C1C1A", "#4A4944", "#6A6963", "#8F8E88", "#B0AFA9", "#C6C5BF", "#D8D7D1"],
  // 5 级简版（waffle 等少系列场景）
  LAD: ["#1C1C1A", "#4A4944", "#8F8E88", "#B0AFA9", "#D8D7D1"],
  // 暗卡：底 #1C1C1A，其上的"墨"反转为纸色
  DARK: {
    bg: "#1C1C1A",
    ink: "#F0EFEB",
    muted: "#8F8E88",
    faint: "#55554F",
    grid: "#2E2D29",
    gridSoft: "#2A2925",
    ladder: ["#F0EFEB", "#DCDAD2", "#C9C7BD", "#B3B0A4", "#8F8E88", "#6A6963", "#4A4944"],
  },
  FONT: {
    family: "Inter",
    link: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap",
    title: { size: 16.5, weight: 700, spacing: "-.02em" },
    titleBig: { size: 19, weight: 700, spacing: "-.02em" },
    sub: { size: 11.5, weight: 400 },
    src: { size: 10.5, weight: 600, spacing: ".02em" }, // WeMail 适配：比 lieflat 更大更深，求可读
    value: { weight: 800 },
    axis: { size: 9.5, weight: 600 },
    minHalf: 6.5, // SVG 半宽卡最小字号
    minWide: 5.5, // SVG 通栏/大图最小字号
  },
  SHAPE: { cardRadius: 24, cardPad: "28px 28px 20px", barRadius: 99, tooltipRadius: 12 },
  MOTION: {
    enter: 900,
    enterSlow: 1200,
    easing: "quarticOut",
    staggerDot: 12, // 8–15 ms/个
    staggerBar: 100, // 80–130 ms/根
    css: `
.pop{transform-box:fill-box;transform-origin:center;animation:pop .5s cubic-bezier(.2,.7,.3,1.3) both}
@keyframes pop{from{transform:scale(0)}to{transform:none}}
.fade{animation:fade .9s ease both}
@keyframes fade{from{opacity:0}}
.draw{stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1s cubic-bezier(.4,0,.2,1) both}
@keyframes draw{to{stroke-dashoffset:0}}
@media(prefers-reduced-motion:reduce){.pop,.fade{animation:none}.draw{animation:none;stroke-dasharray:none;stroke-dashoffset:0}}`,
  },
  // ECharts tooltip presets (light card: ink bg / paper text; dark card: inverse)
  tipLight: {
    backgroundColor: "#1C1C1A",
    borderWidth: 0,
    padding: [10, 14],
    textStyle: { color: "#F0EFEB", fontFamily: "Inter", fontSize: 12 },
  },
  tipDark: {
    backgroundColor: "#F0EFEB",
    borderWidth: 0,
    padding: [10, 14],
    textStyle: { color: "#1C1C1A", fontFamily: "Inter", fontSize: 12 },
  },
} as const;

// Deterministic pseudo-random (demo data only). Never use Math.random — refreshes must
// look identical or screenshots / regression diffs break.
export const rnd = (i: number, k: number): number =>
  Math.abs(((i * 73856093) ^ (k * 19349663)) % 1000) / 1000;

const D2R = Math.PI / 180;
// Polar point on a circle.
export const pol = (cx: number, cy: number, r: number, deg: number): [number, number] => [
  cx + r * Math.cos(deg * D2R),
  cy + r * Math.sin(deg * D2R),
];
// Annular sector path (inner r0 → outer r1, angles a0..a1 in degrees).
export const sect = (cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string => {
  const big = a1 - a0 > 180 ? 1 : 0;
  const [xa, ya] = pol(cx, cy, r1, a0);
  const [xb, yb] = pol(cx, cy, r1, a1);
  const [xc, yc] = pol(cx, cy, r0, a1);
  const [xd, yd] = pol(cx, cy, r0, a0);
  return `M${xa} ${ya} A${r1} ${r1} 0 ${big} 1 ${xb} ${yb} L${xc} ${yc} A${r0} ${r0} 0 ${big} 0 ${xd} ${yd} Z`;
};

// Series color by importance. importance=0 → darkest (most important). Fixed order; a
// change in rank MUST NOT repaint surviving series (callers pass stable importance).
export const seriesColor = (importance: number, dark = false): string => {
  const ladder = dark ? MONO.DARK.ladder : MONO.L;
  return ladder[Math.min(importance, ladder.length - 1)];
};

// Refined palette — AntV hues with ~25% lower saturation for an elegant, professional
// look. Still highly distinguishable but not neon/bright. Suitable for enterprise
// monitoring dashboards. Semantic status colors (red/green/amber) are universal.
export const DATA_COLORS = {
  categorical: ["#5B8AC9", "#5EC0A0", "#5D7092", "#E8B547", "#D67858", "#6DB8D8", "#8B7DB8", "#D99BBA"],
  // Semantic status — for success/failure/warning dimensions. Mandatory: these colors
  // carry meaning (red = bad), they are NOT interchangeable with categorical.
  success: "#52C41A",
  failure: "#FF4D4F",
  warning: "#FAAD14",
  pending: "#1890FF",
  // Status value → semantic color mapping (case-insensitive substring match).
  statusColorFor: (value: string): string | null => {
    const v = value.toLowerCase();
    if (/^(f|fail|error|err|失败|错误|异常)/.test(v)) return DATA_COLORS.failure;
    if (/^(w|warn|alert|告警|警告)/.test(v)) return DATA_COLORS.warning;
    if (/^(s|succ|ok|成功|完成)/.test(v)) return DATA_COLORS.success;
    if (/^(p|pend|process|wait|处理|等待)/.test(v)) return DATA_COLORS.pending;
    return null;
  },
};

// Pick colors for N compared series. If the series names carry status semantics
// (成功/失败/S/F), use semantic colors; otherwise use the categorical palette.
export function seriesPalette(count: number): string[] {
  if (count <= 1) return [MONO.L[0]];
  const c = DATA_COLORS.categorical;
  return Array.from({ length: count }, (_, i) => c[i % c.length]);
}

// Report-level color assigner: ensures the same entity (model/channel/scenario)
// gets the same color across ALL charts in a report. First-appearance order.
// Semantic status colors always win over the active palette (universal data-viz rule).
export class ColorAssigner {
  private map = new Map<string, string>();
  private next = 0;

  constructor(private palette: string[] = DATA_COLORS.categorical) {}

  assign(name: string): string {
    const existing = this.map.get(name);
    if (existing) return existing;
    const semantic = DATA_COLORS.statusColorFor(name);
    const color = semantic ?? this.palette[this.next % this.palette.length];
    if (!semantic) this.next++;
    this.map.set(name, color);
    return color;
  }

  paletteFor(names: string[]): string[] {
    return names.map((n) => this.assign(n));
  }
}

// ── Color systems (single-system lock per delivery) ────────────────
// Ported from lieflat-charts/color-presets.js §6.5, adapted to the WeMail
// report shell. One delivery = ONE color system (mono, a preset, or a custom
// brand colorboard); never mix systems inside a single HTML. Semantic status
// colors (red/green/amber) stay universal and outrank any system.
export type ColorSystemId = "mono" | "porcelain" | "palm" | "wire" | "custom";

export interface ColorSystem {
  id: ColorSystemId;
  label: string;
  cn: string;
  /** Page / card background. */
  bg: string;
  /** Title / primary text. */
  ink: string;
  /** Secondary text / axis labels / source rows. */
  muted: string;
  /** Very faint text (disclaimers). */
  faint: string;
  /** Grid lines / hairlines / rules. */
  grid: string;
  /** Primary data color (single series). */
  data: string;
  /** Secondary data color (multi-series second slot). */
  data2: string;
  /** Emphasis color — give it to exactly one element per view. */
  hero: string;
  /** Faint data color (fills, background marks). */
  faintData: string;
  /** Ordered ramp (light → dark; lightness = value for ordinal data). */
  ramp: string[];
  /** Categorical palette (unordered categories, capacity ≤4–6). */
  cat: string[];
}

// WCAG relative luminance (0..1) and contrast ratio — hard gates for custom colorboards.
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const r = parseInt(c.slice(0, 2), 16) / 255;
  const g = parseInt(c.slice(2, 4), 16) / 255;
  const b = parseInt(c.slice(4, 6), 16) / 255;
  const lin = (v: number) => v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mix color a toward color b by t (0..1). Used to derive light/dark shades without inventing hues. */
export function hexMix(a: string, b: string, t: number): string {
  const pa = parseInt(a.replace("#", ""), 16);
  const pb = parseInt(b.replace("#", ""), 16);
  const ch = (shift: number) => {
    const va = (pa >> shift) & 0xff, vb = (pb >> shift) & 0xff;
    return Math.round(va + (vb - va) * t);
  };
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
}

// Ink boost — colored thin marks vanish on light paper. Non-negotiable when a
// color system other than mono is active: strokes get ×1.8 weight and translucent
// marks never drop below 0.85 opacity. (dot-heat is exempt: its ink is density.)
export const INK_BOOST = {
  strokeScale: 1.8,
  opacityFloor: 0.85,
  exempt: ["dot heat"],
} as const;

export const COLOR_SYSTEMS: Record<ColorSystemId, ColorSystem> = {
  // Mono is the fallback, not the forced answer: it is what we ship when the
  // relationship between color and data is unclear or category count exceeds capacity.
  mono: {
    id: "mono", label: "Mono", cn: "灰阶",
    bg: MONO.PAPER, ink: MONO.INK, muted: MONO.MUTED, faint: MONO.FAINT, grid: MONO.GRID,
    data: MONO.L[0], data2: MONO.L[1], hero: MONO.L[0], faintData: MONO.L[5],
    ramp: [...MONO.L], cat: DATA_COLORS.categorical,
  },
  // 青瓷蓝 — single-hue blue ramp. Fits ordered/ordinal data (trend, progress,
  // time series, single metric, ranking): lightness keeps encoding value.
  porcelain: {
    id: "porcelain", label: "Porcelain", cn: "青瓷蓝",
    bg: "#F7F2EB", ink: "#081F5C", muted: "#5A6C93", faint: "#9AA6BE", grid: "#E2DCD0",
    data: "#334EAC", data2: "#7096D1", hero: "#081F5C", faintData: "#BAD6EB",
    ramp: ["#D0E3FF", "#BAD6EB", "#7096D1", "#334EAC", "#081F5C"],
    cat: ["#081F5C", "#334EAC", "#7096D1", "#BAD6EB"],
  },
  // 椰林绿 — green-yellow low saturation + amber accent. Fits a few unordered
  // categories (source / team / product line / region). Amber is the one focal
  // point and must NOT be treated as a peer category color.
  palm: {
    id: "palm", label: "Palm", cn: "椰林绿",
    bg: "#F0EFEB", ink: "#58402E", muted: "#8A7666", faint: "#B7AFA4", grid: "#DEDCD4",
    data: "#43593B", data2: "#77835A", hero: "#D4A017", faintData: "#ACAD79",
    ramp: ["#F2D17E", "#ACAD79", "#929960", "#77835A", "#43593B"],
    cat: ["#43593B", "#77835A", "#ACAD79", "#F2D17E"],
  },
  // 编辑部红 — black/gray carries all data (like Mono); one fluorescent-orange
  // element is the single focal point (max bar / peak / NET). Never a second orange.
  wire: {
    id: "wire", label: "Wire", cn: "编辑部红",
    bg: "#F0F0EE", ink: "#1F1E1C", muted: "#6E6D66", faint: "#A6A59D", grid: "#DAD9D2",
    data: "#22211F", data2: "#8F8E86", hero: "#F5572F", faintData: "#C0BFB7",
    ramp: ["#DBDAD3", "#C0BFB7", "#8F8E86", "#22211F", "#F5572F"],
    cat: ["#F5572F", "#22211F", "#8F8E86", "#C0BFB7"],
  },
  // Placeholder; resolved through buildCustomColorSystem().
  custom: {
    id: "custom", label: "Custom", cn: "自定义色板",
    bg: "#FFFFFF", ink: "#1F1E1C", muted: "#6E6D66", faint: "#A6A59D", grid: "#DAD9D2",
    data: "#5B8AC9", data2: "#5EC0A0", hero: "#E8B547", faintData: "#B8C4CE",
    ramp: ["#DCE4EE", "#B8C4CE", "#8B9AA8", "#5B8AC9", "#1F3A5F"],
    cat: DATA_COLORS.categorical,
  },
};

/**
 * Build a custom brand colorboard from user-provided hexes (lieflat §6.5 rules):
 * - 1 color → same-hue lightness ramp; 2 colors → data + hero; 3–6 → categorical.
 * - Light shades are the user color mixed toward BG, dark shades toward TXT — never
 *   borrow hues from the built-in presets.
 * - Contrast is a hard gate: body text ≥4.5:1, large text ≥3:1.
 */
export function buildCustomColorSystem(hexes: string[]): ColorSystem | null {
  const clean = hexes.map((hex) => hex.trim()).filter((hex) => /^#?[0-9a-fA-F]{6}$/.test(hex));
  if (!clean.length) return null;
  const norm = clean.map((hex) => (hex.startsWith("#") ? hex : `#${hex}`).toLowerCase());
  const bg = "#F7F5F0";
  const ink = norm.length >= 2 ? norm[1] : norm[0];
  const data = norm[0];
  const hero = norm[1] ?? norm[0];
  const muted = hexMix(ink, bg, 0.45);
  const faint = hexMix(ink, bg, 0.72);
  const grid = hexMix(ink, bg, 0.86);
  const light = hexMix(data, bg, 0.62);
  const mid = hexMix(data, bg, 0.28);
  const dark = hexMix(data, ink, 0.35);
  const ramp = norm.length === 1
    ? [light, mid, data, dark, ink]
    : [light, mid, data, dark, hero];
  const cat = norm.length >= 3 ? norm.slice(0, 6) : [data, hero, mid, light];
  return {
    id: "custom", label: "Custom", cn: "自定义色板",
    bg, ink, muted, faint, grid,
    data, data2: mid, hero, faintData: light,
    ramp, cat,
  };
}

// Human-word → preset mapping (users never say "porcelain", they say 蓝/暖/克制).
const PRESET_BY_WORD: Array<{ re: RegExp; id: ColorSystemId }> = [
  { re: /蓝|冷|学术|理性|严肃|科技/, id: "porcelain" },
  { re: /绿|暖|自然|温柔|复古|莫兰迪/, id: "palm" },
  { re: /黑白|克制|杂志|编辑部|黑白/, id: "wire" },
];

/**
 * Resolve the active color system for a delivery. Accepts "auto" (default), a preset
 * id ("porcelain" / "palm" / "wire" / "mono"), a legacy "wemail-*" theme name, or
 * "custom:#RRGGBB,#RRGGBB". When absent/auto, we only auto-select when the fit is
 * unambiguous — explicit intent words (蓝/暖/克制…) or a temporal axis (ordered data
 * → porcelain blue ramp). Everything else stays Mono, the safe fallback that preserves
 * the house style (AntV categorical for multi-series comparison). palm/wire remain
 * available by explicit request; category-count heuristics alone are not enough to
 * re-skin an enterprise monitoring report.
 */
export function resolveColorSystem(
  designSystem: string | undefined,
  intent: string,
  temporal: boolean,
): ColorSystem {
  const spec = String(designSystem ?? "").toLowerCase().trim();
  if (spec.startsWith("custom:")) {
    const hexes = spec.slice("custom:".length).split(",");
    return buildCustomColorSystem(hexes) ?? COLOR_SYSTEMS.mono;
  }
  const id = (spec.replace(/^wemail-/, "") || "auto") as ColorSystemId | "auto";
  if (id !== "auto" && id in COLOR_SYSTEMS) return COLOR_SYSTEMS[id];
  // Auto: explicit intent words win.
  for (const { re, id: presetId } of PRESET_BY_WORD) {
    if (re.test(intent)) return COLOR_SYSTEMS[presetId];
  }
  // Auto: temporal/ordered data → blue ramp (lightness still encodes value).
  if (temporal) return COLOR_SYSTEMS.porcelain;
  return COLOR_SYSTEMS.mono;
}


// Shared card CSS for the report shell. Computed from tokens so color changes land here too.
export const CARD_CSS = `
:root{--bg:${MONO.PAPER};--dark:${MONO.DARK.bg};--ink:${MONO.INK};--muted:${MONO.MUTED};--faint:${MONO.FAINT};--grid:${MONO.GRID}}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--bg);font-family:'Inter',sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
.card{background:var(--bg);border-radius:${MONO.SHAPE.cardRadius}px;padding:${MONO.SHAPE.cardPad}}
.card.dark{background:var(--dark);color:${MONO.PAPER}}
h2{font-weight:${MONO.FONT.title.weight};font-size:${MONO.FONT.title.size}px;letter-spacing:${MONO.FONT.title.spacing};margin-bottom:3px}
.sub{font-size:${MONO.FONT.sub.size}px;color:var(--muted);margin-bottom:14px}
.src{font-size:${MONO.FONT.src.size}px;color:${MONO.MUTED};margin-top:12px;letter-spacing:${MONO.FONT.src.spacing};font-weight:${MONO.FONT.src.weight}}
${MONO.MOTION.css}`;
