"use client";

import { useMemo, useRef, useEffect } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";

export interface GrassFurProps {
  /** Host geometry — strands are sampled across its surface, area-weighted. */
  geometry: THREE.BufferGeometry | null;
  count: number;
  length: number;
  width: number;
  segments: number;
  /**
   * Width at the tip relative to the base. 1 = constant width (cylinder strip),
   * 0 = pointy triangle. Real fur sits somewhere around 0.25–0.45.
   */
  tipTaper: number;
  /**
   * 0–1 amount each strand's growth direction is randomly perturbed off the
   * surface normal. 0 = strict normal (aligned hair), 1 = uniformly random
   * over the hemisphere. ~0.4–0.6 reads as a fur-ball even on flat faces;
   * without it strands on flat surfaces all point at the camera and look
   * like specks rather than bushy coverage.
   */
  fluff: number;
  /**
   * Per-strand length jitter, ±this fraction. 0 = all strands identical
   * length, 0.4 = ±40% variation. Real fur is around 0.1–0.2; higher reads
   * as patchy / inconsistent.
   */
  lengthVariation: number;
  /**
   * Sampling weight for sideways-facing surfaces (bevels + walls). 0 = pure
   * area-weighted (bevel band gets few strands because it's a thin ring of
   * small area); higher values boost coverage on bevels and walls. Computed
   * from the surface normal so it stays general — works on any extruded SVG.
   */
  bevelBoost: number;
  colorBase: string;
  colorTip: string;
  roughness: number;
  metalness: number;
  windStrength: number;
  windSpeed: number;
  windFreq: number;
  windDirX: number;
  windDirZ: number;
  cursorOn: boolean;
  cursorRadius: number;
  cursorStrength: number;
  stiffness: number;
  /** World-space gravity strength, in multiples of strand length. */
  gravity: number;
  /** Inertia: how much each strand's tip lags behind motion of the host. */
  inertia: number;
  /**
   * How fast the lag follower catches up to the host transform, in Hz-ish
   * units. Higher = snappier strands; lower = floppier. ~5 feels natural.
   */
  inertiaResponse: number;
}

/**
 * Blade template: a flat strip with `position.x ∈ [-0.5, 0.5]` and
 * `position.y ∈ [0, 1]`. The shader applies the per-instance frame, scale,
 * width, and tip taper in object space, so this template can stay simple.
 */
