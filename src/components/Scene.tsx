"use client";

import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls, Environment, Sky } from "@react-three/drei";
import { EffectComposer, Bloom, N8AO } from "@react-three/postprocessing";
import { Leva } from "leva";
import { usePersistedControls } from "@/hooks/usePersistedControls";
import { useSceneControls, type SceneControls } from "@/hooks/useSceneControls";
import { initHistory, undo, redo, applyPreset, subscribeToSnapshotChange } from "@/hooks/useHistory";
import { loadCustomPresets, BUILT_IN_PRESETS, type Preset } from "@/data/presets";
import customPresetsJson from "@/data/custom-presets.json";
import ExtrudedSVG from "./ExtrudedSVG";
import { HDRI_FILES } from "@/data/hdri";
import Preview from "./Preview";
import PresetPicker from "./PresetPicker";
import { useState, useCallback, useEffect, useMemo, useRef, Suspense } from "react";
import * as THREE from "three";
import { USDZExporter } from "three/examples/jsm/exporters/USDZExporter.js";

const DEFAULT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <circle cx="50" cy="50" r="45" fill="black"/>
</svg>`;

const SVG_STORAGE_KEY = "enamel-pin-svg";
const SELECTED_ICON_KEY = "enamel-pin-selected-logo";
const SELECTED_PRESET_KEY = "enamel-pin-selected-preset";
const SETTINGS_STORAGE_KEY = "enamel-pin-settings";
const CAMERA_DISTANCE = 8;

const LOGO_OPTIONS = [
  { name: "MLB", url: "/logos/baseball-league.svg" },
  { name: "Yankees", url: "/logos/yankees.svg" },
  { name: "Phillies", url: "/logos/phillies.svg" },
  { name: "Cubs", url: "/logos/cubs.svg" },
] as const;
type LogoUrl = (typeof LOGO_OPTIONS)[number]["url"];

const DEFAULT_LOGO_URL: LogoUrl = LOGO_OPTIONS[0].url;
const DEFAULT_PRESET_NAME = "Enamel Pin";

function isLogoUrl(value: string | null): value is LogoUrl {
  return LOGO_OPTIONS.some((option) => option.url === value);
}

// Seed the Enamel Pin preset and a valid catalog logo before hook initializers
// and Leva controls read from localStorage during the first render.
let pinDefaultsApplied = false;
function ensurePinDefaults() {
  if (pinDefaultsApplied || typeof window === "undefined") return;
  pinDefaultsApplied = true;
  try {
    const customPresets = customPresetsJson as Preset[];
    const preset =
      customPresets.find((p) => p.name === DEFAULT_PRESET_NAME) ??
      BUILT_IN_PRESETS.find((p) => p.name === DEFAULT_PRESET_NAME);
    if (preset) {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      const current = (raw ? JSON.parse(raw) : {}) as Record<string, Record<string, unknown>>;
      const merged: Record<string, Record<string, unknown>> = { ...current };
      for (const [folder, values] of Object.entries(preset.settings)) {
        merged[folder] = { ...(current[folder] ?? {}), ...values };
      }
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
    }
    const selectedLogo = localStorage.getItem(SELECTED_ICON_KEY);
    if (!isLogoUrl(selectedLogo)) {
      localStorage.removeItem(SVG_STORAGE_KEY);
      localStorage.setItem(SELECTED_ICON_KEY, DEFAULT_LOGO_URL);
    }
    const requestedExportLogo = new URLSearchParams(window.location.search).get("usdz-logo");
    if (requestedExportLogo === "yankees" || requestedExportLogo === "phillies") {
      localStorage.removeItem(SVG_STORAGE_KEY);
      localStorage.setItem(SELECTED_ICON_KEY, `/logos/${requestedExportLogo}.svg`);
    }
    localStorage.setItem(SELECTED_PRESET_KEY, DEFAULT_PRESET_NAME);
  } catch {}
}

function valueMatches(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return a === b;
}

function currentMatchesPreset(preset: Preset): boolean {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw) as Record<string, Record<string, unknown>>;
    for (const [folder, values] of Object.entries(preset.settings)) {
      const current = snap[folder];
      if (!current) return false;
      for (const [key, val] of Object.entries(values)) {
        if (!valueMatches(current[key], val)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

const LEVA_THEME = {
  colors: {
    elevation1: "transparent",
    elevation2: "transparent",
    elevation3: "rgba(0, 0, 0, 0.03)",
    accent1: "rgba(0, 0, 0, 0.15)",
    accent2: "rgba(0, 0, 0, 0.4)",
    accent3: "rgba(0, 0, 0, 0.65)",
    highlight1: "rgba(0, 0, 0, 0.3)",
    highlight2: "rgba(0, 0, 0, 0.6)",
    highlight3: "rgba(0, 0, 0, 0.88)",
    vivid1: "#0a0a0a",
    folderWidgetColor: "rgba(0, 0, 0, 0.4)",
    folderTextColor: "rgba(0, 0, 0, 0.78)",
    toolTipBackground: "#111",
    toolTipText: "rgba(255, 255, 255, 0.92)",
  },
  radii: { xs: "4px", sm: "6px", lg: "10px" },
  space: { xs: "4px", sm: "8px", md: "12px", rowGap: "6px", colGap: "8px" },
  fonts: {
    mono: "var(--font-gt-america), ui-monospace, SFMono-Regular, Menlo, monospace",
    sans: "var(--font-gt-america), -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  },
  fontSizes: { root: "11px", toolTip: "10px" },
  sizes: {
    rootWidth: "100%",
    controlWidth: "180px",
    numberInputMinWidth: "58px",
    scrubberWidth: "6px",
    scrubberHeight: "8px",
    rowHeight: "22px",
    folderTitleHeight: "26px",
    checkboxSize: "14px",
    joystickWidth: "100px",
    joystickHeight: "100px",
    colorPickerWidth: "180px",
    colorPickerHeight: "100px",
    imagePreviewWidth: "100px",
    imagePreviewHeight: "100px",
    monitorHeight: "60px",
    titleBarHeight: "0px",
  },
  shadows: { level1: "none", level2: "none" },
  borderWidths: {
    root: "0px",
    input: "1px",
    focus: "1px",
    hover: "1px",
    active: "1px",
    folder: "0px",
  },
  fontWeights: { label: "400", folder: "500", button: "500" },
};

function loadSvg(): string {
  if (typeof window === "undefined") return DEFAULT_SVG;
  try {
    return localStorage.getItem(SVG_STORAGE_KEY) || DEFAULT_SVG;
  } catch {
    return DEFAULT_SVG;
  }
}

function CameraManager({
  fov,
  ortho,
  controlsRef,
}: {
  fov: number;
  ortho: boolean;
  controlsRef: React.MutableRefObject<any>;
}) {
  const { camera, set, size } = useThree();
  const perspCam = useRef<THREE.PerspectiveCamera | null>(null);
  const orthoCam = useRef<THREE.OrthographicCamera | null>(null);

  // Create both cameras once
  useEffect(() => {
    const aspect = size.width / size.height;
    perspCam.current = new THREE.PerspectiveCamera(fov, aspect, 0.1, 1000);
    perspCam.current.position.set(0, 0, CAMERA_DISTANCE);

    const frustum = CAMERA_DISTANCE * Math.tan((fov * Math.PI) / 360);
    orthoCam.current = new THREE.OrthographicCamera(
      -frustum * aspect,
      frustum * aspect,
      frustum,
      -frustum,
      0.1,
      1000
    );
    orthoCam.current.position.set(0, 0, CAMERA_DISTANCE);
  }, []);

  // Switch active camera
  useEffect(() => {
    const cam = ortho ? orthoCam.current : perspCam.current;
    if (!cam) return;

    // Copy current camera position/rotation to new camera
    cam.position.copy(camera.position);
    cam.quaternion.copy(camera.quaternion);

    if (cam instanceof THREE.OrthographicCamera) {
      const aspect = size.width / size.height;
      const dist = camera.position.length();
      const frustum = dist * Math.tan((fov * Math.PI) / 360);
      cam.left = -frustum * aspect;
      cam.right = frustum * aspect;
      cam.top = frustum;
      cam.bottom = -frustum;
      cam.updateProjectionMatrix();
    }

    set({ camera: cam });

    // Update orbit controls target
    if (controlsRef.current) {
      controlsRef.current.object = cam;
      controlsRef.current.update();
    }
  }, [ortho]);

  // Update FOV for perspective camera
  useEffect(() => {
    if (perspCam.current) {
      perspCam.current.fov = fov;
      perspCam.current.updateProjectionMatrix();
    }
    if (!ortho && perspCam.current) {
      set({ camera: perspCam.current });
    }
  }, [fov]);

  // Handle resize
  useEffect(() => {
    const aspect = size.width / size.height;
    if (perspCam.current) {
      perspCam.current.aspect = aspect;
      perspCam.current.updateProjectionMatrix();
    }
    if (orthoCam.current) {
      const frustum = CAMERA_DISTANCE * Math.tan((fov * Math.PI) / 360);
      orthoCam.current.left = -frustum * aspect;
      orthoCam.current.right = frustum * aspect;
      orthoCam.current.top = frustum;
      orthoCam.current.bottom = -frustum;
      orthoCam.current.updateProjectionMatrix();
    }
  }, [size, fov]);

  return null;
}

function SceneBackground({ color, enabled }: { color: string; enabled: boolean }) {
  const { scene } = useThree();
  useEffect(() => {
    if (!enabled) return;
    scene.background = new THREE.Color(color);
  }, [scene, color, enabled]);
  return null;
}

const RETURN_DURATION = 0.4;

function CameraReturnToFront({
  shouldReturn,
  requestNonce,
  onDone,
  controlsRef,
}: {
  shouldReturn: boolean;
  requestNonce: number;
  onDone: () => void;
  controlsRef: React.MutableRefObject<any>;
}) {
  const targetPos = useMemo(() => new THREE.Vector3(0, 0, CAMERA_DISTANCE), []);
  const targetLook = useMemo(() => new THREE.Vector3(0, 0, 0), []);
  const targetUp = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const startRef = useRef<{ pos: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  const elapsedRef = useRef(0);

  useEffect(() => {
    if (!shouldReturn) {
      startRef.current = null;
      return;
    }
    const controls = controlsRef.current;
    if (!controls) return;
    const cam = controls.object;
    startRef.current = {
      pos: cam.position.clone(),
      target: controls.target.clone(),
      up: cam.up.clone(),
    };
    elapsedRef.current = 0;
  }, [shouldReturn, requestNonce, controlsRef]);

  useFrame((_, delta) => {
    if (!shouldReturn || !startRef.current) return;
    const controls = controlsRef.current;
    if (!controls) return;
    const cam = controls.object;

    elapsedRef.current += delta;
    const p = Math.min(1, elapsedRef.current / RETURN_DURATION);
    const eased = 1 - Math.pow(1 - p, 3);

    cam.position.copy(startRef.current.pos).lerp(targetPos, eased);
    controls.target.copy(startRef.current.target).lerp(targetLook, eased);
    cam.up.copy(startRef.current.up).lerp(targetUp, eased).normalize();
    controls.update();

    if (p >= 1) {
      cam.position.copy(targetPos);
      controls.target.copy(targetLook);
      cam.up.copy(targetUp);
      controls.update();
      onDone();
    }
  });

  return null;
}

function UserInteractionWatcher({
  controlsRef,
  onInteract,
}: {
  controlsRef: React.MutableRefObject<any>;
  onInteract: () => void;
}) {
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    const handler = () => onInteract();
    controls.addEventListener("start", handler);
    return () => controls.removeEventListener("start", handler);
  }, [controlsRef, onInteract]);
  return null;
}

declare global {
  interface Window {
    __exportYankeesEnamelPinUSDZ?: (uploadURL?: string) => Promise<string>;
    __enamelPinUSDZExportListener?: EventListener;
  }
}

const USDZ_EXPORT_EVENT = "enamel-pin:export-usdz";
const USDZ_UPLOAD_URL_DATASET_KEY = "enamelPinUsdzUploadUrl";
const USDZ_STATUS_DATASET_KEY = "enamelPinUsdzStatus";
const USDZ_ERROR_DATASET_KEY = "enamelPinUsdzError";

/**
 * Headless export hook used by scripts/export-yankees-usdz.mjs. It clones
 * only the authored pin group, so cameras, lights, the environment, shadows,
 * and post-processing never enter the USDZ scene.
 */
function installYankeesPinUSDZExporter(scene: THREE.Scene) {
    console.info("[USDZ export] bridge installed from Canvas.onCreated");
    const repairReflectedWinding = (source: THREE.BufferGeometry) => {
      const geometry = source.clone();
      const index = geometry.getIndex();
      if (index) {
        for (let offset = 0; offset < index.count; offset += 3) {
          const b = index.getX(offset + 1);
          index.setX(offset + 1, index.getX(offset + 2));
          index.setX(offset + 2, b);
        }
        index.needsUpdate = true;
        return geometry;
      }

      for (const attribute of Object.values(geometry.attributes)) {
        if (!(attribute instanceof THREE.BufferAttribute)) continue;
        const array = attribute.array;
        for (let vertex = 0; vertex < attribute.count; vertex += 3) {
          for (let component = 0; component < attribute.itemSize; component += 1) {
            const bIndex = (vertex + 1) * attribute.itemSize + component;
            const cIndex = (vertex + 2) * attribute.itemSize + component;
            const value = array[bIndex];
            array[bIndex] = array[cIndex];
            array[cIndex] = value;
          }
        }
        attribute.needsUpdate = true;
      }
      return geometry;
    };

    const bakeNormalStrength = (texture: THREE.Texture, strength: number) => {
      const source = texture.image as CanvasImageSource & { width?: number; height?: number };
      const width = source?.width ?? 0;
      const height = source?.height ?? 0;
      if (!width || !height) return texture;

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return texture;
      context.drawImage(source, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height);
      for (let index = 0; index < pixels.data.length; index += 4) {
        pixels.data[index] = 128 + (pixels.data[index] - 128) * strength;
        pixels.data[index + 1] = 128 + (pixels.data[index + 1] - 128) * strength;
      }
      context.putImageData(pixels, 0, 0);

      const baked = texture.clone();
      baked.image = canvas;
      // Auto-export can run before ExtrudedSVG's texture useEffect commits.
      // Apply the active Enamel Pin UV preset explicitly, then fold Three's
      // center into translation because USDZ's Transform2d has no center.
      const rotation = (-60 * Math.PI) / 180;
      const repeatX = 4;
      const repeatY = 4;
      const centerX = 0.23;
      const centerY = 0.5;
      const cosine = Math.cos(rotation);
      const sine = Math.sin(rotation);
      baked.repeat.set(repeatX, repeatY);
      baked.rotation = rotation;
      baked.offset.set(
        centerX - repeatX * (cosine * centerX + sine * centerY),
        centerY - repeatY * (-sine * centerX + cosine * centerY),
      );
      baked.center.set(0, 0);
      baked.wrapS = THREE.RepeatWrapping;
      baked.wrapT = THREE.RepeatWrapping;
      baked.needsUpdate = true;
      baked.name = "MetalRoughNormal_Strength_0_1";
      return baked;
    };

    window.__exportYankeesEnamelPinUSDZ = async (uploadURL?: string) => {
      console.info("[USDZ export] preparing pin-only scene");
      const deadline = window.performance.now() + 60_000;
      const requestedLogo = new URLSearchParams(window.location.search).get("usdz-logo");
      let source = scene.getObjectByName("YankeesEnamelPin");
      while (!source || (requestedLogo && source.userData.exportLogo !== requestedLogo)) {
        if (window.performance.now() > deadline) {
          throw new Error(`Requested ${requestedLogo ?? "pin"} scene group is not ready`);
        }
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
        source = scene.getObjectByName("YankeesEnamelPin");
      }

      source.updateWorldMatrix(true, true);
      const pin = source.clone(true);
      const exportName = requestedLogo === "phillies" ? "PhilliesEnamelPin" : "YankeesEnamelPin";
      pin.name = exportName;
      pin.rotation.set(0, 0, 0);
      const flipRoot = pin.getObjectByName("PinFlipRoot");
      flipRoot?.rotation.set(0, 0, 0);

      pin.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.geometry = repairReflectedWinding(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        const cloned = materials.map((sourceMaterial) => {
          const material = sourceMaterial.clone();
          const isMetal = object.name === "MetalBacking";
          material.name = isMetal ? "metal_backing" : `enamel_${object.name.replace(/\W+/g, "_").toLowerCase()}`;
          if (material instanceof THREE.MeshStandardMaterial) {
            material.emissive.multiplyScalar(material.emissiveIntensity);
            material.emissiveIntensity = 1;
            material.side = THREE.FrontSide;
            if (isMetal && material.normalMap) {
              material.normalMap = bakeNormalStrength(material.normalMap, 0.1);
            }
          }
          return material;
        });
        object.material = Array.isArray(object.material) ? cloned : cloned[0];
      });

      // USDZExporter serializes children of the object passed to it. Keeping
      // the pin as a child also preserves the preset's positive 0.04 scale.
      const exportScene = new THREE.Scene();
      exportScene.name = `${exportName}Export`;
      exportScene.add(pin);
      exportScene.updateMatrixWorld(true);

      const exporter = new USDZExporter();
      console.info("[USDZ export] USDZExporter.parseAsync started");
      const arrayBuffer = await exporter.parseAsync(exportScene, {
        includeAnchoringProperties: false,
        quickLookCompatible: true,
        maxTextureSize: 1024,
      });
      console.info(`[USDZ export] USDZExporter.parseAsync finished (${arrayBuffer.byteLength} bytes)`);
      if (uploadURL) {
        const response = await fetch(uploadURL, { method: "POST", body: arrayBuffer });
        if (!response.ok) throw new Error(`USDZ upload failed: HTTP ${response.status}`);
        return "uploaded";
      }
      const bytes = new Uint8Array(arrayBuffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
      }
      return btoa(binary);
    };

    if (window.__enamelPinUSDZExportListener) {
      document.removeEventListener(USDZ_EXPORT_EVENT, window.__enamelPinUSDZExportListener);
    }
    const handleExportEvent: EventListener = () => {
      const root = document.documentElement;
      const uploadURL = root.dataset[USDZ_UPLOAD_URL_DATASET_KEY];
      root.dataset[USDZ_STATUS_DATASET_KEY] = "exporting";
      delete root.dataset[USDZ_ERROR_DATASET_KEY];

      void window.__exportYankeesEnamelPinUSDZ?.(uploadURL)
        .then((result) => {
          root.dataset[USDZ_STATUS_DATASET_KEY] = result === "uploaded" ? "success" : "complete";
        })
        .catch((error: unknown) => {
          root.dataset[USDZ_STATUS_DATASET_KEY] = "error";
          root.dataset[USDZ_ERROR_DATASET_KEY] = error instanceof Error ? error.message : String(error);
        });
    };
    window.__enamelPinUSDZExportListener = handleExportEvent;
    document.addEventListener(USDZ_EXPORT_EVENT, handleExportEvent);
    const currentStatus = document.documentElement.dataset[USDZ_STATUS_DATASET_KEY];
    if (!currentStatus || !["scheduled", "exporting", "success"].includes(currentStatus)) {
      document.documentElement.dataset[USDZ_STATUS_DATASET_KEY] = "ready";
    }

}

function SceneContent({
  svgString,
  controlsRef,
  bgColor,
  wireframe,
  animate,
  shouldReturn,
  returnNonce,
  onReturnDone,
  onUserInteract,
  colorOverride,
  onMaterialColorChange,
  flipNonce,
  controls,
}: {
  svgString: string;
  controlsRef: React.MutableRefObject<any>;
  bgColor: string;
  wireframe: boolean;
  animate: boolean;
  shouldReturn: boolean;
  returnNonce: number;
  onReturnDone: () => void;
  onUserInteract: () => void;
  colorOverride: string | null;
  onMaterialColorChange: () => void;
  flipNonce: number;
  controls: SceneControls;
}) {
  const { extrusion, material, uvMap, postfx, enamel, transform, lighting, env, cameraSettings, fur } = controls;
  const isUSDZExport = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).has("export-usdz");

  // Clear the color override when the underlying Material.color changes (preset
  // apply or direct color-picker edit) so the newly-chosen color shows through.
  const prevMaterialColorRef = useRef(material.color);
  useEffect(() => {
    if (prevMaterialColorRef.current !== material.color) {
      prevMaterialColorRef.current = material.color;
      onMaterialColorChange();
    }
  }, [material.color, onMaterialColorChange]);

  // Resolve values — when a toggle is off, use neutral default
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

  return (
    <>
      <SceneBackground color={bgColor} enabled={!(env.enabled && env.hdr)} />
      <CameraManager
        fov={cameraSettings.fov}
        ortho={cameraSettings.orthographic}
        controlsRef={controlsRef}
      />

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

      {env.enabled && env.preset === "sky" && (
        <Sky sunPosition={[100, 20, 100]} turbidity={8} rayleigh={2} />
      )}
      {env.enabled && env.preset !== "sky" && (
        <Suspense fallback={null}>
          <Environment
            files={HDRI_FILES[env.preset] ?? HDRI_FILES.studio}
            background={env.hdr}
            backgroundIntensity={env.hdrBrightness}
            backgroundRotation={[0, (env.rotation * Math.PI) / 180, 0]}
            environmentRotation={[0, (env.rotation * Math.PI) / 180, 0]}
          />
        </Suspense>
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
        wireframe={wireframe}
        flipNonce={flipNonce}
        fur={fur as any}
      />

      {!isUSDZExport && <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.05}
        minDistance={0.5}
        maxDistance={50}
        autoRotate={animate}
        autoRotateSpeed={2.0}
      />}
      {!isUSDZExport && <CameraReturnToFront
        shouldReturn={shouldReturn}
        requestNonce={returnNonce}
        onDone={onReturnDone}
        controlsRef={controlsRef}
      />}
      {!isUSDZExport && <UserInteractionWatcher controlsRef={controlsRef} onInteract={onUserInteract} />}

      {!isUSDZExport && (mat.bloomOn || mat.aoOn) && (
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
    </>
  );
}

export default function Scene() {
  ensurePinDefaults();
  const controls = useSceneControls();
  const usdzUploadURL = typeof window === "undefined"
    ? null
    : new URLSearchParams(window.location.search).get("usdz-upload");
  const controlsRef = useRef<any>(null);
  const [paused, setPaused] = useState(false);
  const [wireframe, setWireframe] = useState(false);
  const [animate, setAnimate] = useState(false);
  const [shouldReturn, setShouldReturn] = useState(false);
  const [returnNonce, setReturnNonce] = useState(0);
  const [flipNonce, setFlipNonce] = useState(0);
  const animateAfterReturn = useRef(false);

  const toggleAnimate = useCallback(() => {
    setAnimate((a) => {
      if (a) {
        animateAfterReturn.current = false;
        setReturnNonce((nonce) => nonce + 1);
        setShouldReturn(true);
        return false;
      } else {
        animateAfterReturn.current = true;
        setReturnNonce((nonce) => nonce + 1);
        setShouldReturn(true);
        return false;
      }
    });
  }, []);

  const handleReturnDone = useCallback(() => {
    setShouldReturn(false);
    if (animateAfterReturn.current) {
      animateAfterReturn.current = false;
      setAnimate(true);
    }
  }, []);
  const handleUserInteract = useCallback(() => {
    animateAfterReturn.current = false;
    setAnimate(false);
    setShouldReturn(false);
  }, []);
  const [svgString, setSvgString] = useState(loadSvg);
  const [selectedLogoUrl, setSelectedLogoUrl] = useState<LogoUrl | null>(() => {
    if (typeof window === "undefined") return DEFAULT_LOGO_URL;
    try {
      const stored = localStorage.getItem(SELECTED_ICON_KEY);
      return isLogoUrl(stored) ? stored : DEFAULT_LOGO_URL;
    } catch {
      return DEFAULT_LOGO_URL;
    }
  });
  const [canvasKey, setCanvasKey] = useState(0);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, []);

  // Initialize undo history on mount
  useEffect(() => {
    initHistory();
  }, []);

  // Cmd+Z / Cmd+Y keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.key === "y" || (e.key === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const [customPresets, setCustomPresets] = useState<Preset[]>([]);
  const [presetsLoaded, setPresetsLoaded] = useState(false);
  useEffect(() => {
    loadCustomPresets().then((p) => {
      setCustomPresets(p.filter((preset) => preset.name === DEFAULT_PRESET_NAME));
      setPresetsLoaded(true);
    });
  }, []);

  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try { return localStorage.getItem(SELECTED_PRESET_KEY); } catch { return null; }
  });

  useEffect(() => {
    try {
      if (selectedPresetName) localStorage.setItem(SELECTED_PRESET_KEY, selectedPresetName);
      else localStorage.removeItem(SELECTED_PRESET_KEY);
    } catch {}
  }, [selectedPresetName]);

  // Keep the preset label in sync with current settings: clear it when the
  // scene diverges, and recover it when settings match a known preset (e.g.
  // on fresh load, or after a transient clear during initial Leva mount).
  useEffect(() => {
    if (!presetsLoaded) return;
    const allPresets = customPresets;
    const reconcile = () => {
      setSelectedPresetName((current) => {
        if (current) {
          const preset = allPresets.find((p) => p.name === current);
          if (preset && currentMatchesPreset(preset)) return current;
        }
        const match = allPresets.find((p) => currentMatchesPreset(p));
        return match ? match.name : null;
      });
    };
    reconcile();
    return subscribeToSnapshotChange(reconcile);
  }, [customPresets, presetsLoaded]);

  const handleApplyPreset = useCallback((preset: Preset) => {
    applyPreset(preset.settings);
    setSelectedPresetName(preset.name);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(SVG_STORAGE_KEY, svgString);
    } catch {}
  }, [svgString]);

  const [{ bgColor }] = usePersistedControls("Background", {
    bgColor: "#141414",
  });

  const [colorOverride, setColorOverride] = useState<string | null>(null);
  const clearColorOverride = useCallback(() => setColorOverride(null), []);

  const btnClass = "px-2.5 py-1 bg-black/[0.04] hover:bg-black/[0.08] text-black/75 rounded-full text-xs whitespace-nowrap cursor-pointer transition-colors border-0";

  const resetToFront = useCallback(() => {
    animateAfterReturn.current = false;
    setAnimate(false);
    setReturnNonce((nonce) => nonce + 1);
    setShouldReturn(true);
  }, []);

  const [isCustomIcon, setIsCustomIcon] = useState(false);

  const handleSvgUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        if (text) {
          setSvgString(text);
          setSelectedLogoUrl(null);
          setIsCustomIcon(true);
          resetToFront();
          try { localStorage.removeItem(SELECTED_ICON_KEY); } catch {}
        }
      };
      reader.readAsText(file);
    },
    [resetToFront]
  );

  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadLogo = useCallback(async (url: LogoUrl) => {
    const res = await fetch(url);
    if (!res.ok) return;
    const text = await res.text();
    if (text.includes("<svg")) {
      setSvgString(text);
      setIsCustomIcon(false);
      resetToFront();
      try { localStorage.setItem(SELECTED_ICON_KEY, url); } catch {}
    }
  }, [resetToFront]);

  useEffect(() => {
    if (selectedLogoUrl) loadLogo(selectedLogoUrl);
  }, [loadLogo, selectedLogoUrl]);

  const handleLogoChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const url = e.target.value;
    if (isLogoUrl(url)) setSelectedLogoUrl(url);
  }, []);

  const handleUSDZExport = useCallback(() => {
    if (!usdzUploadURL) return;
    document.documentElement.dataset[USDZ_UPLOAD_URL_DATASET_KEY] = usdzUploadURL;
    document.dispatchEvent(new Event(USDZ_EXPORT_EVENT));
  }, [usdzUploadURL]);

  return (
    <div className="w-full h-full flex flex-col md:flex-row bg-[#fafafa] text-black overflow-y-auto md:overflow-hidden">
      {/* Left: Leva sidebar (collapsible) — desktop only */}
      <aside
        className={`hidden md:flex shrink-0 h-full border-r border-black/[0.06] bg-white flex-col transition-[width] duration-200 ease-out ${sidebarOpen ? "w-[330px]" : "w-0"} overflow-hidden`}
      >
        <div className="w-[330px] h-full overflow-y-auto flex flex-col">
          <div className="p-6 pb-2">
            <span className="text-sm font-medium text-black/60">Controls</span>
          </div>
          <Leva
            fill
            flat
            titleBar={false}
            hideCopyButton
            theme={LEVA_THEME}
          />
        </div>
      </aside>

      {/* Center: Canvas + top toolbar. On mobile this collapses to just the toolbar. */}
      <main
        className="shrink-0 md:flex-1 md:relative md:min-w-0 md:overflow-hidden md:h-full"
        style={{ background: bgColor }}
      >
        {/* Sidebar toggle — desktop only */}
        <button
          type="button"
          onClick={() => setSidebarOpen((v) => !v)}
          title={sidebarOpen ? "Hide panel" : "Show panel"}
          aria-label={sidebarOpen ? "Hide panel" : "Show panel"}
          className="hidden md:flex absolute top-4 left-4 z-20 w-8 h-8 items-center justify-center rounded-full bg-white border border-black/[0.06] text-black/60 hover:text-black/90 hover:bg-white cursor-pointer transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <line x1="6" y1="2.5" x2="6" y2="13.5" stroke="currentColor" strokeWidth="1.2" />
            {sidebarOpen ? (
              <path d="M10.5 6 L8.5 8 L10.5 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            ) : (
              <path d="M8.5 6 L10.5 8 L8.5 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
            )}
          </svg>
        </button>

        <div className="flex gap-1.5 p-6 bg-white border-b border-black/[0.06] overflow-x-auto overscroll-x-contain [&>*]:shrink-0 md:p-1.5 md:absolute md:top-4 md:left-1/2 md:-translate-x-1/2 md:z-10 md:w-auto md:max-w-[calc(100%-100px)] md:justify-center md:rounded-3xl md:border md:overflow-visible md:flex-wrap md:gap-y-1.5 md:gap-x-1">
          <div className="relative w-[112px]">
            <select
              aria-label="Logo"
              value={selectedLogoUrl ?? ""}
              onChange={handleLogoChange}
              className="h-full min-h-7 w-full appearance-none rounded-full border-0 bg-black/[0.04] py-1 pl-3 pr-8 text-xs text-black/75 outline-none transition-colors hover:bg-black/[0.08] focus-visible:ring-2 focus-visible:ring-black/20 cursor-pointer"
            >
              {selectedLogoUrl === null && (
                <option value="" disabled>Custom SVG</option>
              )}
              {LOGO_OPTIONS.map((option) => (
                <option key={option.url} value={option.url}>{option.name}</option>
              ))}
            </select>
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-black/45"
              width="10"
              height="6"
              viewBox="0 0 10 6"
              fill="none"
            >
              <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="w-[140px]">
            <PresetPicker
              presets={customPresets}
              selectedName={selectedPresetName}
              onApply={handleApplyPreset}
            />
          </div>
          <label className={`flex items-center gap-2 cursor-pointer ${btnClass}`}>
            Upload SVG
            <input
              type="file"
              accept=".svg"
              onChange={handleSvgUpload}
              className="hidden"
            />
          </label>
          <div className="hidden md:block w-px self-stretch bg-black/10 mx-0.5" aria-hidden="true" />
          <button onClick={resetToFront} className={`hidden md:inline-flex ${btnClass}`}>
            Front View
          </button>
          <button onClick={() => setFlipNonce((n) => n + 1)} className={`hidden md:inline-flex ${btnClass}`}>
            Flip
          </button>
          {usdzUploadURL && (
            <button type="button" onClick={handleUSDZExport} className={btnClass}>
              Export USDZ
            </button>
          )}
          <button onClick={() => setPaused(!paused)} className={`hidden md:inline-flex ${btnClass}`}>
            {paused ? "Resume" : "Pause"}
          </button>
          <button
            onClick={() => setWireframe(!wireframe)}
            className={`hidden md:inline-flex ${btnClass} ${wireframe ? "!bg-black/[0.12] !text-black" : ""}`}
            aria-pressed={wireframe}
          >
            {wireframe ? "Preview" : "Wireframe"}
          </button>
          <button
            onClick={toggleAnimate}
            className={`hidden md:inline-flex ${btnClass} ${animate ? "!bg-black/[0.12] !text-black" : ""}`}
            aria-pressed={animate}
          >
            Animate
          </button>
        </div>

        {!paused && !isMobile && <Canvas
          key={canvasKey}
          camera={{ position: [0, 0, CAMERA_DISTANCE], fov: 45 }}
          style={{
            background: "transparent",
          }}
          gl={{
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true,
            powerPreference: "default",
            failIfMajorPerformanceCaveat: false,
          }}
          onCreated={({ gl, scene }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 1.2;
            gl.setClearColor(0x000000, 0);
            installYankeesPinUSDZExporter(scene);
            const root = document.documentElement;
            const uploadURL = new URLSearchParams(window.location.search).get("usdz-upload");
            if (uploadURL) {
              root.dataset[USDZ_UPLOAD_URL_DATASET_KEY] = uploadURL;
            }
            const canvas = gl.domElement;
            canvas.addEventListener("webglcontextlost", (e) => {
              e.preventDefault();
              setTimeout(() => setCanvasKey((k) => k + 1), 100);
            });
          }}
        >
          <SceneContent
            svgString={svgString}
            controlsRef={controlsRef}
            bgColor={bgColor}
            wireframe={wireframe}
            animate={animate}
            shouldReturn={shouldReturn}
            returnNonce={returnNonce}
            onReturnDone={handleReturnDone}
            onUserInteract={handleUserInteract}
            colorOverride={colorOverride}
            onMaterialColorChange={clearColorOverride}
            flipNonce={flipNonce}
            controls={controls}
          />
        </Canvas>}
      </main>

      {/* Right: Preview sidebar — full width below toolbar on mobile */}
      <aside className="w-full md:w-[380px] md:shrink-0 md:h-full md:overflow-y-auto md:border-l border-black/[0.06] bg-white">
        <Preview
          svgString={svgString}
          iconName={isCustomIcon ? null : LOGO_OPTIONS.find((option) => option.url === selectedLogoUrl)?.name ?? null}
          presetName={selectedPresetName}
          colorOverride={colorOverride}
          onPickColor={setColorOverride}
          controls={controls}
        />
      </aside>
    </div>
  );
}
