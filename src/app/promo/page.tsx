"use client";

import dynamic from "next/dynamic";

const PromoScene = dynamic(() => import("@/components/PromoScene"), { ssr: false });

export default function Promo() {
  return <PromoScene />;
}
