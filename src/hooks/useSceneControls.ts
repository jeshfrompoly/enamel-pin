"use client";

import { usePersistedControls } from "./usePersistedControls";

/**
 * Single source of truth for all scene-level Leva controls (extrusion,
 * material, lighting, environment, etc.). Called once from Scene and the
 * returned values are threaded down to both the main Canvas and the Preview
 * Canvas so the two renders can't drift out of sync.
 *
 * Registering the same folder from two components with slightly different
 * schemas (as Preview did previously) causes Leva's store to desync —
 * e.g. Preview would stay on its mount-time snapshot of solidBack even after
 * the main canvas updated. Lifting the hooks here eliminates the dupe.
 */
export function useSceneControls() {
  const [extrusion] = usePersistedControls("Extrusion", {
    depthOn: true,
    depth: { value: 0.69, min: 0, max: 5, step: 0.01 },
    bevelOn: true,
    bevelThickness: { value: 0.3, min: 0, max: 5, step: 0.01 },
    bevelSize: { value: 0.22, min: 0, max: 5, step: 0.01 },
    bevelSegments: { value: 8, min: 1, max: 32, step: 1 },
    bevelOffset: { value: 0, min: -5, max: 5, step: 0.01 },
    bevelInward: true,
    curveSegments: { value: 32, min: 4, max: 64, step: 1 },
    pathResolution: { value: 12, min: 2, max: 24, step: 1 },
    cornerRadiusOn: true,
    cornerRadius: { value: 0.1, min: 0, max: 20, step: 0.1 },
    outerCornerRadius: { value: 0.1, min: 0, max: 20, step: 0.1 },
    innerCornerRadius: { value: 0.1, min: 0, max: 20, step: 0.1 },
    solidify: false,
    solidBack: true,
    inflationOn: false,
    inflation: { value: 0, min: 0, max: 0.5, step: 0.01 },
    extrudeSteps: { value: 64, min: 2, max: 64, step: 1 },
    smoothShading: true,
    creaseAngle: { value: 82, min: 0, max: 180, step: 1 },
  });

  const [material] = usePersistedControls("Material", {
    colorOn: true,
    color: "#1a1a1a",
    roughnessOn: true,
    roughness: { value: 0.65, min: 0, max: 1, step: 0.01 },
    metalnessOn: true,
    metalness: { value: 0.1, min: 0, max: 1, step: 0.01 },
    clearcoatOn: true,
    clearcoat: { value: 0.3, min: 0, max: 1, step: 0.01 },
    clearcoatRoughnessOn: true,
    clearcoatRoughness: { value: 0.4, min: 0, max: 1, step: 0.01 },
    envMapIntensityOn: true,
    envMapIntensity: { value: 0.8, min: 0, max: 5, step: 0.01 },
    transmissionOn: false,
    transmission: { value: 0, min: 0, max: 1, step: 0.01 },
    thicknessOn: false,
    thickness: { value: 1, min: 0, max: 10, step: 0.1 },
    iorOn: false,
    ior: { value: 1.5, min: 1, max: 2.5, step: 0.01 },
    dispersionOn: false,
    dispersion: { value: 0, min: 0, max: 5, step: 0.1 },
    normalMapOn: false,
    normalMapType: {
      value: "brushed-h",
      options: ["brushed-h", "brushed-v", "rough", "hammered", "nugget"],
    },
    normalScale: { value: 0.5, min: 0, max: 2, step: 0.001 },
    displacementScale: { value: 0.5, min: 0, max: 20, step: 0.05 },
    displacementBias: { value: -0.25, min: -10, max: 10, step: 0.05 },
    bloomOn: false,
    bloomIntensity: { value: 1, min: 0, max: 5, step: 0.05 },
    bloomThreshold: { value: 0.9, min: 0, max: 1, step: 0.01 },
    bloomRadius: { value: 0.8, min: 0, max: 1, step: 0.01 },
  });

  const [uvMap] = usePersistedControls("UV Map", {
    offsetX: { value: 0, min: -2, max: 2, step: 0.01 },
    offsetY: { value: 0, min: -2, max: 2, step: 0.01 },
    repeatX: { value: 4, min: 0.25, max: 20, step: 0.25 },
    repeatY: { value: 4, min: 0.25, max: 20, step: 0.25 },
    rotation: { value: 0, min: -360, max: 360, step: 1 },
    centerX: { value: 0.5, min: 0, max: 1, step: 0.01 },
    centerY: { value: 0.5, min: 0, max: 1, step: 0.01 },
    wrapS: { value: "repeat", options: ["repeat", "clamp", "mirrored"] },
    wrapT: { value: "repeat", options: ["repeat", "clamp", "mirrored"] },
  });

  const [postfx] = usePersistedControls("Post FX", {
    aoOn: false,
    aoIntensity: { value: 2, min: 0, max: 8, step: 0.05 },
    aoRadius: { value: 0.5, min: 0.05, max: 5, step: 0.01 },
    aoFalloff: { value: 1, min: 0, max: 5, step: 0.05 },
    aoColor: "#000000",
  });

  const [enamel] = usePersistedControls("Enamel Fill", {
    enamelOn: true,
    enamelColor: "#000000",
    enamelOffset: { value: -0.35, min: -20, max: 5, step: 0.05 },
    enamelDome: { value: 0.5, min: -2, max: 2, step: 0.01 },
    enamelZ: { value: 1.9, min: -20, max: 20, step: 0.05 },
    enamelRoughness: { value: 0.23, min: 0, max: 1, step: 0.01 },
    enamelMetalness: { value: 0.12, min: 0, max: 1, step: 0.01 },
    enamelClearcoat: { value: 0.38, min: 0, max: 1, step: 0.01 },
    enamelClearcoatRoughness: { value: 0.11, min: 0, max: 1, step: 0.01 },
    enamelEnvMapIntensity: { value: 0.14, min: 0, max: 5, step: 0.01 },
  });

  const [transform] = usePersistedControls("Transform", {
    rotationOn: true,
    rotationX: { value: 0, min: -180, max: 180, step: 0.5 },
    rotationY: { value: 0, min: -180, max: 180, step: 0.5 },
    rotationZ: { value: 0, min: -180, max: 180, step: 0.5 },
    scaleOn: true,
    scale: { value: 0.04, min: 0.001, max: 0.2, step: 0.001 },
  });

  const [lighting] = usePersistedControls("Lighting", {
    keyLightOn: true,
    keyLightIntensity: { value: 1.5, min: 0, max: 5, step: 0.1 },
    keyLightColor: "#ffffff",
    keyLightX: { value: 5, min: -10, max: 10, step: 0.5 },
    keyLightY: { value: 5, min: -10, max: 10, step: 0.5 },
    keyLightZ: { value: 5, min: -10, max: 10, step: 0.5 },
    fillLightOn: true,
    fillLightIntensity: { value: 0.6, min: 0, max: 5, step: 0.1 },
    fillLightColor: "#ffffff",
    fillLightX: { value: -5, min: -10, max: 10, step: 0.5 },
    fillLightY: { value: 3, min: -10, max: 10, step: 0.5 },
    fillLightZ: { value: -3, min: -10, max: 10, step: 0.5 },
    rimLightOn: true,
    rimLightIntensity: { value: 0.8, min: 0, max: 5, step: 0.1 },
    rimLightColor: "#ffffff",
    rimLightX: { value: -2, min: -10, max: 10, step: 0.5 },
    rimLightY: { value: -2, min: -10, max: 10, step: 0.5 },
    rimLightZ: { value: -5, min: -10, max: 10, step: 0.5 },
  });

  const [env] = usePersistedControls("Environment", {
    enabled: true,
    preset: {
      value: "studio",
      options: [
        "studio",
        "city",
        "sunset",
        "dawn",
        "night",
        "forest",
        "apartment",
        "lobby",
        "warehouse",
        "sky",
        "park",
        "cave chrome",
      ],
    },
    rotation: { value: 0, min: 0, max: 360, step: 1 },
    hdr: false,
    hdrBrightness: { value: 1, min: 0, max: 3, step: 0.01 },
  });

  const [cameraSettings] = usePersistedControls("Camera", {
    fov: { value: 45, min: 10, max: 120, step: 1 },
    orthographic: false,
  });

  const [fur] = usePersistedControls("Fur", {
    furOn: false,
    // Strand count. Modern GPUs handle 50k+ comfortably; bigger counts get
    // visibly slower because of vertex shader load + sampling cost.
    furCount: { value: 40000, min: 100, max: 120000, step: 500 },
    // furLength/furWidth are in geometry units; the shader scales them with
    // the host group's transform so the strands stay correctly sized at any
    // icon scale.
    furLength: { value: 12, min: 0.5, max: 80, step: 0.5 },
    furWidth: { value: 0.4, min: 0.02, max: 6, step: 0.02 },
    // 1 = constant-width ribbon, 0 = pointy triangle. Real fur sits low —
    // 0.2–0.4 reads as hair without disappearing pixels at the tip.
    furTipTaper: { value: 0.3, min: 0, max: 1, step: 0.01 },
    // Per-strand length jitter, ±this fraction. 0 = uniform length, 0.4 =
    // ±40%. Real fur sits low (~0.1) so coverage looks even rather than patchy.
    furLengthVariation: { value: 0.12, min: 0, max: 0.6, step: 0.01 },
    // Tangent jitter on the strand growth direction. 0 = strict normal
    // (quills on flat faces). 0.5 ≈ 27° tilt. 1 = 45°. 1.5 = 56°. Strands
    // always retain full outward magnitude — fluff only widens the canopy,
    // doesn't lay strands sideways, which would make their visible length
    // depend on camera angle.
    furFluff: { value: 0.5, min: 0, max: 1.5, step: 0.01 },
    // Sampling boost for sideways-facing surfaces (bevel + walls). Uniform
    // area-weighted sampling under-fills thin bevel bands; this boost makes
    // them visibly furred. 0 = off, 4 = walls weighted 5× the front/back.
    furBevelBoost: { value: 2.5, min: 0, max: 8, step: 0.1 },
    furSegments: { value: 4, min: 1, max: 8, step: 1 },
    furColorBase: "#2c1d10",
    furColorTip: "#b69472",
    furRoughness: { value: 0.85, min: 0, max: 1, step: 0.01 },
    furMetalness: { value: 0, min: 0, max: 1, step: 0.01 },
    furWindStrength: { value: 0.18, min: 0, max: 3, step: 0.01 },
    furWindSpeed: { value: 1.2, min: 0, max: 8, step: 0.05 },
    furWindFreq: { value: 0.5, min: 0, max: 5, step: 0.05 },
    furWindDirX: { value: 1, min: -1, max: 1, step: 0.05 },
    furWindDirZ: { value: 0.2, min: -1, max: 1, step: 0.05 },
    furStiffness: { value: 1.0, min: 0.2, max: 4, step: 0.05 },
    // Gravity: 0 = no droop, ~0.4 = subtle, ~1 = pronounced sag, 2 = floppy.
    furGravity: { value: 0.4, min: 0, max: 2, step: 0.01 },
    // Inertial lag: how much strands drag behind motion of the host.
    furInertia: { value: 0.7, min: 0, max: 2, step: 0.01 },
    // How quickly strands catch up to the host transform after motion.
    // Higher = snappier/stiffer; lower = floppier/longer-tail.
    furInertiaResponse: { value: 5, min: 0.5, max: 30, step: 0.1 },
    furCursorOn: true,
    furCursorRadius: { value: 1.2, min: 0.1, max: 10, step: 0.05 },
    // Cursor strength is in "multiples of blade length" — 1 ≈ tip pushed by
    // one blade length when directly under the cursor.
    furCursorStrength: { value: 1.0, min: 0, max: 6, step: 0.05 },
  });

  return { extrusion, material, uvMap, postfx, enamel, transform, lighting, env, cameraSettings, fur };
}

export type SceneControls = ReturnType<typeof useSceneControls>;
