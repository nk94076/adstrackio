import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef4ff",
          100: "#dbe6fe",
          200: "#bfd3fe",
          300: "#93b4fd",
          400: "#608bfa",
          500: "#3b64f5",
          600: "#2545e9",
          700: "#1e35d3",
          800: "#1f2ea9",
          900: "#1f2c85",
        },
      },
    },
  },
  plugins: [],
};

export default config;
