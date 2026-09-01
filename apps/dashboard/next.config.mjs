/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Next's dev-mode "building..." badge floats bottom-left, which
  // overlaps the app shell's own bottom-left "Sign out" control at
  // common viewport sizes and swallows clicks meant for it. Disabling
  // both indicators here only affects local development, not production.
  devIndicators: {
    buildActivity: false,
    appIsrStatus: false,
  },
};

export default nextConfig;
