"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment } from "@react-three/drei";
import { EffectComposer, Bloom, N8AO, DepthOfField } from "@react-three/postprocessing";
import type { DepthOfFieldEffect } from "postprocessing";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import ExtrudedSVG from "./ExtrudedSVG";
import customPresetsJson from "@/data/custom-presets.json";
import type { Preset } from "@/data/presets";
import { HDRI_FILES } from "@/data/hdri";

// Scripted promo reel for a single pin. The timeline is a pure function of
// time, so the same frame renders identically in the live preview and in the
// frame-by-frame capture driven by scripts/render-promo.mjs.

export const PROMO_FPS = 60;
export const PROMO_DURATION = 12;
const BG_COLOR = "#efefed";

type Vec3 = [number, number, number];
type Key = {
  t: number;
  pos: Vec3;
  look: Vec3;
  fov: number;
  // Depth of field: focus point, in-focus depth range, blur strength.
  focus: Vec3;
  range: number;
  bokeh: number;
};
// "ease" settles to a stop at that end of the shot; "move" carries velocity
// through it, so cuts land mid-motion instead of on a dead camera.
type ShotEnd = "ease" | "move";
type Shot = { start: number; end: number; ends: [ShotEnd, ShotEnd]; keys: Key[] };

// Pin is ~4 world units across, centered at the origin, face toward +Z.
// Letters "UBS" sit to the right of center, the C opens to the right.
const SHOTS: Shot[] = [
  // One continuous move: whip-in hero reveal → exploded layers → collapse →
  // spin → settle centered, small and square to camera.
  {
    start: 0,
    end: PROMO_DURATION,
    ends: ["move", "ease"],
    keys: [
      { t: 0, pos: [1.9, -2.4, 2.2], look: [0.3, 0.1, 0], fov: 34, focus: [0.3, 0, 0.2], range: 1.0, bokeh: 5 },
      { t: 1.4, pos: [-2.3, -0.8, 6.0], look: [0, 0, 0.2], fov: 36, focus: [0, 0, 0.3], range: 2.0, bokeh: 3 },
      { t: 2.8, pos: [-6.3, 2.2, 5.3], look: [0.2, 0, 1.3], fov: 36, focus: [0, 0, 1.0], range: 2.6, bokeh: 2.5 },
      { t: 4.6, pos: [-5.3, 3.2, 3.7], look: [0.3, 0, 1.4], fov: 36, focus: [0.4, 0.6, 0.1], range: 2.2, bokeh: 3 },
      { t: 5.6, pos: [-1.8, 1.2, 8.5], look: [0, 0, 0.1], fov: 36, focus: [0, 0, 0.1], range: 4, bokeh: 1 },
      { t: 7.4, pos: [0, 0, 17], look: [0, 0, 0], fov: 36, focus: [0, 0, 0], range: 10, bokeh: 0 },
      { t: PROMO_DURATION, pos: [0, 0, 17.5], look: [0, 0, 0], fov: 36, focus: [0, 0, 0], range: 10, bokeh: 0 },
    ],
  },
];

// Layer separation (world units along the pin normal) per enamel color, in
// SVG order: blue ring, then the red C and letters.
const EXPLODE_DISTANCE = [1.0, 2.0];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOutCubic = (v: number) => (v < 0.5 ? 4 * v * v * v : 1 - Math.pow(-2 * v + 2, 3) / 2);
const easeInOutQuart = (v: number) => (v < 0.5 ? 8 * v ** 4 : 1 - Math.pow(-2 * v + 2, 4) / 2);
const window01 = (t: number, a: number, b: number) => clamp01((t - a) / (b - a));

const easeOutBack = (v: number) => {
  const c1 = 1.3;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(v - 1, 3) + c1 * Math.pow(v - 1, 2);
};

function explodeAmount(t: number, layer: number) {
  const stagger = layer * 0.12;
  const open = easeOutBack(window01(t, 1.8 + stagger, 2.6 + stagger));
  const close = easeInOutQuart(window01(t, 4.55 + (1 - layer) * 0.08, 5.25));
  return open * (1 - close);
}

function pinSpinY(t: number) {
  // Drift during the reveal, then one quick full spin that lands square.
  const drift = 0.3 * Math.sin(clamp01(t / 2.6) * Math.PI) * (t < 2.6 ? 1 : 0);
  const spin = easeInOutQuart(window01(t, 5.2, 6.8)) * Math.PI * 2;
  return drift + spin;
}

