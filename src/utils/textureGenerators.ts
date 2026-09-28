import * as THREE from "three";

/**
 * Generate a brushed metal normal map texture using canvas.
 */
export function createBrushedMetalNormal(
  width = 512,
  height = 512,
  intensity = 0.5,
  direction: "horizontal" | "vertical" = "horizontal"
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  // Fill with neutral normal (128, 128, 255)
  ctx.fillStyle = "rgb(128, 128, 255)";
  ctx.fillRect(0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const scale = intensity * 40;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      // Brushed lines — long streaks in one direction with random perpendicular variation
      const along = direction === "horizontal" ? x : y;
      const across = direction === "horizontal" ? y : x;

      // Multiple frequency noise for natural brush strokes
      const noise1 = Math.sin(across * 0.5 + along * 0.01) * 0.3;
      const noise2 = Math.sin(across * 2.3 + along * 0.005) * 0.2;
      const noise3 = (Math.random() - 0.5) * 0.5;

      const displacement = (noise1 + noise2 + noise3) * scale;

      if (direction === "horizontal") {
        data[i] = 128; // R = X normal (neutral)
        data[i + 1] = Math.max(0, Math.min(255, 128 + displacement)); // G = Y normal
      } else {
        data[i] = Math.max(0, Math.min(255, 128 + displacement)); // R = X normal
        data[i + 1] = 128; // G = Y normal (neutral)
      }
      data[i + 2] = 255; // B = Z normal (pointing out)
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Generate a rough/pitted surface normal map.
 */
export function createRoughNormal(
  width = 512,
  height = 512,
  intensity = 0.5
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "rgb(128, 128, 255)";
  ctx.fillRect(0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const scale = intensity * 60;

  // Generate height map first, then derive normals
  const heightMap = new Float32Array(width * height);
  for (let i = 0; i < heightMap.length; i++) {
    heightMap[i] = Math.random();
  }

  // Simple box blur for smoother bumps
  const blurred = new Float32Array(width * height);
  const radius = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const nx = (x + dx + width) % width;
          const ny = (y + dy + height) % height;
          sum += heightMap[ny * width + nx];
          count++;
        }
      }
      blurred[y * width + x] = sum / count;
    }
  }

  // Derive normals from height map using Sobel
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;

      const left = blurred[y * width + ((x - 1 + width) % width)];
      const right = blurred[y * width + ((x + 1) % width)];
      const up = blurred[((y - 1 + height) % height) * width + x];
      const down = blurred[((y + 1) % height) * width + x];

      data[i] = Math.max(0, Math.min(255, 128 + (left - right) * scale));
      data[i + 1] = Math.max(0, Math.min(255, 128 + (up - down) * scale));
      data[i + 2] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Generate a hammered/dimpled surface normal map.
 */
