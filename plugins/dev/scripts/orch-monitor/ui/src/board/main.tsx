import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app.css";
import { Board } from "./Board";

createRoot(document.getElementById("board-root")!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
);
