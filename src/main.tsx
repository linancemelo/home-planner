import { createRoot } from "react-dom/client"
import "@fontsource/noto-sans-tc/400.css"
import "@fontsource/noto-sans-tc/500.css"
import "@fontsource/noto-sans-tc/700.css"
import "./studio/theme/studio.css"
import { App } from "./App"

createRoot(document.getElementById("root")!).render(<App />)
