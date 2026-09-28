"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Preset } from "@/data/presets";

interface PresetPickerProps {
  presets: Preset[];
  selectedName: string | null;
  onApply: (preset: Preset) => void;
}

export default function PresetPicker({
  presets,
  selectedName,
  onApply,
}: PresetPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelPos, setPanelPos] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelPos({ left: rect.left, top: rect.bottom + 4, width: Math.max(rect.width, 240) });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const inRoot = rootRef.current?.contains(e.target as Node);
      const inPanel = panelRef.current?.contains(e.target as Node);
      if (!inRoot && !inPanel) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const triggerLabel = selectedName ?? "Choose preset…";

  const handleApply = (preset: Preset) => {
    onApply(preset);
    setOpen(false);
  };

  const panel = open && panelPos && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={panelRef}
          style={{
            position: "fixed",
            left: panelPos.left,
            top: panelPos.top,
            width: panelPos.width,
            zIndex: 9999,
          }}
          className="rounded-lg bg-white shadow-[0_8px_24px_-6px_rgba(0,0,0,0.18),0_2px_6px_-2px_rgba(0,0,0,0.08)] border border-black/[0.06] overflow-hidden text-xs max-h-[min(60vh,480px)] overflow-y-auto"
        >
          <div className="py-1">
            {presets.map((preset) => (
              <PresetRow
                key={preset.name}
                preset={preset}
                selected={selectedName === preset.name}
                onApply={handleApply}
              />
            ))}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-2.5 py-1 bg-black/[0.04] hover:bg-black/[0.08] text-black/75 rounded-full text-xs whitespace-nowrap transition-colors border-0 cursor-pointer"
      >
        <span className="truncate">{triggerLabel}</span>
        <svg
          width="10"
          height="6"
          viewBox="0 0 10 6"
          className={`ml-2 shrink-0 opacity-50 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="M0 0l5 6 5-6z" fill="currentColor" />
        </svg>
      </button>
      {panel}
    </div>
  );
}

function PresetRow({
  preset,
  selected,
  onApply,
}: {
  preset: Preset;
  selected: boolean;
  onApply: (p: Preset) => void;
}) {
  return (
    <div
      className={`group flex items-center gap-1 px-3 py-1 cursor-pointer hover:bg-black/[0.04] ${
        selected ? "bg-black/[0.05]" : ""
      }`}
      onClick={() => onApply(preset)}
    >
      <span className={`flex-1 min-w-0 whitespace-nowrap group-hover:truncate ${selected ? "text-black/90 font-medium" : "text-black/75"}`}>
        {preset.name}
      </span>
    </div>
  );
}
