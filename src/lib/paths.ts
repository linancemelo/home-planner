/** Prefix app-relative paths with the Next.js basePath (e.g. `/home-planner` on GitHub Pages). */
export function withBasePath(path: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${base}${normalized}`;
}

export function isStaticExport(): boolean {
  return process.env.NEXT_PUBLIC_STATIC_EXPORT === "true";
}
