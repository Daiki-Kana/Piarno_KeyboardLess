import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { qrcode } from 'vite-plugin-qrcode';

export default defineConfig({
  plugins: [
    basicSsl(),
    qrcode(), // 開発サーバー起動時にターミナルへQRコードを出力
  ],
  server: {
    host: true, // 0.0.0.0 をバインドし、同一LAN内のiOS端末からHTTPSアクセス可能にする
    port: 5173,
    open: false,
  },
});
