module.exports = {
  darkMode: "class",
  content: [
    "./workbench/public/**/*.html",
    "./workbench/public/**/*.js"
  ],
  theme: {
    extend: {
      colors: {
        surface: "#0d0d0d",
        panel: "#161616",
        border: "#2a2a2a",
        accent: "#7c6af7",
        muted: "#6b7280"
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"]
      }
    }
  },
  plugins: []
};