// Environment rotation in degrees: a slow sweep through the hero section and
// a wider one on the end hold, so highlights travel across the chrome.
const ENV_BASE_ROTATION = 311;
function envRotationDeg(t: number) {
  return (
    ENV_BASE_ROTATION +
    40 * easeInOutCubic(window01(t, 0, 5.6)) +
    150 * easeInOutCubic(window01(t, 6.3, PROMO_DURATION))
  );
}

// Cubic Hermite through keys with time-aware (Catmull-Rom) tangents, so moves
// flow through interior keys without stalling.
function sampleShot(shot: Shot, t: number) {
  const keys = shot.keys;
  const time = Math.min(Math.max(t, keys[0].t), keys[keys.length - 1].t);
  let i = 0;
  while (i < keys.length - 2 && time > keys[i + 1].t) i++;
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const dt = k1.t - k0.t;
  const u = dt > 0 ? (time - k0.t) / dt : 0;
  const h00 = 2 * u ** 3 - 3 * u ** 2 + 1;
  const h10 = u ** 3 - 2 * u ** 2 + u;
  const h01 = -2 * u ** 3 + 3 * u ** 2;
  const h11 = u ** 3 - u ** 2;

  const tangent = (get: (k: Key) => number, idx: number) => {
    const last = keys.length - 1;
    if (idx === 0 || idx === last) {
      if (shot.ends[idx === 0 ? 0 : 1] === "ease") return 0;
      const [a, b] = idx === 0 ? [keys[0], keys[1]] : [keys[last - 1], keys[last]];
      return (get(b) - get(a)) / (b.t - a.t);
    }
    return (get(keys[idx + 1]) - get(keys[idx - 1])) / (keys[idx + 1].t - keys[idx - 1].t);
  };
  const interp = (get: (k: Key) => number) =>
    h00 * get(k0) + h10 * dt * tangent(get, i) + h01 * get(k1) + h11 * dt * tangent(get, i + 1);
  const vec = (field: "pos" | "look" | "focus"): Vec3 =>
    [0, 1, 2].map((axis) => interp((k) => k[field][axis])) as Vec3;

  return {
    pos: vec("pos"),
    look: vec("look"),
    focus: vec("focus"),
    fov: interp((k) => k.fov),
    range: Math.max(0.05, interp((k) => k.range)),
    bokeh: Math.max(0, interp((k) => k.bokeh)),
  };
}

function sampleCamera(t: number) {
  const shot = SHOTS.find((s) => t < s.end) ?? SHOTS[SHOTS.length - 1];
  return sampleShot(shot, t);
}

type PinSettings = Record<string, Record<string, unknown>>;

function usePinSettings(): PinSettings {
  return useMemo(() => {
    const preset = (customPresetsJson as Preset[]).find((p) => p.name === "Enamel Pin");
    return (preset?.settings ?? {}) as PinSettings;
  }, []);
}

function Timeline({
  timeRef,
  pinRef,
  dofRef,
}: {
  timeRef: React.MutableRefObject<number>;
  pinRef: React.RefObject<THREE.Group | null>;
  dofRef: React.RefObject<DepthOfFieldEffect | null>;
}) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;
  const focusTarget = useMemo(() => new THREE.Vector3(), []);
  const worldScale = useMemo(() => new THREE.Vector3(), []);

  // Runs before the composer (priority 1) so every frame sees this frame's pose.
  useFrame(() => {
    const t = timeRef.current;
    const cam = sampleCamera(t);
    camera.position.set(...cam.pos);
    camera.fov = cam.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(...cam.look);

    const pin = pinRef.current;
    if (pin) {
      pin.rotation.set(0, pinSpinY(t), 0);
      pin.updateMatrixWorld(true);
      // Each SVG path is its own Enamel_N mesh; group them by color so the
      // whole red layer (C plus letters) lifts together.
      const colors: string[] = [];
      pin.traverse((object) => {
        if (!object.name.startsWith("Enamel_") || !object.parent) return;
        const mesh = object as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
        const color = mesh.material.color.getHexString();
        if (!colors.includes(color)) colors.push(color);
        const layer = colors.indexOf(color);
        const distance = EXPLODE_DISTANCE[Math.min(layer, EXPLODE_DISTANCE.length - 1)];
        mesh.parent!.getWorldScale(worldScale);
        mesh.position.z = (distance * explodeAmount(t, layer)) / (worldScale.z || 1);
      });
    }

    const dof = dofRef.current;
    if (dof) {
      focusTarget.set(...cam.focus);
      dof.target = focusTarget;
      dof.cocMaterial.focusRange = cam.range;
      dof.bokehScale = cam.bokeh;
    }
  }, 0);

  // ExtrudedSVG writes its envMapRotation prop into the materials every frame;
  // run after it (still before the composer at 1) to drive the sweep.
  useFrame(() => {
    const radians = (envRotationDeg(timeRef.current) * Math.PI) / 180;
    pinRef.current?.traverse((object) => {
      const material = (object as THREE.Mesh).material as THREE.MeshPhysicalMaterial | undefined;
      material?.envMapRotation?.set(0, radians, 0);
    });
  }, 0.5);
  return null;
}

