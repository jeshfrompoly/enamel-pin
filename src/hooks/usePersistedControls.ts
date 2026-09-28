"use client";

import { useControls } from "leva";
import { useEffect, useRef } from "react";
import { registerSetter, unregisterSetter, recordChange, notifySnapshotChange } from "./useHistory";

const STORAGE_KEY = "enamel-pin-settings";

function loadAll(): Record<string, Record<string, unknown>> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveAll(data: Record<string, Record<string, unknown>>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

/**
 * Drop-in replacement for leva's useControls that persists values to localStorage
 * and integrates with the undo/redo history system.
 */
export function usePersistedControls<T extends Record<string, unknown>>(
  folder: string,
  schema: T
) {
  // Patch schema defaults from localStorage before passing to leva
  const stored = loadAll();
  const saved = stored[folder] as Record<string, unknown> | undefined;

  const patchedSchema = { ...schema } as Record<string, unknown>;
  if (saved) {
    for (const key of Object.keys(patchedSchema)) {
      if (saved[key] !== undefined) {
        const field = patchedSchema[key];
        if (typeof field === "object" && field !== null && "value" in field) {
          let val = saved[key];
          // Clamp saved value to current min/max range
          const f = field as Record<string, unknown>;
          if (typeof val === "number" && typeof f.min === "number" && typeof f.max === "number") {
            val = Math.max(f.min, Math.min(f.max, val));
          }
          patchedSchema[key] = { ...field, value: val };
        } else if (typeof field === "boolean" || typeof field === "string" || typeof field === "number") {
          patchedSchema[key] = saved[key];
        }
      }
    }
  }

  const [values, set] = useControls(folder, () => patchedSchema as any, []);

  // Register setter for undo/redo system
  const schemaKeys = Object.keys(schema);
  useEffect(() => {
    registerSetter(folder, set, schemaKeys);
    return () => unregisterSetter(folder);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, set, schemaKeys.join("|")]);

  // Save to localStorage whenever values change and record for undo
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    const all = loadAll();
    all[folder] = { ...valuesRef.current };
    saveAll(all);
    recordChange();
    notifySnapshotChange();
  }, [folder, values]);

  return [values, set] as const;
}
