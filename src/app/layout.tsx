import type { Metadata } from "next";
import { Baloo_2, Geist_Mono, Huninn } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

// jf open 粉圓：繁中圓潤可愛字體（不預載以免下載整套 CJK）
const huninn = Huninn({
  variable: "--font-rounded",
  weight: "400",
  preload: false,
});

// 標題與數字用的可愛圓體（拉丁字母）
const baloo = Baloo_2({
  variable: "--font-cute",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "買房前資產規劃",
  description:
    "互動式買房前資產配置與頭期款時間線試算，可選用 Groq AI 診斷規劃。",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="zh-Hant"
      suppressHydrationWarning
      className={`${huninn.variable} ${baloo.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
