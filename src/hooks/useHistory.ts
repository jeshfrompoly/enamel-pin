"use client";

type Snapshot = Record<string, Record<string, unknown>>;
type Setter = (values: Record<string, unknown>) => void;
type SetterEntry = { setter: Setter; keys: Set<string> };

const STORAGE_KEY = "enamel-pin-settings";
const MAX_HISTORY = 100;

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];
let currentSnapshot: Snapshot = {};
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let isRestoring = false;

// Registry of leva setters by folder name
const setters: Map<string, SetterEntry> = new Map();

const changeListeners = new Set<() => void>();

export function subscribeToSnapshotChange(listener: () => void): () => void {
  changeListeners.add(listener);
  return () => { changeListeners.delete(listener); };
}

export function notifySnapshotChange() {
  if (isRestoring) return;
  changeListeners.forEach((l) => l());
}

function loadSnapshot(): Snapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveSnapshot(snap: Snapshot) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {}
}

function deepClone(obj: Snapshot): Snapshot {
  return JSON.parse(JSON.stringify(obj));
}

export function registerSetter(
  folder: string,
  setter: Setter,
  keys: Iterable<string>
) {
  setters.set(folder, { setter, keys: new Set(keys) });
}

export function unregisterSetter(folder: string) {
  setters.delete(folder);
}

/** Called when any control value changes */
export function recordChange() {
  if (isRestoring) return;

  // Debounce to batch rapid slider drags into one snapshot
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    const newSnapshot = loadSnapshot();

    // Skip if nothing actually changed
    if (JSON.stringify(newSnapshot) === JSON.stringify(currentSnapshot)) return;

    undoStack.push(deepClone(currentSnapshot));
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];
    currentSnapshot = deepClone(newSnapshot);
  }, 300);
}

/** Initialize with current state */
export function initHistory() {
  currentSnapshot = deepClone(loadSnapshot());
  undoStack = [];
  redoStack = [];
}

function applySnapshot(snap: Snapshot) {
  isRestoring = true;
  saveSnapshot(snap);

  for (const [folder, values] of Object.entries(snap)) {
    const entry = setters.get(folder);
    if (!entry) continue;
    // Leva throws if we hand it a key not in the current schema (reads
    // mappedPaths[key].path). Drop stale keys so old snapshots still apply.
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
      if (entry.keys.has(k)) filtered[k] = v;
    }
    entry.setter(filtered);
  }

  // Small delay to let leva process before allowing new recordings
  setTimeout(() => {
    isRestoring = false;
    changeListeners.forEach((l) => l());
  }, 50);
}

export function undo(): boolean {
  if (undoStack.length === 0) return false;

  const prev = undoStack.pop()!;
  redoStack.push(deepClone(currentSnapshot));
  currentSnapshot = deepClone(prev);
  applySnapshot(prev);
  return true;
}

export function redo(): boolean {
  if (redoStack.length === 0) return false;

  const next = redoStack.pop()!;
  undoStack.push(deepClone(currentSnapshot));
  currentSnapshot = deepClone(next);
  applySnapshot(next);
  return true;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Apply a partial settings snapshot (e.g. from a preset), merging with current state */
export function applyPreset(presetSettings: Record<string, Record<string, unknown>>) {
  const current = loadSnapshot();
  // Merge preset over current — only overwrite folders that exist in the preset
  const merged = { ...current };
  for (const [folder, values] of Object.entries(presetSettings)) {
    merged[folder] = { ...current[folder], ...values };
  }
  undoStack.push(deepClone(currentSnapshot));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack = [];
  currentSnapshot = deepClone(merged);
  applySnapshot(merged);
}
