import type { NextConfig } from "next";

const isGithubPages = process.env.GITHUB_PAGES === "true";
const basePath = isGithubPages ? "/home-planner" : "";

const nextConfig: NextConfig = {
  // 允許同網段手機／平板連 dev server，否則 /_next 資源會被封鎖、頁面按不動
  allowedDevOrigins: ["192.168.0.177", "192.168.0.*", "192.168.1.*"],
  ...(isGithubPages
    ? {
        output: "export" as const,
        basePath,
        assetPrefix: basePath,
        trailingSlash: true,
        images: { unoptimized: true },
      }
    : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_STATIC_EXPORT: isGithubPages ? "true" : "",
  },
};

export default nextConfig;
