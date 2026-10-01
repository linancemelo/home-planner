import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
// 單檔 HTML 封裝（選用，v1 預設關閉）：
//   npm i -D vite-plugin-singlefile
//   import { viteSingleFile } from "vite-plugin-singlefile"
// 然後把 viteSingleFile() 加進 plugins。偵測管線沒有後端，適合日後收成單一 HTML。

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // viteSingleFile(),
  ],
  server: {
    host: "127.0.0.1",
    port: 43123,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 43123,
    strictPort: true,
  },
})
