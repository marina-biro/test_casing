import "./storageShim.js"; // mora pre komponente
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import QATestCaseTool from "./QATestCaseTool.jsx";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <QATestCaseTool />
  </React.StrictMode>
);
