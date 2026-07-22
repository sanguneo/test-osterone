import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

if (import.meta.env.DEV) {
	void import("react-grab");
	void import("react-scan");
}

const el = document.getElementById("root");
if (el) createRoot(el).render(<App />);
