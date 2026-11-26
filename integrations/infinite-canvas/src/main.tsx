import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { InfiniteCanvasApp } from "./App.js";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <InfiniteCanvasApp />
  </StrictMode>,
);
