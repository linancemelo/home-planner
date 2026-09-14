import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 允許同網段手機／平板連 dev server，否則 /_next 資源會被封鎖、頁面按不動
  allowedDevOrigins: ["192.168.0.177", "192.168.0.*", "192.168.1.*"],
};

export default nextConfig;
