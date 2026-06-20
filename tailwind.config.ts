import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        forest: "#0e3b2e",
        "forest-2": "#14513f",
        brand: "#1fa971",
        "brand-2": "#11865a",
        mint: "#dff8ec",
        accent: { DEFAULT: "#f59e0b", soft: "#fff4d8" },
        ink: "#101828",
        muted: "#667085",
        soft: "#98a2b3",
        line: "#e4e7ec",
        "line-strong": "#cfd7e4",
        bg: "#eef3f7",
        surface: "#ffffff",
        "surface-2": "#f8fafc",
        sunken: "#f2f6f8",
        red: { DEFAULT: "#ef4444", soft: "#fff1f1" },
        blue: { DEFAULT: "#2563eb", soft: "#eef4ff" },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "monospace"],
      },
      borderRadius: {
        sm: "10px",
        md: "14px",
        lg: "20px",
        xl: "26px",
      },
      boxShadow: {
        DEFAULT: "0 18px 48px rgba(21,38,64,.10)",
        sm: "0 7px 20px rgba(21,38,64,.07)",
      },
    },
  },
  plugins: [],
};

export default config;
