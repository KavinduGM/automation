/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: { 50: "#f5f3ff", 600: "#6D28D9", 700: "#5b21b6" },
      },
    },
  },
  plugins: [],
};
