import { startLeo } from "./router.js";

try {
  await startLeo();
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons();
  }
} catch (error) {
  console.error("[LEO] Initialization failed:", error);
} 