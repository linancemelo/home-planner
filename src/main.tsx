import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/noto-sans-tc/400.css"
import "@fontsource/noto-sans-tc/500.css"
import "@fontsource/noto-sans-tc/700.css"
import "./index.css"
import App from "./App.tsx"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
