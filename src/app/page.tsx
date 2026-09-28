"use client";

import dynamic from "next/dynamic";

const Scene = dynamic(() => import("@/components/Scene"), { ssr: false });

export default function Home() {
  return (
    <div className="w-screen h-screen">
      <Scene />
    </div>
  );
}
