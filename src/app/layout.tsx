import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";

const gtAmerica = localFont({
  src: "./fonts/GT-America-VF.woff2",
  variable: "--font-gt-america",
  display: "swap",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Enamel Pin",
  description: "Interactive 3D enamel pin renderer for team, league, and custom logo artwork",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${gtAmerica.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
