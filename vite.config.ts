import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Tauri 用 renderer Vite 設定。
// `cargo tauri dev` / `cargo tauri build` から参照される。

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  root: resolve(__dirname, 'src/renderer'),
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/types')
    }
  },
  // Tauri は固定ポートを期待
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 5174
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**']
    }
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'chrome120',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // Monaco is intentionally isolated below; app-owned JS stays below 500 kB.
    chunkSizeWarningLimit: 4000,
    // Tauri は WebView2 にローカル配信するので gzip 計測は不要。CI ビルドが目に見えて短縮される。
    reportCompressedSize: false,
    rolldownOptions: {
      checks: {
        // Keep semantic checks enabled, but suppress timing noise from CSS/transpile-heavy builds.
        pluginTimings: false
      },
      input: resolve(__dirname, 'src/renderer/index.html'),
      output: {
        // Issue #110: main chunk が 4.7MB あり起動時間と WebView メモリに響くため、
        // 重い vendor を別 chunk に分離する。Monaco / xyflow / xterm が大物。
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('monaco-editor') || id.includes('@monaco-editor/react')) {
            return 'vendor-monaco';
          }
          if (id.includes('@xyflow/react')) return 'vendor-xyflow';
          if (id.includes('@xterm/')) return 'vendor-xterm';
          if (id.includes('react-dom') || id.includes('scheduler')) {
            return 'vendor-react';
          }
          if (id.includes('@fontsource-variable')) return 'vendor-fonts';
          // marked + dompurify は MarkdownPreview からのみ参照される。
          // 別 chunk に追い出して main chunk から切り離し、再評価コストも局所化する。
          if (id.includes('/marked/') || id.includes('/dompurify/')) {
            return 'vendor-markdown';
          }
          // @tauri-apps/api と plugin-* は多数のモジュールから import される共通基盤。
          // vendor chunk に集約することで個別 chunk への重複コピーを避ける。
          if (id.includes('@tauri-apps/')) return 'vendor-tauri';
          // それ以外は default chunk へ (lucide-react / zustand 等は小さい)
          return undefined;
        }
      }
    }
  }
}));
