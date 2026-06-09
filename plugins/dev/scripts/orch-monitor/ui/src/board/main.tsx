import { createRoot } from "react-dom/client";
import "../app.css";
// CTL-881 / FND1: the board is no longer mounted route-less. main.tsx now mounts
// the TanStack Router (AppRouter wraps RouterProvider in StrictMode); the `/`
// route renders the existing <Board /> unchanged, and /ticket/$id + /worker/$id
// become first-class deep-linkable locations. #board-root is kept exactly.
import { AppRouter } from "./router";

createRoot(document.getElementById("board-root")!).render(<AppRouter />);