// Frame stepping for offline capture: renders exactly one frame at time t.
function CaptureBridge({
  timeRef,
  ready,
}: {
  timeRef: React.MutableRefObject<number>;
  ready: boolean;
}) {
  const advance = useThree((s) => s.advance);
  const gl = useThree((s) => s.gl);
  const accum = useMemo(() => document.createElement("canvas"), []);
  useEffect(() => {
    const w = window as unknown as { __promo?: unknown };
    w.__promo = {
      fps: PROMO_FPS,
      duration: PROMO_DURATION,
      ready,
      // Motion blur: average `samples` renders spread across the shutter
      // (fraction of a frame), clamped to the current shot so no frame
      // smears across a cut.
      renderAt: (t: number, samples = 1, shutter = 0.5, quality = 0.95) => {
        const shot = SHOTS.find((s) => t < s.end) ?? SHOTS[SHOTS.length - 1];
        const canvas = gl.domElement;
        if (accum.width !== canvas.width || accum.height !== canvas.height) {
          accum.width = canvas.width;
          accum.height = canvas.height;
        }
        const ctx = accum.getContext("2d")!;
        for (let i = 0; i < samples; i++) {
          const offset = samples > 1 ? ((i + 0.5) / samples - 0.5) * (shutter / PROMO_FPS) : 0;
          const time = Math.min(Math.max(t + offset, shot.start), shot.end - 1e-4);
          timeRef.current = time;
          advance(time * 1000);
          ctx.globalAlpha = 1 / (i + 1);
          ctx.drawImage(canvas, 0, 0);
        }
        return accum.toDataURL("image/jpeg", quality);
      },
    };
  }, [accum, advance, gl, ready, timeRef]);
  return null;
}

function LiveClock({ timeRef }: { timeRef: React.MutableRefObject<number> }) {
  const start = useRef<number | null>(null);
  useFrame(({ clock }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    timeRef.current = (clock.elapsedTime - start.current) % PROMO_DURATION;
  }, -1);
  return null;
}

function EnvReady({ onReady }: { onReady: () => void }) {
  useEffect(onReady, [onReady]);
  return null;
}

