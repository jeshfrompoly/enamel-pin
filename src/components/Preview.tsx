"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { EffectComposer, Bloom, N8AO } from "@react-three/postprocessing";
import type { SceneControls } from "@/hooks/useSceneControls";
import ExtrudedSVG from "./ExtrudedSVG";
import { HDRI_FILES } from "@/data/hdri";
import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as THREE from "three";
import { RGBELoader } from "three-stdlib";
import { HDRJPGLoader } from "@monogrid/gainmap-js";

type PreviewShadow = {
  enabled: boolean;
  distance: number;
  angle: number;
  blur: number;
  opacity: number;
  color: string;
  layers: number;
};

const PREVIEW_SHADOW_STORAGE_KEY = "enamel-pin-preview-shadow";
const SHADOW_PRESET_OVERRIDES_STORAGE_KEY = "enamel-pin-shadow-preset-overrides";

const DEFAULT_PREVIEW_SHADOW: PreviewShadow = {
  enabled: true,
  distance: 65,
  angle: 90,
  blur: 20,
  opacity: 1.1,
  color: "#000000",
  layers: 4,
};

// Preset chips for the shadow panel. Angle/color/layers match defaults so the
// chips only vary the three dials that actually change a shadow's feel:
// distance, blur, opacity. "None" disables the stack entirely.
const BASE_SHADOW_PRESETS: { name: string; value: PreviewShadow }[] = [
  {
    name: "None",
    value: { ...DEFAULT_PREVIEW_SHADOW, enabled: false },
  },
  {
    name: "Soft",
    value: { enabled: true, distance: 32, angle: 90, blur: 28, opacity: 0.95, color: "#000000", layers: 4 },
  },
  {
    name: "Medium",
    value: { ...DEFAULT_PREVIEW_SHADOW },
  },
];

function shadowsEqual(a: PreviewShadow, b: PreviewShadow): boolean {
  if (a.enabled !== b.enabled) return false;
  if (!a.enabled) return true; // when disabled, the other dials don't matter
  return (
    a.distance === b.distance &&
    a.angle === b.angle &&
    a.blur === b.blur &&
    Math.abs(a.opacity - b.opacity) < 1e-6 &&
    a.layers === b.layers &&
    a.color.toLowerCase() === b.color.toLowerCase()
  );
}

function loadPresetOverrides(): Record<string, PreviewShadow> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(SHADOW_PRESET_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function loadPreviewShadow(): PreviewShadow {
  if (typeof window === "undefined") return DEFAULT_PREVIEW_SHADOW;
  try {
    const raw = localStorage.getItem(PREVIEW_SHADOW_STORAGE_KEY);
    if (!raw) return DEFAULT_PREVIEW_SHADOW;
    const parsed = JSON.parse(raw) as Partial<PreviewShadow>;
    return { ...DEFAULT_PREVIEW_SHADOW, ...parsed };
  } catch {
    return DEFAULT_PREVIEW_SHADOW;
  }
}

// Ratios chosen to reproduce a natural 4-layer shadow stack: layers fall at
// 0.062/0.253/0.562/1.0 of distance, blur at 0.352/0.634/0.845/1.0 of blur,
// with a fixed opacity taper.
const LAYER_DISTANCE_RATIOS = [0.062, 0.253, 0.562, 1.0];
const LAYER_BLUR_RATIOS = [0.352, 0.634, 0.845, 1.0];
const LAYER_OPACITIES = [0.12, 0.1, 0.06, 0.02];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function buildShadowFilter(s: PreviewShadow, scale = 1): string {
  if (!s.enabled) return "none";
  const [r, g, b] = hexToRgb(s.color);
  const rad = (s.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const parts: string[] = [];
  const count = Math.max(1, Math.min(4, Math.round(s.layers)));
  for (let i = 4 - count; i < 4; i++) {
    const d = s.distance * LAYER_DISTANCE_RATIOS[i] * scale;
    const bl = s.blur * LAYER_BLUR_RATIOS[i] * scale;
    const op = LAYER_OPACITIES[i] * s.opacity;
    const x = +(ux * d).toFixed(3);
    const y = +(uy * d).toFixed(3);
    parts.push(`drop-shadow(${x}px ${y}px ${bl.toFixed(3)}px rgba(${r},${g},${b},${op.toFixed(4)}))`);
  }
  return parts.join(" ");
}

function ShadowRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  suffix,
  decimals = 0,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  suffix?: string;
  decimals?: number;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] w-14 shrink-0 text-black/50">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 min-w-0 h-1 accent-black/70"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={decimals > 0 ? value.toFixed(decimals) : value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
        }}
        className="w-12 text-right text-[10px] font-mono px-1.5 py-0.5 rounded border bg-black/[0.03] border-black/[0.06] text-black/70 outline-none focus:border-black/20 tabular-nums"
      />
      {suffix ? (
        <span className="text-[9px] w-2 shrink-0 text-black/30">{suffix}</span>
      ) : null}
    </div>
  );
}

/**
 * Captures the canvas as a data URL after a delay to allow
 * environment maps, geometry, and materials to fully load. When bloom is
 * on, the EffectComposer owns the render loop — calling gl.render directly
 * would bypass post-processing, so rely on the always-on frameloop instead.
 */
