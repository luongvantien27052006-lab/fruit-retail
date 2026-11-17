import type { NextConfig } from 'next';

// Khung CP02. Bảo mật header, BFF cookie (ADR-012) thêm ở CP03.
const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
