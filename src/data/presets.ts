export interface Preset {
  name: string;
  settings: Record<string, Record<string, unknown>>;
}

// Shared defaults — every preset spreads these so applying a preset never
// inherits stale values from whatever the user had set before.
const BASE_EXTRUSION = {
  depthOn: true, bevelOn: true, bevelOffset: 0, bevelInward: false,
  curveSegments: 32, pathResolution: 12, cornerRadiusOn: true,
  solidify: false, solidBack: false, extrudeSteps: 24,
  smoothShading: true, creaseAngle: 40,
};

const BASE_MATERIAL = {
  colorOn: true, roughnessOn: true, metalnessOn: true,
  clearcoatOn: true, clearcoatRoughnessOn: true, envMapIntensityOn: true,
  transmissionOn: false, transmission: 0,
  thicknessOn: false, thickness: 1,
  iorOn: false, ior: 1.5,
  dispersionOn: false, dispersion: 0,
  normalMapOn: false, normalMapType: "brushed-h",
  normalScale: 0.5, normalRepeat: 4,
  displacementScale: 0, displacementBias: 0,
  bloomOn: false, bloomIntensity: 1, bloomThreshold: 0.9, bloomRadius: 0.8,
};

const BASE_TRANSFORM = {
  rotationOn: true, rotationX: 0, rotationY: 0, rotationZ: 0,
  scaleOn: true, scale: 0.04,
};

const BASE_CAMERA = { fov: 45, orthographic: false };

const STUDIO_LIGHTING = {
  keyLightOn: true, keyLightIntensity: 1.8, keyLightColor: "#ffffff",
  keyLightX: 5, keyLightY: 5, keyLightZ: 5,
  fillLightOn: true, fillLightIntensity: 0.7, fillLightColor: "#ffffff",
  fillLightX: -5, fillLightY: 3, fillLightZ: -3,
  rimLightOn: true, rimLightIntensity: 0.5, rimLightColor: "#ffffff",
  rimLightX: -2, rimLightY: -2, rimLightZ: -5,
};

const DRAMATIC_LIGHTING = {
  keyLightOn: true, keyLightIntensity: 2.0, keyLightColor: "#ffffff",
  keyLightX: 5, keyLightY: 6, keyLightZ: 5,
  fillLightOn: true, fillLightIntensity: 0.4, fillLightColor: "#ffffff",
  fillLightX: -5, fillLightY: 2, fillLightZ: -3,
  rimLightOn: true, rimLightIntensity: 0.9, rimLightColor: "#ffffff",
  rimLightX: -2, rimLightY: -2, rimLightZ: -5,
};

const SOFT_SHADOW = {
  enabled: true, offsetX: 0, offsetY: 8,
  blur1: 4, opacity1: 0.18,
  blur2: 16, opacity2: 0.12,
  blur3: 40, opacity3: 0.08,
  blur4: 80, opacity4: 0.04,
  color: "#000000",
};

const BIG_SHADOW = {
  enabled: true, offsetX: 0, offsetY: 16,
  blur1: 6, opacity1: 0.14,
  blur2: 24, opacity2: 0.10,
  blur3: 60, opacity3: 0.07,
  blur4: 120, opacity4: 0.04,
  color: "#000000",
};

const NO_SHADOW = {
  enabled: false, offsetX: 0, offsetY: 8,
  blur1: 4, opacity1: 0, blur2: 16, opacity2: 0,
  blur3: 40, opacity3: 0, blur4: 80, opacity4: 0,
  color: "#000000",
};

const NO_POSTFX = { aoOn: false };

const NO_ENAMEL = { enamelOn: false };

const NO_FUR = { furOn: false };

