import type { Metadata } from "next";
import { Schibsted_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";

// The same two typefaces as RepoRecon.
const display = Schibsted_Grotesk({
  variable: "--font-display",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SiteRecon: Technical SEO + LLM Search Intelligence",
  description: "Evidence-based audits for AI visibility, technical health and competitive gaps. Deterministic scoring and ready-to-paste fixes.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${jetbrainsMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-ground text-ink font-sans">{children}</body>
    </html>
  );
}
