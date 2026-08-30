/** Ported from the inline tailwind.config in templates/index.html.
 * Build: npm run build:css (output committed at static/tailwind.css) */
module.exports = {
  content: ["./templates/**/*.html", "./static/app.js"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Only tokens actually referenced by index.html / app.js are kept.
        // The previous block carried ~50 Material-3 tokens, 31 of them dead.
        "background": "#0e0e0e",
        "on-background": "#ffffff",
        "surface": "#0e0e0e",
        "surface-variant": "#262626",
        "surface-container": "#1a1919",
        "on-surface": "#ffffff",
        "on-surface-variant": "#adaaaa",
        "outline": "#767575",
        "outline-variant": "#484847",
        "primary": "#3fff8b",
        "on-primary": "#005d2c",
        "secondary": "#ff7166",
        "tertiary": "#6e9bff",
        "error": "#ff716c",

        // Semantic availability tokens. This is the domain concept the app
        // reasons about, previously invented ad-hoc at each of 126 call sites.
        "free":    "#3fff8b",
        "soon":    "#f59e0b",
        "busy":    "#ff7166",
        "unknown": "#767575",
      },
      fontFamily: { "headline": ["Space Grotesk"],"body": ["Manrope"],"label": ["Space Grotesk"] },
      fontSize: {
        "display": ["32px", { lineHeight: "1.1",  letterSpacing: "-0.03em", fontWeight: "800" }],
        "title":   ["20px", { lineHeight: "1.25", letterSpacing: "-0.01em", fontWeight: "700" }],
        "body":    ["15px", { lineHeight: "1.6" }],
        "data":    ["18px", { lineHeight: "1.1",  letterSpacing: "-0.01em", fontWeight: "800" }],
        "label":   ["11px", { lineHeight: "1.3",  letterSpacing: "0.08em", fontWeight: "600" }],
      },
      // `full` was 0.75rem, so every rounded-full element rendered as a
      // ~12px blob rather than a circle. The rest of the scale was capped
      // at 8px, which made a soft surface impossible anywhere in the app.
      borderRadius: {
        "sm": "4px",
        "DEFAULT": "6px",
        "lg": "10px",
        "xl": "14px",
        "2xl": "20px",
        "full": "9999px",
      },
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
