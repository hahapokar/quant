import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // 👇 关键：加上代理（把 /api 请求转发到后端）
      proxy: {
        '/api': {
          target: 'http://localhost:3000',  // 你的后端地址
          changeOrigin: true,
          secure: false,
        },
      },

      // HMR 设置（不用动）
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});