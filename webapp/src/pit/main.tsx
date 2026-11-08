import React from "react";
import ReactDOM from "react-dom/client";
import "../lib/browser-globals";
import ThePitApp from "./ThePitApp";
import "./pit.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThePitApp />
  </React.StrictMode>
);
