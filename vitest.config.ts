import { defineConfig } from 'vitest/config';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * 源码用 NodeNext 风格的 `.js` 相对 import（如 `./applescript.js`），实际文件是 `.ts`。
 * tsx 运行时透明解析；vitest(vite/esbuild) 默认不重写 → 加个 pre 插件把存在的 `.ts` 补上。
 * 这样测试能直接 import 包源码（包 exports 也都指向 src/*.ts）。
 */
const jsToTs = {
  name: 'js-to-ts-resolve',
  enforce: 'pre' as const,
  resolveId(source: string, importer: string | undefined) {
    if (importer && source.startsWith('.') && source.endsWith('.js')) {
      const tsPath = resolve(dirname(importer), source.slice(0, -3) + '.ts');
      if (existsSync(tsPath)) return tsPath;
    }
    return null;
  },
};

export default defineConfig({
  plugins: [jsToTs],
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