/**
 * Loads the environment map directly into Preview's own WebGL context.
 *
 * Drei's <Environment> routes JPG files through @monogrid's HDRJPGLoader,
 * which decodes the gainmap into a WebGLRenderTarget texture bound to the
 * renderer that did the decode. Since drei's useLoader caches globally, the
 * main canvas's loader callback wins the cache and later mounts — including
 * this offscreen Preview canvas — get a texture built against the main gl
 * context, which samples as black here. Loading imperatively in Preview's
 * own gl gives each canvas a renderer-native texture.
 *
 * HDR files go through RGBELoader which yields a plain DataTexture (no gl
 * state), so they don't have this problem — but routing everything through
 * the same path keeps the load behavior uniform.
 */
function PreviewEnvironment({ file, rotation }: { file: string; rotation: number }) {
  const { scene, gl } = useThree();

  useEffect(() => {
    let cancelled = false;
    let loaded: THREE.Texture | null = null;

    const apply = (texture: THREE.Texture) => {
      if (cancelled) {
        texture.dispose();
        return;
      }
      texture.mapping = THREE.EquirectangularReflectionMapping;
      loaded = texture;
      scene.environment = texture;
    };

    const ext = file.split(".").pop()?.toLowerCase();
    if (ext === "jpg" || ext === "jpeg") {
      const loader = new HDRJPGLoader(gl);
      loader.load(file, (result) => apply(result.renderTarget.texture));
    } else {
      const loader = new RGBELoader();
      loader.load(file, apply);
    }

    return () => {
      cancelled = true;
      if (scene.environment === loaded) scene.environment = null;
      loaded?.dispose();
    };
  }, [file, gl, scene]);

  useEffect(() => {
    const rot = (scene as unknown as { environmentRotation?: THREE.Euler }).environmentRotation;
    if (rot) rot.set(0, (rotation * Math.PI) / 180, 0);
  }, [scene, rotation]);

  return null;
}

type HighResCapture = (size: number) => Promise<string | null>;

function HighResCapturer({ captureRef }: { captureRef: React.MutableRefObject<HighResCapture | null> }) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    captureRef.current = async (size: number) => {
      const prevPR = gl.getPixelRatio();
      const prevW = gl.domElement.width;
      const prevH = gl.domElement.height;
      try {
        gl.setPixelRatio(1);
        gl.setSize(size, size, false);
        // Mirror scene.environment onto each material's envMap (same fix as Capturer).
        const env = scene.environment;
        scene.traverse((obj) => {
          const mesh = obj as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (m && "envMap" in m) {
              const mat = m as THREE.MeshStandardMaterial;
              if (mat.envMap !== env) {
                mat.envMap = env;
                mat.needsUpdate = true;
              }
            }
          }
        });
        // Two renders: first to compile / warm, second to produce the final image.
        // This bypasses the EffectComposer, so post-fx (bloom, AO) don't appear in
        // high-res exports — acceptable trade-off for crisp geometry at 4K+.
        gl.render(scene, camera);
        gl.render(scene, camera);
        return gl.domElement.toDataURL("image/png");
      } finally {
        gl.setPixelRatio(prevPR);
        gl.setSize(prevW, prevH, false);
      }
    };
    return () => { captureRef.current = null; };
  }, [gl, scene, camera, captureRef]);
  return null;
}

function Capturer({ onCapture, composerOn, envEnabled, nonce }: { onCapture: (url: string) => void; composerOn: boolean; envEnabled: boolean; nonce: number }) {
  const { gl, scene, camera } = useThree();

  useEffect(() => {
    if (nonce === 0) return; // don't capture on initial mount
    let cancelled = false;
    let pollId: number | null = null;
    let settleTimer: number | null = null;

    // Walk the scene and mirror scene.environment onto every PBR material's
    // envMap. We do this explicitly here instead of relying on ExtrudedSVG's
    // useFrame because the offscreen Canvas doesn't always receive rAF ticks
    // reliably, so useFrame can skip — leaving envMap unbound at capture time.
    const applyEnvMap = () => {
      const env = scene.environment;
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          if (m && "envMap" in m) {
            const mat = m as THREE.MeshStandardMaterial;
            if (mat.envMap !== env) {
              mat.envMap = env;
              mat.needsUpdate = true;
            }
          }
        }
      });
    };

    const capture = () => {
      if (cancelled) return;
      applyEnvMap();
      // Two renders: first compiles the shader with the new envMap, second
      // produces the final image that toDataURL reads. When the EffectComposer
      // is mounted (bloom or AO) it owns the render loop, so calling gl.render
      // directly would bypass post-processing.
      if (!composerOn) {
        gl.render(scene, camera);
        gl.render(scene, camera);
      }
      onCapture(gl.domElement.toDataURL("image/png"));
    };

    // Wait for PreviewEnvironment to populate scene.environment (its loader
    // resolves asynchronously).
    const waitForEnv = () => {
      if (cancelled) return;
      if (!envEnabled || scene.environment) {
        settleTimer = window.setTimeout(capture, 200);
        return;
      }
      pollId = window.setTimeout(waitForEnv, 50);
    };

    const initial = window.setTimeout(waitForEnv, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(initial);
      if (pollId !== null) window.clearTimeout(pollId);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [gl, scene, camera, onCapture, composerOn, envEnabled, nonce]);

  return null;
}