function makeBladeGeometry(segments: number): THREE.BufferGeometry {
  const seg = Math.max(1, Math.floor(segments));
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const y = i / seg;
    positions.push(-0.5, y, 0);
    positions.push( 0.5, y, 0);
    uvs.push(0, y, 1, y);
    if (i < seg) {
      const a = i * 2;
      const b = a + 1;
      const c = a + 2;
      const d = a + 3;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

export default function GrassFur({
  geometry,
  count,
  length,
  width,
  segments,
  tipTaper,
  fluff,
  lengthVariation,
  bevelBoost,
  colorBase,
  colorTip,
  roughness,
  metalness,
  windStrength,
  windSpeed,
  windFreq,
  windDirX,
  windDirZ,
  cursorOn,
  cursorRadius,
  cursorStrength,
  stiffness,
  gravity,
  inertia,
  inertiaResponse,
}: GrassFurProps) {
  const meshRef = useRef<THREE.Mesh>(null);
  const { camera, gl } = useThree();

  // Stable uniforms object. Values mutated in place each frame; recreating
  // would force a shader recompile.
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uLength: { value: length },
      uWidth: { value: width },
      uTipTaper: { value: tipTaper },
      uLengthVar: { value: lengthVariation },
      uColorBase: { value: new THREE.Color(colorBase) },
      uColorTip: { value: new THREE.Color(colorTip) },
      uWindStrength: { value: windStrength },
      uWindSpeed: { value: windSpeed },
      uWindFreq: { value: windFreq },
      // Wind direction is configured in world space; we transform it into the
      // host's object space each frame so the blade-bend math is rotation-
      // invariant w.r.t. the host group's flip / rotation animations.
      uWindDirLocal: { value: new THREE.Vector3(1, 0, 0) },
      uWindDirWorld: { value: new THREE.Vector3(1, 0, 0) },
      uStiffness: { value: stiffness },
      // Cursor position in object space (precomputed CPU-side from the world-
      // space hit point so the shader doesn't need to invert modelMatrix).
      uCursorPosLocal: { value: new THREE.Vector3(1e9, 1e9, 1e9) },
      uCursorRadius: { value: cursorRadius },
      uCursorStrength: { value: cursorStrength },
      uCursorOn: { value: 0 },
      uModelScale: { value: 1 },
      // Gravity in object space — world (0,-1,0) rotated through the host's
      // inverse orientation each frame so it always pulls strands toward
      // world-down, not the icon's local "down."
      uGravityLocal: { value: new THREE.Vector3(0, -1, 0) },
      uGravity: { value: gravity },
      // uPrevToCurrent = inverse(currentMatrix) * laggedMatrix. Multiplying
      // an anchor by this gives where the anchor "would have been" if the
      // host transform were lagged — the difference is the inertial offset.
      uPrevToCurrent: { value: new THREE.Matrix4() },
      uInertia: { value: inertia },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // Patch a MeshStandardMaterial. Going through StandardMaterial (instead of a
  // custom ShaderMaterial) keeps the strands wired into the standard lighting
  // pipeline — direct lights, env map, IBL, shadows, and N8AO all work because
  // we just inject vertex displacement + a per-blade diffuse tint.
  const material = useMemo(() => {
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness,
      metalness,
      side: THREE.DoubleSide,
      shadowSide: THREE.DoubleSide,
    });

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          `#include <common>
          attribute vec3 aPos;
          attribute vec3 aNrm;
          attribute vec3 aTan;
          attribute vec4 aRand;
          uniform float uTime;
          uniform float uLength;
          uniform float uWidth;
          uniform float uTipTaper;
          uniform float uLengthVar;
          uniform float uWindStrength;
          uniform float uWindSpeed;
          uniform float uWindFreq;
          uniform vec3 uWindDirLocal;
          uniform vec3 uWindDirWorld;
          uniform float uStiffness;
          uniform vec3 uCursorPosLocal;
          uniform float uCursorRadius;
          uniform float uCursorStrength;
          uniform float uCursorOn;
          uniform float uModelScale;
          uniform vec3 uGravityLocal;
          uniform float uGravity;
          uniform mat4 uPrevToCurrent;
          uniform float uInertia;
          varying float vBladeProgress;
          varying float vBladeShade;
          varying float vBladeMix;
          // Computed in <beginnormal_vertex>, used in <begin_vertex>.
          vec3 gFurUp;
          vec3 gFurSide;
          `,
        )
        .replace(
          "#include <beginnormal_vertex>",
          `
          gFurUp = normalize(aNrm);
          vec3 tProj = aTan - gFurUp * dot(aTan, gFurUp);
          if (dot(tProj, tProj) < 1e-6) {
            tProj = (abs(gFurUp.y) < 0.9)
              ? cross(gFurUp, vec3(0.0, 1.0, 0.0))
              : cross(gFurUp, vec3(1.0, 0.0, 0.0));
          }
          vec3 oSide = normalize(tProj);
          float bladeYaw = aRand.z * 6.2831853;
          gFurSide = oSide * cos(bladeYaw) + cross(gFurUp, oSide) * sin(bladeYaw);
          vec3 oFwd = normalize(cross(gFurUp, gFurSide));
          // The blade's "front" face (the side that catches direct light) is
          // perpendicular to its growth axis and yawed-side. Using oFwd here
          // gives realistic Lambert shading — strands facing the key light go
          // bright, strands rotated away go dark.
          vec3 objectNormal = oFwd;
          #ifdef USE_TANGENT
          vec4 objectTangent = vec4(gFurSide, 1.0);
          #endif
          `,
        )
        .replace(
          "#include <begin_vertex>",
          `
          // Per-strand length jitter, centered on 1.0 with ±uLengthVar range.
          // Defaulting to a tight band keeps the surface coverage looking
          // even rather than patchy.
          float bladeScl = 1.0 + (aRand.y * 2.0 - 1.0) * clamp(uLengthVar, 0.0, 0.95);
          float taperFactor = mix(1.0, clamp(uTipTaper, 0.0, 1.0), position.y);
          vec3 local = gFurSide * (position.x * uWidth * bladeScl * taperFactor)
                     + gFurUp   * (position.y * uLength * bladeScl);

          float bend = position.y * position.y;

          // Wind: bend in object-space wind direction, projected onto the
          // surface tangent plane so we don't push into the host mesh.
          vec3 windVec = uWindDirLocal - gFurUp * dot(uWindDirLocal, gFurUp);
          float wvl = length(windVec);
          if (wvl > 1e-4) windVec /= wvl;
          float phase = aRand.x * 6.2831853;
          vec3 worldAnchor = (modelMatrix * vec4(aPos, 1.0)).xyz;
          float spatial = (worldAnchor.x * uWindDirWorld.x + worldAnchor.z * uWindDirWorld.z) * uWindFreq;
          float windAmt = sin(uTime * uWindSpeed + spatial + phase) * uWindStrength;
          vec3 windDisp = windVec * bend * windAmt * uLength * bladeScl;

          // Cursor push: compare distance in object space (cursor pos was
          // converted on the CPU). Radius is converted from world units via
          // uModelScale so the user-facing knob stays world-relative.
          vec3 cursorDisp = vec3(0.0);
          if (uCursorOn > 0.5) {
            vec3 dLocal = (aPos + local) - uCursorPosLocal;
            float distLocal = length(dLocal);
            float radiusLocal = uCursorRadius / max(uModelScale, 1e-4);
            if (distLocal > 1e-4 && distLocal < radiusLocal) {
              float falloff = 1.0 - distLocal / radiusLocal;
              falloff *= falloff;
              vec3 push = dLocal / distLocal;
              push -= gFurUp * dot(push, gFurUp);
              float plen = length(push);
              if (plen > 1e-4) push /= plen;
              cursorDisp = push * falloff * uCursorStrength * bend * uLength * bladeScl / max(uStiffness, 0.1);
            }
          }

          // Gravity: project world-down (in object space) onto the strand's
          // tangent plane and bend the tip toward it. Strands already pointing
          // along gravity feel none; ones pointing against it droop the most.
          vec3 gravVec = uGravityLocal - gFurUp * dot(uGravityLocal, gFurUp);
          float gvl = length(gravVec);
          if (gvl > 1e-4) gravVec /= gvl;
          float perpFactor = 1.0 - clamp(dot(uGravityLocal, gFurUp), -1.0, 1.0);
          float gravAmt = uGravity * perpFactor * 0.5;
          vec3 gravDisp = gravVec * (bend * gravAmt * uLength * bladeScl) / max(uStiffness, 0.1);

          // Inertial lag: an anchor's "lagged" object-space position, evaluated
          // through the precomputed prev→current matrix. The difference is the
          // direction the strand should drag in. Applied at the tip so the
          // base stays attached to the surface.
          vec3 anchorLagLocal = (uPrevToCurrent * vec4(aPos, 1.0)).xyz;
          vec3 lagLocal = (anchorLagLocal - aPos) * uInertia;
          // Project lag onto the tangent plane too — strands swing across the
          // surface, they don't sink into it.
          lagLocal -= gFurUp * dot(lagLocal, gFurUp);
          vec3 inertiaDisp = lagLocal * bend;

          vec3 transformed = aPos + local + windDisp + cursorDisp + gravDisp + inertiaDisp;

          vBladeProgress = position.y;
          vBladeShade = aRand.w;
          vBladeMix = aRand.y;
          `,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
          uniform vec3 uColorBase;
          uniform vec3 uColorTip;
          varying float vBladeProgress;
          varying float vBladeShade;
          varying float vBladeMix;
          `,
        )
        .replace(
          "#include <map_fragment>",
          `
          // Per-blade diffuse tint: gradient base→tip with random shade
          // (±25%) plus a tip rim brightening. Multiplies onto diffuseColor
          // (which is material.color = white) so the standard lighting model
          // sees this as the surface albedo.
          vec3 furBase = mix(uColorBase, uColorTip, pow(vBladeProgress, 1.2));
          furBase *= mix(0.7, 1.3, vBladeShade);
          // Slight saturation jitter per blade for natural variation.
          float satShift = mix(0.85, 1.15, vBladeMix);
          vec3 luma = vec3(dot(furBase, vec3(0.299, 0.587, 0.114)));
          furBase = mix(luma, furBase, satShift);
          float rim = smoothstep(0.65, 1.0, vBladeProgress) * 0.18;
          furBase += rim;
          diffuseColor.rgb *= furBase;
          `,
        );
    };

    return mat;
  }, [uniforms, roughness, metalness]);

  useEffect(() => () => material.dispose(), [material]);

  // Build the instanced strand geometry. Resamples only when count, segments,
  // or the host geometry change.
  const bladeGeom = useMemo(() => {
    if (!geometry) return null;
    if (!geometry.attributes?.position) return null;

    let inst: THREE.InstancedBufferGeometry;
    try {
      const blade = makeBladeGeometry(segments);
      inst = new THREE.InstancedBufferGeometry();
      inst.setIndex(blade.getIndex());
      inst.setAttribute("position", blade.getAttribute("position"));
      inst.setAttribute("normal", blade.getAttribute("normal"));
      inst.setAttribute("uv", blade.getAttribute("uv"));
      inst.instanceCount = count;

      // Compute a per-vertex sampling weight that boosts sideways-facing
      // surfaces (bevel + walls). Uniform area-weighting under-samples the
      // bevel band because it's a thin ring of small area; biasing here makes
      // strands actually appear there. Weight = 1 + boost * |xy-component
      // of normal|, so flat front/back faces stay at weight 1 and pure walls
      // get (1 + boost). Bevel triangles fall in between.
      const normalAttr = geometry.getAttribute("normal") as THREE.BufferAttribute | undefined;
      let sampleGeom: THREE.BufferGeometry = geometry;
      if (normalAttr && bevelBoost > 0) {
        const vCount = normalAttr.count;
        const weights = new Float32Array(vCount);
        for (let i = 0; i < vCount; i++) {
          const nx = normalAttr.getX(i);
          const ny = normalAttr.getY(i);
          const sideways = Math.sqrt(nx * nx + ny * ny);
          weights[i] = 1 + bevelBoost * sideways;
        }
        // Clone-shell so we can attach the temporary weight attribute without
        // mutating the geometry the main mesh is rendering with.
        sampleGeom = new THREE.BufferGeometry();
        sampleGeom.setIndex(geometry.getIndex());
        for (const k of Object.keys(geometry.attributes)) {
          sampleGeom.setAttribute(k, geometry.getAttribute(k));
        }
        sampleGeom.setAttribute("_furWeight", new THREE.BufferAttribute(weights, 1));
      }
      const sampleMesh = new THREE.Mesh(sampleGeom, new THREE.MeshBasicMaterial());
      const samplerBuilder = new MeshSurfaceSampler(sampleMesh);
      if (sampleGeom !== geometry) samplerBuilder.setWeightAttribute("_furWeight");
      const sampler = samplerBuilder.build();

      const aPos = new Float32Array(count * 3);
      const aNrm = new Float32Array(count * 3);
      const aTan = new Float32Array(count * 3);
      const aRand = new Float32Array(count * 4);

      const p = new THREE.Vector3();
      const n = new THREE.Vector3();
      const f = Math.max(0, Math.min(1.5, fluff));
      for (let i = 0; i < count; i++) {
        sampler.sample(p, n);
        if (n.lengthSq() < 1e-8) n.set(0, 0, 1);
        n.normalize();

        // Direction perturbation: keep the normal at full strength and add a
        // unit tangent component scaled by `fluff`. Tilt angle from normal
        // is atan(f) — f=0.5 → 27°, f=1 → 45°. This way every strand still
        // grows fully outward (no foreshortening collapse on flat faces) and
        // `fluff` only controls how spread out the canopy is. The previous
        // lerp-to-random formula tilted strands so far they were nearly
        // tangent on flat faces, which read as wildly varying lengths.
        let rx = 0, ry = 0, rz = 0;
        for (let tries = 0; tries < 8; tries++) {
          rx = Math.random() * 2 - 1;
          ry = Math.random() * 2 - 1;
          rz = Math.random() * 2 - 1;
          const lenSq = rx * rx + ry * ry + rz * rz;
          if (lenSq > 1e-4 && lenSq <= 1) {
            const inv = 1 / Math.sqrt(lenSq);
            rx *= inv; ry *= inv; rz *= inv;
            break;
          }
        }
        // Project random onto the tangent plane (subtract its normal component).
        const tDot = rx * n.x + ry * n.y + rz * n.z;
        let ttx = rx - n.x * tDot;
        let tty = ry - n.y * tDot;
        let ttz = rz - n.z * tDot;
        const ttl = Math.hypot(ttx, tty, ttz);
        if (ttl > 1e-4) { ttx /= ttl; tty /= ttl; ttz /= ttl; }

        const dx = n.x + ttx * f;
        const dy = n.y + tty * f;
        const dz = n.z + ttz * f;
        const dl = Math.hypot(dx, dy, dz) || 1;
        const gx = dx / dl, gy = dy / dl, gz = dz / dl;

        aPos[i * 3 + 0] = p.x;
        aPos[i * 3 + 1] = p.y;
        aPos[i * 3 + 2] = p.z;
        aNrm[i * 3 + 0] = gx;
        aNrm[i * 3 + 1] = gy;
        aNrm[i * 3 + 2] = gz;
        // Tangent perpendicular to the (perturbed) growth direction, picked
        // off whichever axis is least aligned with it for numerical stability.
        const ax = Math.abs(gx), ay = Math.abs(gy), az = Math.abs(gz);
        let tx, ty, tz;
        if (ax <= ay && ax <= az) { tx = 0;     ty = -gz;  tz = gy; }
        else if (ay <= az)        { tx = -gz;   ty = 0;    tz = gx; }
        else                      { tx = -gy;   ty = gx;   tz = 0;  }
        const tl = Math.hypot(tx, ty, tz) || 1;
        aTan[i * 3 + 0] = tx / tl;
        aTan[i * 3 + 1] = ty / tl;
        aTan[i * 3 + 2] = tz / tl;
        aRand[i * 4 + 0] = Math.random();
        aRand[i * 4 + 1] = Math.random();
        aRand[i * 4 + 2] = Math.random();
        aRand[i * 4 + 3] = Math.random();
      }

      inst.setAttribute("aPos", new THREE.InstancedBufferAttribute(aPos, 3));
      inst.setAttribute("aNrm", new THREE.InstancedBufferAttribute(aNrm, 3));
      inst.setAttribute("aTan", new THREE.InstancedBufferAttribute(aTan, 3));
      inst.setAttribute("aRand", new THREE.InstancedBufferAttribute(aRand, 4));

      // Bounds large enough to cover anchor cloud + projected blade height,
      // with margin for wind/cursor sway. Without this, frustum culling can
      // drop the entire mesh at certain camera angles.
      geometry.computeBoundingBox();
      const hb = geometry.boundingBox!;
      const center = new THREE.Vector3(
        (hb.min.x + hb.max.x) * 0.5,
        (hb.min.y + hb.max.y) * 0.5,
        (hb.min.z + hb.max.z) * 0.5,
      );
      const radius = hb.min.distanceTo(hb.max) * 0.5 + length * 2;
      inst.boundingSphere = new THREE.Sphere(center, radius);
      inst.boundingBox = new THREE.Box3(
        hb.min.clone().subScalar(length * 1.5),
        hb.max.clone().addScalar(length * 1.5),
      );
    } catch (err) {
      console.error("[GrassFur] failed to build strand geometry:", err);
      return null;
    }
    return inst;
    // length excluded — only changes bounds, not topology.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometry, count, segments, fluff, bevelBoost]);

  useEffect(() => () => bladeGeom?.dispose(), [bladeGeom]);

  useEffect(() => {
    uniforms.uLength.value = length;
    uniforms.uWidth.value = width;
    uniforms.uTipTaper.value = tipTaper;
    uniforms.uLengthVar.value = lengthVariation;
    uniforms.uColorBase.value.set(colorBase);
    uniforms.uColorTip.value.set(colorTip);
    uniforms.uWindStrength.value = windStrength;
    uniforms.uWindSpeed.value = windSpeed;
    uniforms.uWindFreq.value = windFreq;
    uniforms.uStiffness.value = stiffness;
    uniforms.uCursorRadius.value = cursorRadius;
    uniforms.uCursorStrength.value = cursorStrength;
    uniforms.uGravity.value = gravity;
    uniforms.uInertia.value = inertia;
    material.roughness = roughness;
    material.metalness = metalness;
  }, [
    uniforms, material,
    length, width, tipTaper, lengthVariation,
    colorBase, colorTip,
    roughness, metalness,
    windStrength, windSpeed, windFreq,
    stiffness, cursorRadius, cursorStrength,
    gravity, inertia,
  ]);

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useMemo(() => new THREE.Vector2(), []);
  const hoverRef = useRef(false);
  const raycastMesh = useRef<THREE.Mesh | null>(null);

  // Per-frame scratch — declared once, reused.
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpQuatInv = useMemo(() => new THREE.Quaternion(), []);
  const tmpScale = useMemo(() => new THREE.Vector3(), []);
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpVec = useMemo(() => new THREE.Vector3(), []);
  const tmpVecLocal = useMemo(() => new THREE.Vector3(), []);
  const tmpGrav = useMemo(() => new THREE.Vector3(), []);

  // Lag-follower transform, decomposed for stable slerp/lerp interpolation
  // toward the host's matrix each frame.
  const lagPos = useMemo(() => new THREE.Vector3(), []);
  const lagQuat = useMemo(() => new THREE.Quaternion(), []);
  const lagScale = useMemo(() => new THREE.Vector3(1, 1, 1), []);
  const lagMatrix = useMemo(() => new THREE.Matrix4(), []);
  const invCurrent = useMemo(() => new THREE.Matrix4(), []);
  const lagInitRef = useRef(false);

  useEffect(() => {
    if (!cursorOn) {
      hoverRef.current = false;
      return;
    }
    const dom = gl.domElement;
    const onMove = (e: PointerEvent) => {
      const rect = dom.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      hoverRef.current = true;
    };
    const onLeave = () => {
      hoverRef.current = false;
    };
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", onLeave);
    return () => {
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", onLeave);
    };
  }, [cursorOn, gl, ndc]);

  useFrame(({ clock }, delta) => {
    uniforms.uTime.value = clock.elapsedTime;
    if (!meshRef.current) return;

    // Decompose host transform every frame so flip / rotate animations get
    // picked up. uniform scale assumed (the existing presets all use one).
    meshRef.current.matrixWorld.decompose(tmpPos, tmpQuat, tmpScale);
    uniforms.uModelScale.value = tmpScale.x;
    tmpQuatInv.copy(tmpQuat).invert();

    // World-space wind direction (user-facing knob).
    tmpVec.set(windDirX || 1, 0, windDirZ);
    if (tmpVec.lengthSq() < 1e-6) tmpVec.set(1, 0, 0);
    tmpVec.normalize();
    uniforms.uWindDirWorld.value.copy(tmpVec);
    // Same direction expressed in object space — undo the host group's
    // rotation so a fixed wind looks the same regardless of icon orientation.
    tmpVecLocal.copy(tmpVec).applyQuaternion(tmpQuatInv);
    uniforms.uWindDirLocal.value.copy(tmpVecLocal);

    // Gravity: world-down, expressed in object space. Same trick.
    tmpGrav.set(0, -1, 0).applyQuaternion(tmpQuatInv);
    uniforms.uGravityLocal.value.copy(tmpGrav);

    // Inertial lag: the follower transform chases the host with a damped
    // first-order response. Decompose, slerp/lerp toward current, recompose.
    // On first frame, snap to the host (no lag at startup).
    const cur = meshRef.current.matrixWorld;
    if (!lagInitRef.current) {
      lagPos.copy(tmpPos);
      lagQuat.copy(tmpQuat);
      lagScale.copy(tmpScale);
      lagInitRef.current = true;
    } else {
      // Exponential approach factor: alpha = 1 - exp(-dt * response). With
      // response = 5 Hz, the strand catches up to ~63% of the gap per ~0.2 s.
      const alpha = 1 - Math.exp(-Math.max(0, delta) * Math.max(0.1, inertiaResponse));
      lagPos.lerp(tmpPos, alpha);
      lagQuat.slerp(tmpQuat, alpha);
      lagScale.lerp(tmpScale, alpha);
    }
    lagMatrix.compose(lagPos, lagQuat, lagScale);
    invCurrent.copy(cur).invert();
    uniforms.uPrevToCurrent.value.multiplyMatrices(invCurrent, lagMatrix);

    if (cursorOn && hoverRef.current && geometry) {
      raycaster.setFromCamera(ndc, camera);
      if (!raycastMesh.current) {
        raycastMesh.current = new THREE.Mesh(geometry);
        raycastMesh.current.matrixAutoUpdate = false;
      }
      raycastMesh.current.geometry = geometry;
      raycastMesh.current.matrixWorld.copy(meshRef.current.matrixWorld);
      const hits = raycaster.intersectObject(raycastMesh.current, false);
      if (hits.length > 0) {
        // Convert world hit point to mesh-local for the shader.
        const localHit = uniforms.uCursorPosLocal.value.copy(hits[0].point);
        meshRef.current.worldToLocal(localHit);
        uniforms.uCursorOn.value = 1;
      } else {
        uniforms.uCursorOn.value = 0;
      }
    } else {
      uniforms.uCursorOn.value = 0;
    }
  });

  if (!bladeGeom) return null;

  return (
    <mesh
      ref={meshRef}
      geometry={bladeGeom}
      material={material}
      castShadow
      receiveShadow
      frustumCulled={false}
    />
  );
}
