import React from "react";
import { createRoot } from "react-dom/client";
import { GuideApp } from "./GuideApp";
import { ThemeProvider } from "../theme/ThemeProvider";
import "../design-system.css";
import "../styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("가이드 창의 #root 가 없습니다.");
}

createRoot(root).render(
  <React.StrictMode>
    <ThemeProvider>
      <GuideApp />
    </ThemeProvider>
  </React.StrictMode>,
);