interface PreviewProps {
  svgString: string;
  iconName?: string | null;
  presetName?: string | null;
  colorOverride: string | null;
  onPickColor: (hex: string | null) => void;
  controls: SceneControls;
}

const COLOR_PRESETS: { name: string; hex: string | null }[] = [
  { name: "None", hex: null },
  { name: "Antique Gold", hex: "#4E4122" },
  { name: "Warm Gray", hex: "#594E3B" },
  { name: "Deep Teal", hex: "#1C4A47" },
  { name: "Slate", hex: "#34414C" },
  { name: "Neutral", hex: "#464749" },
];

const ACCENT_PRESET_OVERRIDES_STORAGE_KEY = "enamel-pin-accent-preset-overrides";

function loadAccentPresetOverrides(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(ACCENT_PRESET_OVERRIDES_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

type Hsl = { h: number; s: number; l: number };

function hexToHslValue(hex: string): Hsl {
  const h = hex.replace("#", "");
  const r = parseInt(h.substring(0, 2), 16) / 255;
  const g = parseInt(h.substring(2, 4), 16) / 255;
  const b = parseInt(h.substring(4, 6), 16) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let hh = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    switch (mx) {
      case r: hh = (g - b) / d + (g < b ? 6 : 0); break;
      case g: hh = (b - r) / d + 2; break;
      case b: hh = (r - g) / d + 4; break;
    }
    hh /= 6;
  }
  return { h: Math.round(hh * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

function hslToHexValue({ h, s, l }: Hsl): string {
  const hn = (h % 360 + 360) % 360 / 360;
  const sn = Math.max(0, Math.min(1, s / 100));
  const ln = Math.max(0, Math.min(1, l / 100));
  if (sn === 0) {
    const v = Math.round(ln * 255);
    const hx = v.toString(16).padStart(2, "0");
    return `#${hx}${hx}${hx}`;
  }
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const h2r = (pp: number, qq: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return pp + (qq - pp) * 6 * t;
    if (t < 1 / 2) return qq;
    if (t < 2 / 3) return pp + (qq - pp) * (2 / 3 - t) * 6;
    return pp;
  };
  const r = Math.round(h2r(p, q, hn + 1 / 3) * 255);
  const g = Math.round(h2r(p, q, hn) * 255);
  const b = Math.round(h2r(p, q, hn - 1 / 3) * 255);
  const hx = (n: number) => n.toString(16).padStart(2, "0");
  return `#${hx(r)}${hx(g)}${hx(b)}`;
}

function toKebab(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

export default function Preview({ svgString, iconName, presetName, colorOverride, onPickColor, controls }: PreviewProps) {
  const { extrusion, material, uvMap, enamel, postfx, transform, lighting, env, cameraSettings } = controls;

  const [imageUrl, setImageUrl] = useState<string | null>(null);
  // Drives captures without unmounting the Canvas — remounting burns through
  // WebGL contexts and the browser force-drops them, leaving the preview stuck
  // in a context-lost state where env maps never bind.
  const [captureNonce, setCaptureNonce] = useState(0);
  const [rendering, setRendering] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const handleCapture = useCallback((url: string) => {
    setImageUrl(url);
    setRendering(false);
  }, []);

  const refreshPreview = useCallback(() => {
    setRendering(true);
    setCaptureNonce((n) => n + 1);
  }, []);

  // Preview shadow lives on its own storage key so it's decoupled from the
  // scene settings and never captured by the preset save/apply flow.
  const [previewShadow, setPreviewShadow] = useState<PreviewShadow>(loadPreviewShadow);
  useEffect(() => {
    try {
      localStorage.setItem(PREVIEW_SHADOW_STORAGE_KEY, JSON.stringify(previewShadow));
    } catch {}
  }, [previewShadow]);
  const updateShadow = useCallback(
    <K extends keyof PreviewShadow>(key: K, value: PreviewShadow[K]) => {
      setPreviewShadow((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const [presetOverrides, setPresetOverrides] = useState<Record<string, PreviewShadow>>(loadPresetOverrides);
  useEffect(() => {
    try {
      localStorage.setItem(SHADOW_PRESET_OVERRIDES_STORAGE_KEY, JSON.stringify(presetOverrides));
    } catch {}
  }, [presetOverrides]);
  const shadowPresets = useMemo(
    () => BASE_SHADOW_PRESETS.map((p) => (presetOverrides[p.name] ? { name: p.name, value: presetOverrides[p.name] } : p)),
    [presetOverrides]
  );
  const [holdingPreset, setHoldingPreset] = useState<string | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const suppressClickRef = useRef<string | null>(null);
  const previewShadowRef = useRef(previewShadow);
  previewShadowRef.current = previewShadow;

  const [accentPresetOverrides, setAccentPresetOverrides] = useState<Record<string, string>>(loadAccentPresetOverrides);
  useEffect(() => {
    try {
      localStorage.setItem(ACCENT_PRESET_OVERRIDES_STORAGE_KEY, JSON.stringify(accentPresetOverrides));
    } catch {}
  }, [accentPresetOverrides]);
  const resolvedAccentPresets = useMemo(
    () => COLOR_PRESETS.map((p) => (p.hex && accentPresetOverrides[p.name] ? { ...p, hex: accentPresetOverrides[p.name] } : p)),
    [accentPresetOverrides]
  );

  const [workingHsl, setWorkingHsl] = useState<Hsl | null>(() => (colorOverride ? hexToHslValue(colorOverride) : null));
  const workingHex = workingHsl ? hslToHexValue(workingHsl) : null;

  // Push slider/chip edits up to Scene. Use a ref to avoid firing onPickColor
  // when the parent itself is the source of the change (see next effect).
  const lastSyncedRef = useRef<string | null>(colorOverride);
  useEffect(() => {
    if (workingHex !== lastSyncedRef.current) {
      lastSyncedRef.current = workingHex;
      onPickColor(workingHex);
    }
  }, [workingHex, onPickColor]);

  // If Scene cleared the override externally (e.g. Material.color changed via
  // Leva), drop our local HSL so the sliders and the "None" chip re-align.
  useEffect(() => {
    if (colorOverride === null && workingHsl !== null) {
      lastSyncedRef.current = null;
      setWorkingHsl(null);
    }
  }, [colorOverride, workingHsl]);

  const [accentSettingsOpen, setAccentSettingsOpen] = useState(false);
  const [holdingAccent, setHoldingAccent] = useState<string | null>(null);
  const accentHoldTimerRef = useRef<number | null>(null);
  const accentSuppressClickRef = useRef<string | null>(null);
  const workingHexRef = useRef(workingHex);
  workingHexRef.current = workingHex;
  const clearAccentHoldTimer = useCallback(() => {
    if (accentHoldTimerRef.current !== null) {
      window.clearTimeout(accentHoldTimerRef.current);
      accentHoldTimerRef.current = null;
    }
    setHoldingAccent(null);
  }, []);
  const startAccentHold = useCallback((name: string) => {
    clearAccentHoldTimer();
    setHoldingAccent(name);
    accentHoldTimerRef.current = window.setTimeout(() => {
      const hex = workingHexRef.current;
      if (hex) setAccentPresetOverrides((prev) => ({ ...prev, [name]: hex }));
      accentSuppressClickRef.current = name;
      accentHoldTimerRef.current = null;
      setHoldingAccent(null);
    }, 1000);
  }, [clearAccentHoldTimer]);
  useEffect(() => () => clearAccentHoldTimer(), [clearAccentHoldTimer]);
  const clearHoldTimer = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
    setHoldingPreset(null);
  }, []);
  const startPresetHold = useCallback((name: string) => {
    clearHoldTimer();
    setHoldingPreset(name);
    holdTimerRef.current = window.setTimeout(() => {
      setPresetOverrides((prev) => ({ ...prev, [name]: { ...previewShadowRef.current } }));
      suppressClickRef.current = name;
      holdTimerRef.current = null;
      setHoldingPreset(null);
    }, 1000);
  }, [clearHoldTimer]);
  useEffect(() => () => clearHoldTimer(), [clearHoldTimer]);

  const shadowCss = useMemo(() => buildShadowFilter(previewShadow), [previewShadow]);

  const [exportSize, setExportSize] = useState<number>(1024);
  const highResCaptureRef = useRef<HighResCapture | null>(null);

  // Compose the preview square — transparent bg + icon at 70% with the same
  // drop-shadow stack as the DOM preview — then download it. Shadow radii
  // scale with canvas size so the exported image matches what's on screen.
  const shadowRef = useRef(previewShadow);
  shadowRef.current = previewShadow;
  const renderPreviewCanvas = useCallback((targetSize: number, sourceUrl?: string | null) => {
    const src = sourceUrl ?? imageUrl;
    if (!src) return Promise.resolve<HTMLCanvasElement | null>(null);
    return new Promise<HTMLCanvasElement | null>((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = targetSize;
        canvas.height = targetSize;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(null);
          return;
        }

        const iconSize = targetSize * 0.7;
        const iconOffset = (targetSize - iconSize) / 2;
        // 250 matches the DOM's preview box used to author the original defaults.
        const scale = iconSize / 250;
        ctx.filter = buildShadowFilter(shadowRef.current, scale);
        ctx.drawImage(img, iconOffset, iconOffset, iconSize, iconSize);
        ctx.filter = "none";

        resolve(canvas);
      };
      img.onerror = reject;
      img.src = src;
    });
  }, [imageUrl]);

  // For >1024, re-render the WebGL scene at iconSize so the export is crisp
  // rather than an upscale of the on-screen capture.
  const captureForExport = useCallback(async (targetSize: number) => {
    if (targetSize <= 1024 || !highResCaptureRef.current) return null;
    const iconPx = Math.round(targetSize * 0.7);
    return highResCaptureRef.current(iconPx);
  }, []);

  const exportPreview = useCallback(async () => {
    const hi = await captureForExport(exportSize);
    const canvas = await renderPreviewCanvas(exportSize, hi);
    if (!canvas) return;
    const link = document.createElement("a");
    link.href = canvas.toDataURL("image/png");
    const icon = toKebab(iconName || "icon");
    const preset = toKebab(presetName || "default");
    link.download = `${icon || "icon"}-${preset || "default"}-${exportSize}.png`;
    link.click();
  }, [renderPreviewCanvas, captureForExport, exportSize, iconName, presetName]);

  const [shadowSettingsOpen, setShadowSettingsOpen] = useState(false);

  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const copyPreview = useCallback(async () => {
    try {
      const hi = await captureForExport(exportSize);
      const canvas = await renderPreviewCanvas(exportSize, hi);
      if (!canvas) return;
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("toBlob returned null");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  }, [renderPreviewCanvas, captureForExport, exportSize]);

  // Resolve toggled values from controls lifted from Scene
  const ext = {
    depth: extrusion.depthOn ? extrusion.depth : 0,
    bevelEnabled: extrusion.bevelOn,
    bevelThickness: extrusion.bevelOn ? extrusion.bevelThickness : 0,
    bevelSize: extrusion.bevelOn ? extrusion.bevelSize : 0,
    bevelSegments: extrusion.bevelOn ? extrusion.bevelSegments : 1,
    bevelOffset: extrusion.bevelOn
      ? (extrusion.bevelInward ? -extrusion.bevelSize + extrusion.bevelOffset : extrusion.bevelOffset)
      : 0,
    curveSegments: extrusion.curveSegments,
    pathResolution: extrusion.pathResolution,
    cornerRadius: extrusion.cornerRadiusOn ? extrusion.cornerRadius : 0,
    outerCornerRadius: extrusion.cornerRadiusOn ? extrusion.outerCornerRadius : 0,
    innerCornerRadius: extrusion.cornerRadiusOn ? extrusion.innerCornerRadius : 0,
    solidify: extrusion.solidify,
    solidBack: extrusion.solidBack,
    inflation: extrusion.inflationOn ? extrusion.inflation : 0,
    extrudeSteps: extrusion.extrudeSteps,
    smoothShading: extrusion.smoothShading,
    creaseAngle: extrusion.creaseAngle,
  };
  const mat = {
    color: material.colorOn ? (colorOverride ?? material.color) : "#808080",
    roughness: material.roughnessOn ? material.roughness : 0.5,
    metalness: material.metalnessOn ? material.metalness : 0,
    clearcoat: material.clearcoatOn ? material.clearcoat : 0,
    clearcoatRoughness: material.clearcoatRoughnessOn ? material.clearcoatRoughness : 0.5,
    envMapIntensity: material.envMapIntensityOn ? material.envMapIntensity : 1,
    transmission: material.transmissionOn ? material.transmission : 0,
    thickness: material.thicknessOn ? material.thickness : 0,
    ior: material.iorOn ? material.ior : 1.5,
    dispersion: material.dispersionOn ? material.dispersion : 0,
    normalMapOn: material.normalMapOn,
    normalMapType: material.normalMapType as string,
    normalScale: material.normalScale,
    displacementScale: material.displacementScale,
    displacementBias: material.displacementBias,
    bloomOn: material.bloomOn,
    bloomIntensity: material.bloomIntensity,
    bloomThreshold: material.bloomThreshold,
    bloomRadius: material.bloomRadius,
    aoOn: postfx.aoOn,
    aoIntensity: postfx.aoIntensity,
    aoRadius: postfx.aoRadius,
    aoFalloff: postfx.aoFalloff,
    aoColor: postfx.aoColor,
    enamelOn: enamel.enamelOn,
    enamelColor: enamel.enamelColor,
    enamelOffset: enamel.enamelOffset,
    enamelDome: enamel.enamelDome,
    enamelZ: enamel.enamelZ,
    enamelRoughness: enamel.enamelRoughness,
    enamelMetalness: enamel.enamelMetalness,
    enamelClearcoat: enamel.enamelClearcoat,
    enamelClearcoatRoughness: enamel.enamelClearcoatRoughness,
    enamelEnvMapIntensity: enamel.enamelEnvMapIntensity,
  };
  const rot: [number, number, number] = transform.rotationOn
    ? [transform.rotationX, transform.rotationY, transform.rotationZ]
    : [0, 0, 0];
  const scl = transform.scaleOn ? transform.scale : 0.04;

  // Re-capture whenever the SVG or any scene-level control changes. The
  // controls sub-objects (extrusion, material, etc.) are new references when
  // Leva updates a leaf value, so referencing them as deps is enough to
  // trigger a fresh capture on each tweak.
  useEffect(() => {
    setRendering(true);
    setCaptureNonce((n) => n + 1);
  }, [svgString, extrusion, material, uvMap, enamel, postfx, transform, lighting, env, cameraSettings, colorOverride]);

  return (
    <div className="w-full min-h-screen" style={{ background: "#ffffff" }}>
      {/* Preview header */}
      <div className="relative z-10 p-6 pb-2 flex items-center justify-between">
        <span className="text-sm font-medium text-black/60">
          Preview
        </span>
      </div>

      {/* Preview area */}
      <div className="relative flex items-center justify-center p-6">
        <div className="relative z-10 w-full flex flex-col items-center gap-3">
          <div
            className="group relative w-full bg-white rounded-lg flex items-center justify-center border border-black/[0.08] overflow-hidden"
            style={{ aspectRatio: "1 / 1" }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt="Preview"
                style={{
                  width: "70%",
                  aspectRatio: "1 / 1",
                  objectFit: "contain",
                  filter: shadowCss,
                }}
              />
            ) : null}
            <button
              type="button"
              onClick={refreshPreview}
              title="Refresh preview"
              aria-label="Refresh preview"
              className="absolute top-2 right-2 w-7 h-7 flex items-center justify-center rounded-full bg-white/80 backdrop-blur-sm border border-black/[0.06] text-black/60 hover:text-black/90 hover:bg-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className={rendering ? "animate-spin" : ""}>
                <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none" />
                <path d="M13.5 2.5v3h-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            </button>
          </div>
          <div className="w-full flex items-center gap-2">
            <button
              onClick={exportPreview}
              disabled={!imageUrl}
              className="text-xs px-2.5 py-1 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 disabled:hover:bg-black/[0.04] text-black/60 rounded-full transition-colors whitespace-nowrap"
            >
              Export PNG
            </button>
            <button
              onClick={copyPreview}
              disabled={!imageUrl}
              className="text-xs px-2.5 py-1 bg-black/[0.04] hover:bg-black/[0.08] disabled:opacity-40 disabled:hover:bg-black/[0.04] text-black/60 rounded-full transition-colors whitespace-nowrap"
            >
              {copyState === "copied" ? "Copied!" : copyState === "error" ? "Copy failed" : "Copy PNG"}
            </button>
            <label className="relative ml-auto text-xs text-black/60">
              <select
                value={exportSize}
                onChange={(e) => setExportSize(parseInt(e.target.value, 10))}
                className="appearance-none text-xs pl-2.5 pr-6 py-1 bg-black/[0.04] hover:bg-black/[0.08] text-black/60 rounded-full transition-colors whitespace-nowrap cursor-pointer outline-none"
                aria-label="Export size"
                title="Export size (pixels)"
              >
                <option value={1024}>1024 px</option>
                <option value={2048}>2048 px</option>
                <option value={4096}>4096 px (4K)</option>
                <option value={8192}>8192 px (8K)</option>
                <option value={16384}>16384 px (16K)</option>
              </select>
              <svg
                width="10"
                height="6"
                viewBox="0 0 10 6"
                className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none opacity-50"
              >
                <path d="M0 0l5 6 5-6z" fill="currentColor" />
              </svg>
            </label>
          </div>

          {presetName === "Classic Metal" && <div className="w-[calc(100%+3rem)] -mx-6 px-6 mt-4 pt-4 border-t border-black/[0.06]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-black/40">
                Accent Color
              </span>
              <button
                onClick={() => setAccentSettingsOpen((v) => !v)}
                aria-expanded={accentSettingsOpen}
                aria-label={accentSettingsOpen ? "Hide accent color settings" : "Show accent color settings"}
                className="text-black/40 hover:text-black/70 transition-colors p-0.5"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  className={`transition-transform ${accentSettingsOpen ? "rotate-180" : ""}`}
                >
                  <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="flex flex-wrap gap-1 mb-3">
              {resolvedAccentPresets.map((p) => {
                let active = false;
                if (p.hex === null) {
                  active = workingHsl === null;
                } else if (workingHsl) {
                  const ph = hexToHslValue(p.hex);
                  active = ph.h === workingHsl.h && ph.s === workingHsl.s && ph.l === workingHsl.l;
                }
                const activeCls = "bg-black/80 text-white";
                const idleCls = "bg-black/[0.04] text-black/60 hover:bg-black/[0.08]";
                const holding = holdingAccent === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => {
                      if (accentSuppressClickRef.current === p.name) {
                        accentSuppressClickRef.current = null;
                        return;
                      }
                      setWorkingHsl(p.hex ? hexToHslValue(p.hex) : null);
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      if (p.hex === null) return; // can't save to "None"
                      startAccentHold(p.name);
                    }}
                    onPointerUp={clearAccentHoldTimer}
                    onPointerLeave={clearAccentHoldTimer}
                    onPointerCancel={clearAccentHoldTimer}
                    title={p.hex === null ? "Clear accent color" : `Click to apply. Hold 1s to save current color as "${p.name}".`}
                    className={`text-xs pl-2 pr-2.5 py-1 rounded-full transition-all select-none whitespace-nowrap inline-flex items-center gap-1.5 ${active ? activeCls : idleCls} ${holding ? "scale-95 ring-2 ring-offset-0 ring-black/40" : ""}`}
                  >
                    {p.hex && (
                      <span
                        className="w-2.5 h-2.5 rounded-full ring-1 ring-black/10 shrink-0"
                        style={{ backgroundColor: p.hex }}
                      />
                    )}
                    {p.name}
                  </button>
                );
              })}
            </div>
            {accentSettingsOpen && <div className="space-y-2 mb-3">
              <ShadowRow
                label="hue"
                value={workingHsl?.h ?? 0}
                min={0}
                max={360}
                step={1}
                onChange={(v) => setWorkingHsl((prev) => ({ h: v, s: prev?.s ?? 50, l: prev?.l ?? 50 }))}
                suffix="°"
              />
              <ShadowRow
                label="saturation"
                value={workingHsl?.s ?? 0}
                min={0}
                max={100}
                step={1}
                onChange={(v) => setWorkingHsl((prev) => ({ h: prev?.h ?? 0, s: v, l: prev?.l ?? 50 }))}
              />
              <ShadowRow
                label="lightness"
                value={workingHsl?.l ?? 50}
                min={0}
                max={100}
                step={1}
                onChange={(v) => setWorkingHsl((prev) => ({ h: prev?.h ?? 0, s: prev?.s ?? 50, l: v }))}
              />
              <div className="flex items-center gap-2">
                <span className="text-[10px] w-14 shrink-0 text-black/50">hex</span>
                <span
                  className="w-4 h-4 rounded-sm ring-1 ring-black/10 shrink-0"
                  style={{ backgroundColor: workingHex ?? "transparent" }}
                />
                <input
                  type="text"
                  value={workingHex ?? ""}
                  placeholder="#—"
                  onChange={(e) => {
                    const v = e.target.value.trim();
                    if (/^#?[0-9a-fA-F]{6}$/.test(v)) {
                      const hex = v.startsWith("#") ? v : `#${v}`;
                      setWorkingHsl(hexToHslValue(hex));
                    }
                  }}
                  className="flex-1 min-w-0 text-[10px] font-mono px-2 py-1 rounded border bg-black/[0.03] border-black/[0.06] text-black/70 outline-none focus:border-black/20"
                />
              </div>
            </div>}
          </div>}

          <div className="w-[calc(100%+3rem)] -mx-6 px-6 mt-4 pt-4 border-t border-black/[0.06]">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-wider text-black/40">
                Shadow
              </span>
              <button
                onClick={() => setShadowSettingsOpen((v) => !v)}
                aria-expanded={shadowSettingsOpen}
                aria-label={shadowSettingsOpen ? "Hide shadow settings" : "Show shadow settings"}
                className="text-black/40 hover:text-black/70 transition-colors p-0.5"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 10 10"
                  fill="none"
                  className={`transition-transform ${shadowSettingsOpen ? "rotate-180" : ""}`}
                >
                  <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>
            <div className="flex flex-wrap gap-1 mb-3">
              {shadowPresets.map((p) => {
                const active = shadowsEqual(previewShadow, p.value);
                const activeCls = "bg-black/80 text-white";
                const idleCls = "bg-black/[0.04] text-black/60 hover:bg-black/[0.08]";
                const cls = active ? activeCls : idleCls;
                const holding = holdingPreset === p.name;
                return (
                  <button
                    key={p.name}
                    onClick={() => {
                      if (suppressClickRef.current === p.name) {
                        suppressClickRef.current = null;
                        return;
                      }
                      setPreviewShadow(p.value);
                    }}
                    onPointerDown={(e) => {
                      if (e.button !== 0) return;
                      startPresetHold(p.name);
                    }}
                    onPointerUp={clearHoldTimer}
                    onPointerLeave={clearHoldTimer}
                    onPointerCancel={clearHoldTimer}
                    title={`Click to apply. Hold 1s to save current shadow as "${p.name}".`}
                    className={`text-xs px-2.5 py-1 rounded-full transition-all select-none whitespace-nowrap ${cls} ${holding ? "scale-95 ring-2 ring-offset-0 ring-black/40" : ""}`}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
            {shadowSettingsOpen && <div className="space-y-2">
              <ShadowRow label="distance" value={previewShadow.distance} min={0} max={400} step={1} onChange={(v) => updateShadow("distance", v)} />
              <ShadowRow label="angle" value={previewShadow.angle} min={0} max={360} step={1} onChange={(v) => updateShadow("angle", v)} suffix="°" />
              <ShadowRow label="blur" value={previewShadow.blur} min={0} max={200} step={1} onChange={(v) => updateShadow("blur", v)} />
              <ShadowRow label="opacity" value={previewShadow.opacity} min={0} max={2} step={0.01} onChange={(v) => updateShadow("opacity", v)} decimals={2} />
              <ShadowRow label="layers" value={previewShadow.layers} min={1} max={4} step={1} onChange={(v) => updateShadow("layers", v)} />
              <div className="flex items-center gap-2">
                <span className="text-[10px] w-14 shrink-0 text-black/50">color</span>
                <input
                  type="color"
                  value={previewShadow.color}
                  onChange={(e) => updateShadow("color", e.target.value)}
                  className="w-6 h-6 rounded cursor-pointer border border-black/[0.08] bg-transparent"
                />
                <input
                  type="text"
                  value={previewShadow.color}
                  onChange={(e) => {
                    const v = e.target.value;
                    if (/^#[0-9a-fA-F]{6}$/.test(v)) updateShadow("color", v);
                    else updateShadow("color", v); // let user type; builder tolerates partials
                  }}
                  className="flex-1 min-w-0 text-[10px] font-mono px-2 py-1 rounded border bg-black/[0.03] border-black/[0.06] text-black/70 outline-none focus:border-black/20"
                />
                <button
                  onClick={() => setPreviewShadow(DEFAULT_PREVIEW_SHADOW)}
                  className="text-[10px] px-2 py-1 rounded bg-black/5 text-black/50 hover:bg-black/10 transition-colors"
                  title="Reset shadow to defaults"
                >
                  Reset
                </button>
              </div>
            </div>}
          </div>
        </div>

        {/* Hidden offscreen canvas — kept mounted to preserve its WebGL context
            across captures. Remounting was causing the browser to drop the
            context, which left the env map (and other async assets) unbound. */}
        <div
          ref={canvasRef}
          style={{
            position: "absolute",
            left: -9999,
            top: -9999,
            width: 800,
            height: 800,
            pointerEvents: "none",
          }}
        >
          <Canvas
            orthographic={cameraSettings.orthographic}
            camera={{
              position: [0, 0, 8],
              fov: cameraSettings.fov,
              ...(cameraSettings.orthographic ? { zoom: 50 } : {}),
            }}
            gl={{
              antialias: true,
              alpha: true,
              preserveDrawingBuffer: true,
              powerPreference: "default",
            }}
            onCreated={({ gl }) => {
              gl.toneMapping = THREE.ACESFilmicToneMapping;
              gl.toneMappingExposure = 1.2;
              gl.setClearColor(0x000000, 0);
            }}
            frameloop="always"
          >
            <ambientLight intensity={0.4} />
            {lighting.keyLightOn && (
              <directionalLight
                position={[lighting.keyLightX, lighting.keyLightY, lighting.keyLightZ]}
                intensity={lighting.keyLightIntensity}
                color={lighting.keyLightColor}
              />
            )}
            {lighting.fillLightOn && (
              <directionalLight
                position={[lighting.fillLightX, lighting.fillLightY, lighting.fillLightZ]}
                intensity={lighting.fillLightIntensity}
                color={lighting.fillLightColor}
              />
            )}
            {lighting.rimLightOn && (
              <directionalLight
                position={[lighting.rimLightX, lighting.rimLightY, lighting.rimLightZ]}
                intensity={lighting.rimLightIntensity}
                color={lighting.rimLightColor}
              />
            )}

            {env.enabled && env.preset !== "sky" && (
              <PreviewEnvironment
                file={HDRI_FILES[env.preset] ?? HDRI_FILES.studio}
                rotation={env.rotation}
              />
            )}

            <ExtrudedSVG
              svgString={svgString}
              extrudeDepth={ext.depth}
              bevelEnabled={ext.bevelEnabled}
              bevelThickness={ext.bevelThickness}
              bevelSize={ext.bevelSize}
              bevelSegments={ext.bevelSegments}
              bevelOffset={ext.bevelOffset}
              curveSegments={ext.curveSegments}
              pathResolution={ext.pathResolution}
              cornerRadiusOn={extrusion.cornerRadiusOn}
              cornerRadius={ext.cornerRadius}
              outerCornerRadius={ext.outerCornerRadius}
              innerCornerRadius={ext.innerCornerRadius}
              solidify={ext.solidify}
              solidBack={ext.solidBack}
              inflation={ext.inflation}
              extrudeSteps={ext.extrudeSteps}
              smoothShading={ext.smoothShading}
              creaseAngle={ext.creaseAngle}
              color={mat.color}
              roughness={mat.roughness}
              metalness={mat.metalness}
              clearcoat={mat.clearcoat}
              clearcoatRoughness={mat.clearcoatRoughness}
              envMapIntensity={mat.envMapIntensity}
              transmission={mat.transmission}
              thickness={mat.thickness}
              ior={mat.ior}
              dispersion={mat.dispersion}
              normalMapOn={mat.normalMapOn}
              normalMapType={mat.normalMapType}
              normalScale={mat.normalScale}
              displacementScale={mat.displacementScale}
              displacementBias={mat.displacementBias}
              uvMap={uvMap as any}
              enamelOn={mat.enamelOn}
              enamelColor={mat.enamelColor}
              enamelOffset={mat.enamelOffset}
              enamelDome={mat.enamelDome}
              enamelZ={mat.enamelZ}
              enamelRoughness={mat.enamelRoughness}
              enamelMetalness={mat.enamelMetalness}
              enamelClearcoat={mat.enamelClearcoat}
              enamelClearcoatRoughness={mat.enamelClearcoatRoughness}
              enamelEnvMapIntensity={mat.enamelEnvMapIntensity}
              rotation={rot}
              envMapRotation={env.rotation}
              scale={scl}
            />

            {(mat.bloomOn || mat.aoOn) && (
              <EffectComposer enableNormalPass={mat.aoOn}>
                {mat.aoOn ? (
                  <N8AO
                    aoRadius={mat.aoRadius}
                    intensity={mat.aoIntensity}
                    distanceFalloff={mat.aoFalloff}
                    color={mat.aoColor}
                    quality="high"
                  />
                ) : <></>}
                {mat.bloomOn ? (
                  <Bloom
                    intensity={mat.bloomIntensity}
                    luminanceThreshold={mat.bloomThreshold}
                    luminanceSmoothing={0.025}
                    mipmapBlur
                    radius={mat.bloomRadius}
                  />
                ) : <></>}
              </EffectComposer>
            )}

            <Capturer onCapture={handleCapture} composerOn={mat.bloomOn || mat.aoOn} envEnabled={env.enabled && env.preset !== "sky"} nonce={captureNonce} />
            <HighResCapturer captureRef={highResCaptureRef} />
          </Canvas>
        </div>
      </div>
    </div>
  );
}
