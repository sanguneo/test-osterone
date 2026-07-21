import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PrimitiveShowcase } from "./components/PrimitiveShowcase";
import "./styles.css";

if (import.meta.env.DEV) {
	void import("react-grab");
	void import("react-scan");
}

const el = document.getElementById("root");
const showShowcase = import.meta.env.DEV && new URLSearchParams(window.location.search).has("showcase");
if (el) createRoot(el).render(showShowcase ? <PrimitiveShowcase /> : <App />);