export const BUILT_IN_PRESETS: Preset[] = [
  {
    name: "Flat",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depthOn: false, depth: 0,
        bevelOn: false, bevelThickness: 0, bevelSize: 0, bevelSegments: 1,
        cornerRadiusOn: false, cornerRadius: 0,
        inflationOn: false, inflation: 0,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#2a2a2a", roughness: 1, metalness: 0,
        clearcoatOn: false, clearcoat: 0, clearcoatRoughness: 0,
        envMapIntensityOn: false, envMapIntensity: 0,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: {
        keyLightOn: false, keyLightIntensity: 0, keyLightColor: "#ffffff",
        keyLightX: 5, keyLightY: 5, keyLightZ: 5,
        fillLightOn: false, fillLightIntensity: 0, fillLightColor: "#ffffff",
        fillLightX: -5, fillLightY: 3, fillLightZ: -3,
        rimLightOn: false, rimLightIntensity: 0, rimLightColor: "#ffffff",
        rimLightX: -2, rimLightY: -2, rimLightZ: -5,
      },
      Environment: { enabled: false, preset: "studio", intensity: 0, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#ffffff" },
      Shadow: { ...NO_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Flat Matte",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 1.8, bevelThickness: 0.4, bevelSize: 0.4, bevelSegments: 6,
        cornerRadius: 0.5, inflationOn: false, inflation: 0,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#2a2a2a", roughness: 0.88, metalness: 0,
        clearcoat: 0, clearcoatRoughness: 0.5, envMapIntensity: 0.35,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...STUDIO_LIGHTING, keyLightIntensity: 1.6, rimLightIntensity: 0.25 },
      Environment: { enabled: true, preset: "studio", intensity: 0.3, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#f5f5f5" },
      Shadow: { ...SOFT_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Bubbly Pillow",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 3.5, bevelThickness: 3, bevelSize: 3, bevelSegments: 24,
        cornerRadius: 4, inflationOn: true, inflation: 0.28, extrudeSteps: 32,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#2a2a2a", roughness: 0.22, metalness: 0,
        clearcoat: 0.95, clearcoatRoughness: 0.12, envMapIntensity: 1.2,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...STUDIO_LIGHTING, keyLightIntensity: 1.5, fillLightIntensity: 0.8, rimLightIntensity: 0.6 },
      Environment: { enabled: true, preset: "studio", intensity: 0.8, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#f4f4f6" },
      Shadow: { ...BIG_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Chrome Badge",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 2.5, bevelThickness: 1.1, bevelSize: 0.63, bevelSegments: 32,
        bevelOffset: -0.2, cornerRadius: 0.5,
        inflationOn: false, inflation: 0.08, extrudeSteps: 16,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#9ea3ad", roughness: 0.08, metalness: 1,
        clearcoat: 0.9, clearcoatRoughness: 0.08, envMapIntensity: 1.6,
        bloomOn: true, bloomIntensity: 0.25, bloomThreshold: 1, bloomRadius: 0.49,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: {
        keyLightOn: true, keyLightIntensity: 2.5, keyLightColor: "#ffffff",
        keyLightX: 5, keyLightY: 6, keyLightZ: 5,
        fillLightOn: true, fillLightIntensity: 1.5, fillLightColor: "#ffffff",
        fillLightX: -5, fillLightY: 2, fillLightZ: -3,
        rimLightOn: true, rimLightIntensity: 0.9, rimLightColor: "#ffffff",
        rimLightX: -2, rimLightY: -2, rimLightZ: -5,
      },
      Environment: { enabled: true, preset: "city", intensity: 0.24, rotation: 30 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#141414" },
      Shadow: { ...NO_SHADOW },
      "Preview Shadow": {
        enabled: true, distance: 178, angle: 90, blur: 71,
        opacity: 1, color: "#000000", layers: 4,
      },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Soft Clay",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 4, bevelThickness: 2.4, bevelSize: 2.4, bevelSegments: 20,
        cornerRadius: 3, inflationOn: true, inflation: 0.18, extrudeSteps: 24,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#d4b894", roughness: 0.78, metalness: 0,
        clearcoat: 0, clearcoatRoughness: 0.5, envMapIntensity: 0.4,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...STUDIO_LIGHTING, keyLightIntensity: 1.8, fillLightIntensity: 0.8, rimLightIntensity: 0.3 },
      Environment: { enabled: true, preset: "apartment", intensity: 0.45, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#f2ebe0" },
      Shadow: { ...SOFT_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Glossy Candy",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 3.8, bevelThickness: 3, bevelSize: 3, bevelSegments: 24,
        cornerRadius: 5, inflationOn: true, inflation: 0.35, extrudeSteps: 32,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#d90429", roughness: 0.04, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.6,
        transmissionOn: true, transmission: 0.95,
        thicknessOn: true, thickness: 2.2,
        iorOn: true, ior: 1.52,
        dispersionOn: true, dispersion: 0.6,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...STUDIO_LIGHTING, keyLightIntensity: 2.2, fillLightIntensity: 0.9, rimLightIntensity: 1.1 },
      Environment: { enabled: true, preset: "studio", intensity: 1.1, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#fbeaec" },
      Shadow: { ...BIG_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Dark Steel",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 2.8, bevelThickness: 0.9, bevelSize: 0.9, bevelSegments: 14,
        cornerRadius: 1, inflationOn: false, inflation: 0,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#3a414d", roughness: 0.32, metalness: 0.9,
        clearcoat: 0.5, clearcoatRoughness: 0.25, envMapIntensity: 1.2,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...DRAMATIC_LIGHTING, keyLightIntensity: 1.8, rimLightIntensity: 0.8 },
      Environment: { enabled: true, preset: "warehouse", intensity: 0.8, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#0d1117" },
      Shadow: { ...NO_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Frosted Glass",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 2.5, bevelThickness: 1.6, bevelSize: 1.6, bevelSegments: 18,
        cornerRadius: 2, inflationOn: true, inflation: 0.08, extrudeSteps: 20,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#ffffff", roughness: 0.4, metalness: 0,
        clearcoat: 0.6, clearcoatRoughness: 0.3, envMapIntensity: 1.2,
        transmissionOn: true, transmission: 0.9,
        thicknessOn: true, thickness: 3,
        iorOn: true, ior: 1.45,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...STUDIO_LIGHTING, keyLightIntensity: 1.6, fillLightIntensity: 0.7, rimLightIntensity: 0.4 },
      Environment: { enabled: true, preset: "dawn", intensity: 0.9, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#1a1a1a" },
      Shadow: { ...NO_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Grass",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 1.6, bevelThickness: 0.4, bevelSize: 0.4, bevelSegments: 6,
        cornerRadius: 0.3, inflationOn: true, inflation: 0.14, extrudeSteps: 16,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#1d4012", roughness: 0.95, metalness: 0,
        clearcoatOn: false, clearcoat: 0, clearcoatRoughness: 0.5,
        envMapIntensity: 0.4,
        transmissionOn: false, transmission: 0,
        thicknessOn: false, thickness: 0,
        normalMapOn: false, normalMapType: "brushed-v",
        normalScale: 0.5, normalRepeat: 4,
        bloomOn: false, bloomIntensity: 0.55, bloomThreshold: 0.65, bloomRadius: 0.7,
      },
      "UV Map": {
        offsetX: 0, offsetY: 0,
        repeatX: 28, repeatY: 1,
        rotation: 0, centerX: 0.5, centerY: 0.5,
        wrapS: "repeat", wrapT: "repeat",
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: {
        keyLightOn: true, keyLightIntensity: 1.8, keyLightColor: "#fff5d6",
        keyLightX: 5, keyLightY: 7, keyLightZ: 4,
        fillLightOn: true, fillLightIntensity: 0.55, fillLightColor: "#8fb6cf",
        fillLightX: -5, fillLightY: 2, fillLightZ: -3,
        rimLightOn: true, rimLightIntensity: 1.6, rimLightColor: "#d8ffe0",
        rimLightX: -2, rimLightY: 5, rimLightZ: -5,
      },
      Environment: { enabled: true, preset: "forest", intensity: 0.45, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#1a2a18" },
      Shadow: { ...NO_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: {
        furOn: true,
        furCount: 50000,
        furLength: 14,
        furWidth: 0.4,
        furTipTaper: 0.3,
        furLengthVariation: 0.12,
        furFluff: 0.5,
        furBevelBoost: 2.5,
        furSegments: 4,
        furColorBase: "#2c1d10",
        furColorTip: "#b69472",
        furRoughness: 0.88,
        furMetalness: 0,
        furWindStrength: 0.18,
        furWindSpeed: 1.2,
        furWindFreq: 0.5,
        furWindDirX: 1,
        furWindDirZ: 0.2,
        furStiffness: 1.0,
        furGravity: 0.45,
        furInertia: 0.7,
        furInertiaResponse: 5,
        furCursorOn: true,
        furCursorRadius: 1.2,
        furCursorStrength: 1.0,
      },
    },
  },
  {
    name: "Dispersion Glass",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 3, bevelThickness: 2, bevelSize: 2, bevelSegments: 20,
        cornerRadius: 2, inflationOn: true, inflation: 0.1, extrudeSteps: 20,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#ffffff", roughness: 0, metalness: 0,
        clearcoat: 1, clearcoatRoughness: 0, envMapIntensity: 2,
        transmissionOn: true, transmission: 1,
        thicknessOn: true, thickness: 5,
        iorOn: true, ior: 1.8,
        dispersionOn: true, dispersion: 3,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: { ...DRAMATIC_LIGHTING, keyLightIntensity: 1.2, fillLightIntensity: 0.5, rimLightIntensity: 0.5 },
      Environment: { enabled: true, preset: "city", intensity: 1.5, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#0a0a0a" },
      Shadow: { ...NO_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Classic Metal",
    settings: {
      Extrusion: {
        depthOn: false, depth: 1, bevelOn: true, bevelThickness: 0.66,
        bevelSize: 0.74, bevelSegments: 1, bevelOffset: 0.1, bevelInward: true,
        curveSegments: 64, pathResolution: 24,
        cornerRadiusOn: false, cornerRadius: 0, outerCornerRadius: 0, innerCornerRadius: 0,
        solidify: false, solidBack: false, inflationOn: false, inflation: 0, extrudeSteps: 2,
        smoothShading: true, creaseAngle: 40,
      },
      Material: {
        colorOn: true, color: "#909090", roughnessOn: true, roughness: 0.17,
        metalnessOn: true, metalness: 1,
        clearcoatOn: true, clearcoat: 1,
        clearcoatRoughnessOn: true, clearcoatRoughness: 0.02,
        envMapIntensityOn: true, envMapIntensity: 1.8,
        transmissionOn: false, transmission: 0,
        thicknessOn: false, thickness: 8.4,
        iorOn: false, ior: 1.5,
        dispersionOn: false, dispersion: 0,
        normalMapOn: false, normalMapType: "brushed-h",
        normalScale: 0.5, normalRepeat: 4,
      },
      Transform: {
        rotationOn: true, rotationX: 0, rotationY: 0, rotationZ: 0,
        scaleOn: true, scale: 0.04,
      },
      Lighting: {
        keyLightOn: true, keyLightIntensity: 1.8, keyLightColor: "#ffffff",
        keyLightX: 5, keyLightY: 5, keyLightZ: 5,
        fillLightOn: true, fillLightIntensity: 0.7, fillLightColor: "#ffffff",
        fillLightX: -5, fillLightY: 3, fillLightZ: -3,
        rimLightOn: true, rimLightIntensity: 1.2, rimLightColor: "#ffffff",
        rimLightX: -2, rimLightY: -2, rimLightZ: -5,
      },
      Environment: { enabled: true, preset: "studio", intensity: 1.2, rotation: 268 },
      Camera: { fov: 42, orthographic: false },
      Background: { bgColor: "#ffffff" },
      Shadow: {
        enabled: true, offsetX: 0, offsetY: 8,
        blur1: 4, opacity1: 0.18,
        blur2: 16, opacity2: 0.12,
        blur3: 40, opacity3: 0.08,
        blur4: 80, opacity4: 0.04,
        color: "#000000",
      },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Polished Chrome",
    settings: {
      Extrusion: {
        depthOn: false, depth: 1, bevelOn: true, bevelThickness: 0.6599999999999998,
        bevelSize: 0.74, bevelSegments: 1, bevelOffset: 0.1, bevelInward: true,
        curveSegments: 64, pathResolution: 24,
        cornerRadiusOn: false, cornerRadius: 0, outerCornerRadius: 0, innerCornerRadius: 0,
        solidify: false, solidBack: false, inflationOn: false, inflation: 0, extrudeSteps: 2,
        smoothShading: true, creaseAngle: 40,
      },
      Material: {
        colorOn: true, color: "#c8ccd2", roughnessOn: true, roughness: 0.04,
        metalnessOn: true, metalness: 1,
        clearcoatOn: true, clearcoat: 1,
        clearcoatRoughnessOn: true, clearcoatRoughness: 0.02,
        envMapIntensityOn: true, envMapIntensity: 1.8,
        transmissionOn: false, transmission: 0,
        thicknessOn: false, thickness: 8.4,
        iorOn: false, ior: 1.5,
        dispersionOn: false, dispersion: 0,
        normalMapOn: false, normalMapType: "brushed-h",
        normalScale: 0.5, normalRepeat: 4,
      },
      Transform: {
        rotationOn: true, rotationX: 0, rotationY: 0, rotationZ: 0,
        scaleOn: true, scale: 0.03,
      },
      Lighting: {
        keyLightOn: true, keyLightIntensity: 1.8, keyLightColor: "#ffffff",
        keyLightX: 5, keyLightY: 5, keyLightZ: 5,
        fillLightOn: true, fillLightIntensity: 0.7, fillLightColor: "#ffffff",
        fillLightX: -5, fillLightY: 3, fillLightZ: -3,
        rimLightOn: true, rimLightIntensity: 1.2, rimLightColor: "#ffffff",
        rimLightX: -2, rimLightY: -2, rimLightZ: -5,
      },
      Environment: { enabled: true, preset: "studio", intensity: 1.2, rotation: 268 },
      Camera: { fov: 42, orthographic: false },
      Background: { bgColor: "#ffffff" },
      Shadow: {
        enabled: true, offsetX: 0, offsetY: 8,
        blur1: 4, opacity1: 0.18,
        blur2: 16, opacity2: 0.12,
        blur3: 40, opacity3: 0.08,
        blur4: 80, opacity4: 0.04,
        color: "#000000",
      },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Chicken Nugget",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 1.27, bevelThickness: 2.83, bevelSize: 2.48, bevelSegments: 19,
        cornerRadius: 7, solidify: true, inflationOn: false, inflation: 0.4,
        extrudeSteps: 32, smoothShading: false,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#e39340", roughness: 0.92, metalness: 0,
        clearcoatOn: true, clearcoat: 0.08, clearcoatRoughness: 0.85,
        envMapIntensity: 0.45,
        normalMapOn: true, normalMapType: "nugget",
        normalScale: 0, normalRepeat: 0.75,
        displacementScale: 15, displacementBias: -7.5,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: {
        ...DRAMATIC_LIGHTING,
        keyLightIntensity: 2.2, fillLightIntensity: 0.45, rimLightIntensity: 0.9,
      },
      Environment: { enabled: true, preset: "studio", intensity: 0.3, rotation: 0 },
      Camera: { ...BASE_CAMERA },
      Background: { bgColor: "#f5f3ee" },
      Shadow: { ...SOFT_SHADOW },
      "Post FX": { ...NO_POSTFX },
      "Enamel Fill": { ...NO_ENAMEL },
      Fur: { ...NO_FUR },
    },
  },
  {
    name: "Enamel Pin",
    settings: {
      Extrusion: {
        ...BASE_EXTRUSION,
        depth: 0.69, bevelThickness: 0.3, bevelSize: 0.22, bevelSegments: 8,
        bevelOffset: 0, bevelInward: true,
        curveSegments: 32, pathResolution: 12,
        cornerRadiusOn: true, cornerRadius: 0.1,
        outerCornerRadius: 0.1, innerCornerRadius: 0.1,
        solidify: false, solidBack: true,
        inflationOn: false, inflation: 0, extrudeSteps: 64,
        smoothShading: true, creaseAngle: 82,
      },
      Material: {
        ...BASE_MATERIAL,
        color: "#c7c7c7", roughness: 0.43, metalness: 0.7,
        clearcoat: 0, clearcoatRoughness: 0.31, envMapIntensity: 0.35,
        normalMapOn: true, normalMapType: "rough", normalScale: 0.49, normalRepeat: 5,
        bloomOn: true, bloomIntensity: 0.25, bloomThreshold: 1, bloomRadius: 0.49,
      },
      Transform: { ...BASE_TRANSFORM },
      Lighting: {
        keyLightOn: false, keyLightIntensity: 1.6, keyLightColor: "#ffffff",
        keyLightX: 5, keyLightY: 5, keyLightZ: 5,
        fillLightOn: false, fillLightIntensity: 0.7, fillLightColor: "#ffffff",
        fillLightX: -5, fillLightY: 3, fillLightZ: -3,
        rimLightOn: true, rimLightIntensity: 0.25, rimLightColor: "#ffffff",
        rimLightX: -2, rimLightY: -2, rimLightZ: -5,
      },
      Environment: { enabled: true, preset: "studio", intensity: 0.9, rotation: 8 },
      Camera: { fov: 42, orthographic: false },
      Background: { bgColor: "#f5f5f5" },
      Shadow: { ...SOFT_SHADOW },
      "Preview Shadow": {
        enabled: true, distance: 178, angle: 90, blur: 71,
        opacity: 1, color: "#000000", layers: 4,
      },
      "Enamel Fill": {
        enamelOn: true, enamelColor: "#000000",
        enamelOffset: -0.35, enamelDome: 0.5, enamelZ: 1.9,
        enamelRoughness: 0.23, enamelMetalness: 0.12,
        enamelClearcoat: 0.38, enamelClearcoatRoughness: 0.11,
        enamelEnvMapIntensity: 0.14,
      },
      "Post FX": {
        aoOn: true, aoIntensity: 1.95, aoRadius: 0.5,
        aoFalloff: 1, aoColor: "#000000",
      },
      Fur: { ...NO_FUR },
    },
  },
];

export async function loadCustomPresets(): Promise<Preset[]> {
  try {
    const res = await fetch("/api/presets");
    return res.ok ? await res.json() : [];
  } catch {
    return [];
  }
}

export async function saveCurrentAsPreset(name: string): Promise<Preset | null> {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem("enamel-pin-settings");
    if (!raw) return null;
    const settings = JSON.parse(raw);
    const preset: Preset = { name, settings };
    await fetch("/api/presets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(preset),
    });
    return preset;
  } catch {
    return null;
  }
}

export async function deleteCustomPreset(name: string): Promise<void> {
  await fetch("/api/presets", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export async function reorderPresets(ordered: Preset[]): Promise<void> {
  await fetch("/api/presets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ordered),
  });
}

export function exportPreset(preset: Preset): void {
  const json = JSON.stringify(preset, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${preset.name.replace(/[^a-z0-9_-]/gi, "_")}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function exportCurrentAsPreset(name: string): void {
  if (typeof window === "undefined") return;
  const raw = localStorage.getItem("enamel-pin-settings");
  if (!raw) return;
  const settings = JSON.parse(raw);
  exportPreset({ name, settings });
}

export async function copyPresetToClipboard(preset: Preset): Promise<void> {
  const json = JSON.stringify(preset, null, 2);
  await navigator.clipboard.writeText(json);
}

export async function copyCurrentAsPreset(name: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const raw = localStorage.getItem("enamel-pin-settings");
  if (!raw) return false;
  const settings = JSON.parse(raw);
  await copyPresetToClipboard({ name, settings });
  return true;
}

export function importPresetFromFile(file: File): Promise<Preset> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const preset = JSON.parse(reader.result as string) as Preset;
        if (!preset.name || !preset.settings) {
          reject(new Error("Invalid preset file"));
          return;
        }
        resolve(preset);
      } catch {
        reject(new Error("Invalid JSON"));
      }
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsText(file);
  });
}