function PromoContent({
  svgString,
  capture,
  onReady,
}: {
  svgString: string;
  capture: boolean;
  onReady: () => void;
}) {
  const s = usePinSettings();
  const ex = s.Extrusion as Record<string, any>;
  const m = s.Material as Record<string, any>;
  const en = s["Enamel Fill"] as Record<string, any>;
  const fx = s["Post FX"] as Record<string, any>;
  const light = s.Lighting as Record<string, any>;
  const envSettings = s.Environment as Record<string, any>;
  const envRotation = ((envSettings.rotation as number) * Math.PI) / 180;

  const timeRef = useRef(0);
  const pinRef = useRef<THREE.Group>(null);
  const dofRef = useRef<DepthOfFieldEffect>(null);
  const [envReady, setEnvReady] = useState(false);

  useEffect(() => {
    if (envReady) onReady();
  }, [envReady, onReady]);

  const bevelOffset = ex.bevelInward ? -ex.bevelSize + ex.bevelOffset : ex.bevelOffset;

  return (
    <>
      <color attach="background" args={[BG_COLOR]} />
      {capture ? <CaptureBridge timeRef={timeRef} ready={envReady} /> : <LiveClock timeRef={timeRef} />}
      <Timeline timeRef={timeRef} pinRef={pinRef} dofRef={dofRef} />

      <ambientLight intensity={0.4} />
      <directionalLight position={[light.keyLightX, light.keyLightY, light.keyLightZ]} intensity={light.keyLightIntensity} />
      <directionalLight position={[light.fillLightX, light.fillLightY, light.fillLightZ]} intensity={light.fillLightIntensity} />
      <directionalLight position={[light.rimLightX, light.rimLightY, light.rimLightZ]} intensity={light.rimLightIntensity} />

      <Suspense fallback={null}>
        <Environment
          files={HDRI_FILES[envSettings.preset as string] ?? HDRI_FILES.studio}
          environmentRotation={[0, envRotation, 0]}
        />
        <EnvReady onReady={() => setEnvReady(true)} />
      </Suspense>

      <group ref={pinRef}>
        <ExtrudedSVG
          svgString={svgString}
          extrudeDepth={ex.depth}
          bevelEnabled={ex.bevelOn}
          bevelThickness={ex.bevelThickness}
          bevelSize={ex.bevelSize}
          bevelSegments={ex.bevelSegments}
          bevelOffset={bevelOffset}
          curveSegments={ex.curveSegments}
          pathResolution={ex.pathResolution}
          cornerRadiusOn={ex.cornerRadiusOn}
          cornerRadius={ex.cornerRadius}
          outerCornerRadius={ex.outerCornerRadius}
          innerCornerRadius={ex.innerCornerRadius}
          solidify={ex.solidify}
          solidBack={ex.solidBack}
          inflation={ex.inflationOn ? ex.inflation : 0}
          extrudeSteps={ex.extrudeSteps}
          smoothShading={ex.smoothShading}
          creaseAngle={ex.creaseAngle}
          color={m.color}
          roughness={m.roughness}
          metalness={m.metalness}
          clearcoat={m.clearcoat}
          clearcoatRoughness={m.clearcoatRoughness}
          envMapIntensity={m.envMapIntensity}
          transmission={0}
          thickness={0}
          ior={1.5}
          dispersion={0}
          normalMapOn={m.normalMapOn}
          normalMapType={m.normalMapType}
          normalScale={m.normalScale}
          displacementScale={m.displacementScale}
          displacementBias={m.displacementBias}
          uvMap={s["UV Map"] as any}
          enamelOn={en.enamelOn}
          enamelColor={en.enamelColor}
          enamelOffset={en.enamelOffset}
          enamelDome={en.enamelDome}
          enamelZ={en.enamelZ}
          enamelRoughness={en.enamelRoughness}
          enamelMetalness={en.enamelMetalness}
          enamelClearcoat={en.enamelClearcoat}
          enamelClearcoatRoughness={en.enamelClearcoatRoughness}
          enamelEnvMapIntensity={en.enamelEnvMapIntensity}
          rotation={[0, 0, 0]}
          envMapRotation={envSettings.rotation as number}
          scale={(s.Transform as Record<string, any>).scale}
        />
      </group>

      <EffectComposer enableNormalPass multisampling={8}>
        <N8AO
          aoRadius={fx.aoRadius}
          intensity={fx.aoIntensity}
          distanceFalloff={fx.aoFalloff}
          color={fx.aoColor}
          quality="high"
        />
        <Bloom
          intensity={m.bloomIntensity}
          luminanceThreshold={m.bloomThreshold}
          luminanceSmoothing={0.025}
          mipmapBlur
          radius={m.bloomRadius}
        />
        <DepthOfField ref={dofRef} focusDistance={3} focusRange={1} bokehScale={0} />
      </EffectComposer>
    </>
  );
}

export default function PromoScene({ logoUrl = "/logos/cubs.svg" }: { logoUrl?: string }) {
  const capture =
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("capture");
  const [svgString, setSvgString] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetch(logoUrl).then((r) => r.text()).then(setSvgString);
  }, [logoUrl]);

  useEffect(() => {
    if (ready) document.documentElement.dataset.promoReady = "true";
  }, [ready]);

  return (
    <div
      style={capture ? { width: 1920, height: 1080 } : { width: "100vw", height: "100vh" }}
      className="bg-[#efefed]"
    >
      {svgString && (
        <Canvas
          frameloop={capture ? "never" : "always"}
          dpr={capture ? 1 : [1, 2]}
          camera={{ position: [0, 0, 8], fov: 36, near: 0.05, far: 100 }}
          gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: "high-performance" }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.2;
          }}
        >
          <PromoContent svgString={svgString} capture={capture} onReady={() => setReady(true)} />
        </Canvas>
      )}
    </div>
  );
}
