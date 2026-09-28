import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import { BUILT_IN_PRESETS } from "@/data/presets";

const PRESETS_FILE = path.join(process.cwd(), "src/data/custom-presets.json");
const SEEDED_MARKER = path.join(process.cwd(), "src/data/.presets-seeded");

function ensureFile() {
  if (!fs.existsSync(PRESETS_FILE)) {
    fs.writeFileSync(PRESETS_FILE, "[]", "utf-8");
  }
  // One-time seed: merge built-ins into the user's preset file so the unified
  // list isn't empty. Uses a sentinel so re-runs don't resurrect deletions.
  if (!fs.existsSync(SEEDED_MARKER)) {
    const current = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8")) as { name: string }[];
    const have = new Set(current.map((p) => p.name));
    const merged = [...BUILT_IN_PRESETS.filter((p) => !have.has(p.name)), ...current];
    fs.writeFileSync(PRESETS_FILE, JSON.stringify(merged, null, 2), "utf-8");
    fs.writeFileSync(SEEDED_MARKER, new Date().toISOString(), "utf-8");
  }
}

export async function GET() {
  ensureFile();
  const data = fs.readFileSync(PRESETS_FILE, "utf-8");
  return NextResponse.json(JSON.parse(data));
}

export async function POST(req: Request) {
  ensureFile();
  const preset = await req.json();
  const existing = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8"));
  const idx = existing.findIndex((p: { name: string }) => p.name === preset.name);
  if (idx >= 0) existing[idx] = preset;
  else existing.push(preset);
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(existing, null, 2), "utf-8");
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  ensureFile();
  const { name } = await req.json();
  const existing = JSON.parse(fs.readFileSync(PRESETS_FILE, "utf-8"));
  const filtered = existing.filter((p: any) => p.name !== name);
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(filtered, null, 2), "utf-8");
  return NextResponse.json({ ok: true });
}

// Replace the full ordered list. Used by drag-reorder in the UI.
export async function PUT(req: Request) {
  ensureFile();
  const body = await req.json();
  if (!Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "expected array" }, { status: 400 });
  }
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(body, null, 2), "utf-8");
  return NextResponse.json({ ok: true });
}