export function createHammeredNormal(
  width = 512,
  height = 512,
  intensity = 0.5
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "rgb(128, 128, 255)";
  ctx.fillRect(0, 0, width, height);

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;

  const scale = intensity * 80;

  // Create dimples
  const heightMap = new Float32Array(width * height);
  const dimpleCount = 200;

  for (let d = 0; d < dimpleCount; d++) {
    const cx = Math.random() * width;
    const cy = Math.random() * height;
    const r = 8 + Math.random() * 20;
    const depth = 0.3 + Math.random() * 0.7;

    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const wx = ((x % width) + width) % width;
        const wy = ((y % height) + height) % height;
        const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (dist < r) {
          const t = 1 - dist / r;
          heightMap[wy * width + wx] += t * t * depth;
        }
      }
    }
  }

  // Derive normals
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const left = heightMap[y * width + ((x - 1 + width) % width)];
      const right = heightMap[y * width + ((x + 1) % width)];
      const up = heightMap[((y - 1 + height) % height) * width + x];
      const down = heightMap[((y + 1) % height) * width + x];

      data[i] = Math.max(0, Math.min(255, 128 + (left - right) * scale));
      data[i + 1] = Math.max(0, Math.min(255, 128 + (up - down) * scale));
      data[i + 2] = 255;
    }
  }

  ctx.putImageData(imageData, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Derive a tangent-space normal map from an image's luminance. Bright pixels
 * read as raised (crumb tops / highlights), dark pixels as recessed (crevices).
 * A 3x3 box blur smooths out single-pixel JPEG noise before the Sobel pass,
 * otherwise compression speckle would blast through as random pixel bumps.
 */
export function deriveNormalFromImage(
  img: HTMLImageElement,
  intensity = 1,
  maxSize = 1024
): THREE.CanvasTexture {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSize / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * scale));
  const h = Math.max(2, Math.round(ih * scale));

  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sCtx = src.getContext("2d")!;
  sCtx.drawImage(img, 0, 0, w, h);
  const srcData = sCtx.getImageData(0, 0, w, h).data;

  const heights = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = srcData[i * 4];
    const g = srcData[i * 4 + 1];
    const b = srcData[i * 4 + 2];
    heights[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  const blurred = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = (x + dx + w) % w;
          const ny = (y + dy + h) % h;
          sum += heights[ny * w + nx];
        }
      }
      blurred[y * w + x] = sum / 9;
    }
  }

  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const dCtx = dst.getContext("2d")!;
  const nImg = dCtx.createImageData(w, h);
  const nData = nImg.data;
  const nScale = intensity * 600;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const di = (y * w + x) * 4;
      const left = blurred[y * w + ((x - 1 + w) % w)];
      const right = blurred[y * w + ((x + 1) % w)];
      const up = blurred[((y - 1 + h) % h) * w + x];
      const down = blurred[((y + 1) % h) * w + x];
      nData[di] = Math.max(0, Math.min(255, 128 + (left - right) * nScale));
      nData[di + 1] = Math.max(0, Math.min(255, 128 + (up - down) * nScale));
      nData[di + 2] = 255;
      nData[di + 3] = 255;
    }
  }
  dCtx.putImageData(nImg, 0, 0);

  const tex = new THREE.CanvasTexture(dst);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export interface DisplacementField {
  /** Contrast-stretched height values in [0, 1], row-major. */
  heights: Float32Array;
  width: number;
  height: number;
}

/**
 * Build a grayscale displacement field from an image. Returns both the raw
 * height values (for CPU-side geometry deformation) and a CanvasTexture (in
 * case a shader-side sampler is ever re-enabled). A light 3x3 blur smooths
 * out single-pixel spikes from JPEG noise.
 */
export function deriveDisplacementFromImage(
  img: HTMLImageElement,
  maxSize = 1024
): { texture: THREE.CanvasTexture; field: DisplacementField } {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSize / Math.max(iw, ih));
  const w = Math.max(2, Math.round(iw * scale));
  const h = Math.max(2, Math.round(ih * scale));

  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sCtx = src.getContext("2d")!;
  sCtx.drawImage(img, 0, 0, w, h);
  const srcData = sCtx.getImageData(0, 0, w, h).data;

  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = srcData[i * 4];
    const g = srcData[i * 4 + 1];
    const b = srcData[i * 4 + 2];
    lum[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }
  // Heavy blur: the source photo is covered in per-pixel speckle from the
  // crispy breading. Sampled per-vertex that speckle becomes spiky fringe.
  // Ten iterations of a 3x3 box ≈ ~9-pixel Gaussian — washes out the grain
  // but keeps the clump-scale shape that actually makes it read as a nugget.
  const tmp = new Float32Array(w * h);
  let a = lum;
  let b = tmp;
  for (let iter = 0; iter < 10; iter++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            sum += a[((y + dy + h) % h) * w + ((x + dx + w) % w)];
          }
        }
        b[y * w + x] = sum / 9;
      }
    }
    const swap = a;
    a = b;
    b = swap;
  }
  const blurred = a;
  // Percentile-based contrast stretch: trim the top and bottom 2% so a single
  // bright specular hot-pixel or dark crevice doesn't dominate the range and
  // crush everything else into a flat band.
  const sorted = Float32Array.from(blurred).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const hRange = hi - lo || 1;
  for (let i = 0; i < blurred.length; i++) {
    const n = Math.max(0, Math.min(1, (blurred[i] - lo) / hRange));
    // Smoothstep: soften the extremes so peaks round off instead of spiking.
    blurred[i] = n * n * (3 - 2 * n);
  }

  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const dCtx = dst.getContext("2d")!;
  const img2 = dCtx.createImageData(w, h);
  const data = img2.data;
  for (let i = 0; i < w * h; i++) {
    const v = Math.round(blurred[i] * 255);
    data[i * 4] = v;
    data[i * 4 + 1] = v;
    data[i * 4 + 2] = v;
    data[i * 4 + 3] = 255;
  }
  dCtx.putImageData(img2, 0, 0);

  const tex = new THREE.CanvasTexture(dst);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return {
    texture: tex,
    field: { heights: blurred, width: w, height: h },
  };
}

