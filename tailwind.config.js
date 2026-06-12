/** Ported from the inline tailwind.config in templates/index.html.
 * Build: npm run build:css (output committed at static/tailwind.css) */
module.exports = {
  content: ["./templates/**/*.html", "./static/app.js"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        "inverse-primary": "#006e35","tertiary": "#6e9bff","outline-variant": "#484847",
        "on-secondary-container": "#fff6f4","primary-fixed-dim": "#24f07e",
        "on-tertiary-fixed-variant": "#003580","surface": "#0e0e0e","secondary": "#ff7166",
        "surface-variant": "#262626","error": "#ff716c","background": "#0e0e0e",
        "primary-container": "#13ea79","tertiary-container": "#2778fe",
        "on-primary-fixed-variant": "#006832","error-container": "#9f0519","primary": "#3fff8b",
        "on-secondary-fixed-variant": "#a60010","on-error-container": "#ffa8a3",
        "secondary-dim": "#e51a22","surface-container-lowest": "#000000",
        "secondary-container": "#c00014","tertiary-fixed": "#8eafff",
        "on-primary-container": "#004f24","surface-dim": "#0e0e0e",
        "on-secondary-fixed": "#700007","surface-bright": "#2c2c2c","error-dim": "#d7383b",
        "on-surface-variant": "#adaaaa","secondary-fixed-dim": "#ffb0a7",
        "on-surface": "#ffffff","outline": "#767575","primary-dim": "#24f07e",
        "tertiary-dim": "#0f6df3","on-tertiary": "#001d4e","inverse-surface": "#fcf9f8",
        "on-tertiary-fixed": "#00163d","on-error": "#490006","secondary-fixed": "#ffc3bd",
        "surface-container-high": "#201f1f","on-secondary": "#4a0003",
        "on-background": "#ffffff","inverse-on-surface": "#565555","surface-tint": "#3fff8b",
        "primary-fixed": "#3fff8b","tertiary-fixed-dim": "#77a1ff",
        "on-tertiary-container": "#000000","surface-container-low": "#131313",
        "surface-container-highest": "#262626","surface-container": "#1a1919",
        "on-primary": "#005d2c","on-primary-fixed": "#004820"
      },
      fontFamily: { "headline": ["Space Grotesk"],"body": ["Manrope"],"label": ["Space Grotesk"] },
      borderRadius: {"DEFAULT": "0.125rem","lg": "0.25rem","xl": "0.5rem","full": "0.75rem"},
    },
  },
  plugins: [
    require("@tailwindcss/forms"),
    require("@tailwindcss/container-queries"),
  ],
};