/**
 * Generate a fried-chicken-nugget surface: a clumpy crispy height field that
 * drives both a golden-brown color map and a matching normal map. Returning
 * both from one call lets the diffuse highlights line up exactly with the
 * bumps — no UV drift between color and normal.
 */
export function createNuggetTextures(
  width = 512,
  height = 512,
  intensity = 1
): { colorMap: THREE.CanvasTexture; normalMap: THREE.CanvasTexture } {
  let seed = 0x9e3779b1;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };

  const octave = (cell: number) => {
    const cols = Math.max(2, Math.ceil(width / cell));
    const rows = Math.max(2, Math.ceil(height / cell));
    const grid = new Float32Array(cols * rows);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    return (x: number, y: number) => {
      const fx = (x / cell) % cols;
      const fy = (y / cell) % rows;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const x1 = (x0 + 1) % cols;
      const y1 = (y0 + 1) % rows;
      const a = grid[y0 * cols + x0];
      const b = grid[y0 * cols + x1];
      const c = grid[y1 * cols + x0];
      const d = grid[y1 * cols + x1];
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      return a * (1 - sx) * (1 - sy) + b * sx * (1 - sy) + c * (1 - sx) * sy + d * sx * sy;
    };
  };

  // Three scales of breading variation. The big octave gives broad warm/dark
  // regions across the nugget; the medium adds mid-sized clusters of browning;
  // the small gives fine grain. Values are [-0.5, 0.5]-ish after centering.
  const n1 = octave(80);
  const n2 = octave(26);

  // Stacks of crumbs at three size ranges — fewer big, more small — so the
  // surface reads as mixed chunky + fine craggy bits rather than uniform noise.
  const crumbs = new Float32Array(width * height);
  const addCrumbs = (count: number, rMin: number, rMax: number, peakMin: number, peakMax: number, sharpness: number) => {
    for (let c = 0; c < count; c++) {
      const cx = rand() * width;
      const cy = rand() * height;
      const r = rMin + rand() * (rMax - rMin);
      const ax = 0.55 + rand() * 0.9;
      const ay = 0.55 + rand() * 0.9;
      const rot = rand() * Math.PI;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      const peak = peakMin + rand() * (peakMax - peakMin);
      const rBound = r * Math.max(ax, ay) + 1;
      const ix0 = Math.floor(cx - rBound);
      const ix1 = Math.ceil(cx + rBound);
      const iy0 = Math.floor(cy - rBound);
      const iy1 = Math.ceil(cy + rBound);
      for (let y = iy0; y <= iy1; y++) {
        for (let x = ix0; x <= ix1; x++) {
          const wx = ((x % width) + width) % width;
          const wy = ((y % height) + height) % height;
          const lx = ((x - cx) * cosR + (y - cy) * sinR) / ax;
          const ly = (-(x - cx) * sinR + (y - cy) * cosR) / ay;
          const d = Math.sqrt(lx * lx + ly * ly);
          if (d < r) {
            const t = 1 - d / r;
            crumbs[wy * width + wx] += Math.pow(t, sharpness) * peak;
          }
        }
      }
    }
  };
  // Big chunky cragged bits — the headline shapes.
  addCrumbs(90, 18, 42, 0.7, 1.1, 1.4);
  // Medium crumbs.
  addCrumbs(260, 8, 20, 0.4, 0.8, 1.2);
  // Tiny crispy speckles.
  addCrumbs(1400, 2, 6, 0.25, 0.55, 0.9);

  const heightMap = new Float32Array(width * height);
  let hMin = Infinity;
  let hMax = -Infinity;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      // Crumbs dominate; low-frequency noise just adds lazy wobble.
      const h = 0.18 * n1(x, y) + 0.22 * n2(x, y) + 1.15 * crumbs[i];
      heightMap[i] = h;
      if (h < hMin) hMin = h;
      if (h > hMax) hMax = h;
    }
  }
  const hRange = hMax - hMin || 1;
  for (let i = 0; i < heightMap.length; i++) {
    heightMap[i] = (heightMap[i] - hMin) / hRange;
  }

  // Punchier palette: saturated golds and real browns, with a near-black for
  // the deepest crispy-cracks. No pale batter at the bottom — a nugget is
  // cooked through, not half-raw.
  const palette: Array<[number, [number, number, number]]> = [
    [0.0, [218, 138, 52]],   // golden base
    [0.30, [232, 156, 60]],  // bright gold on flat bumps
    [0.55, [196, 112, 36]],  // amber brown
    [0.78, [130, 62, 18]],   // crispy brown
    [0.92, [72, 32, 10]],    // deep crispy
    [1.0, [28, 12, 4]],      // near-burnt crevice
  ];
  const sample = (t: number): [number, number, number] => {
    for (let k = 1; k < palette.length; k++) {
      if (t <= palette[k][0]) {
        const [ta, ca] = palette[k - 1];
        const [tb, cb] = palette[k];
        const f = (t - ta) / Math.max(1e-6, tb - ta);
        return [
          ca[0] + (cb[0] - ca[0]) * f,
          ca[1] + (cb[1] - ca[1]) * f,
          ca[2] + (cb[2] - ca[2]) * f,
        ];
      }
    }
    return palette[palette.length - 1][1];
  };

  const colorCanvas = document.createElement("canvas");
  colorCanvas.width = width;
  colorCanvas.height = height;
  const cCtx = colorCanvas.getContext("2d")!;
  const cImg = cCtx.createImageData(width, height);
  const cData = cImg.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const di = i * 4;
      const h = heightMap[i];
      // Bias low: most of the surface sits in the golden range; only peaks
      // and crevices hit the extremes. gamma < 1 pulls midtones up.
      const tinted = Math.pow(h, 0.7);
      // Grain jitter — real breading isn't a smooth gradient.
      const jitter = (rand() - 0.5) * 26;
      const [r, g, b] = sample(tinted);
      cData[di] = Math.max(0, Math.min(255, r + jitter));
      cData[di + 1] = Math.max(0, Math.min(255, g + jitter * 0.75));
      cData[di + 2] = Math.max(0, Math.min(255, b + jitter * 0.5));
      cData[di + 3] = 255;
    }
  }
  cCtx.putImageData(cImg, 0, 0);

  const colorMap = new THREE.CanvasTexture(colorCanvas);
  colorMap.wrapS = THREE.RepeatWrapping;
  colorMap.wrapT = THREE.RepeatWrapping;
  colorMap.colorSpace = THREE.SRGBColorSpace;

  const normalCanvas = document.createElement("canvas");
  normalCanvas.width = width;
  normalCanvas.height = height;
  const nCtx = normalCanvas.getContext("2d")!;
  const nImg = nCtx.createImageData(width, height);
  const nData = nImg.data;
  // Much stronger — we want pronounced self-shadowing on crumbs, not a hint.
  const nScale = intensity * 520;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const di = (y * width + x) * 4;
      const left = heightMap[y * width + ((x - 1 + width) % width)];
      const right = heightMap[y * width + ((x + 1) % width)];
      const up = heightMap[((y - 1 + height) % height) * width + x];
      const down = heightMap[((y + 1) % height) * width + x];
      nData[di] = Math.max(0, Math.min(255, 128 + (left - right) * nScale));
      nData[di + 1] = Math.max(0, Math.min(255, 128 + (up - down) * nScale));
      nData[di + 2] = 255;
      nData[di + 3] = 255;
    }
  }
  nCtx.putImageData(nImg, 0, 0);

  const normalMap = new THREE.CanvasTexture(normalCanvas);
  normalMap.wrapS = THREE.RepeatWrapping;
  normalMap.wrapT = THREE.RepeatWrapping;

  return { colorMap, normalMap };
}
