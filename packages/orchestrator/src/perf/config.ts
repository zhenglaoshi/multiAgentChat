import type { PerfConfig } from './types.js';

/**
 * 从 env 读 perf-platform 对接配置。缺 URL/USER/PASS 任一 → enabled=false（daemon 不启监听）。
 * 敏感账密只在 .env（gitignored）。
 */
export function loadPerfConfig(): PerfConfig {
  const apiUrl = (process.env['PERF_API_URL'] ?? '').replace(/\/+$/, '');
  const user = process.env['PERF_API_USER'] ?? '';
  const pass = process.env['PERF_API_PASS'] ?? '';
  const nick = process.env['PERF_NICK'] ?? '';
  const reposBaseDir = process.env['PERF_REPOS_BASE_DIR'] ?? '';

  const csv = (key: string): string[] =>
    (process.env[key] ?? '').split(',').map((s) => s.trim()).filter(Boolean);

  const targets = csv('PERF_TARGETS'); // 空 = 全部
  const prioritiesRaw = csv('PERF_PRIORITIES');
  const priorities = prioritiesRaw.length ? prioritiesRaw.map((p) => p.toUpperCase()) : ['P0', 'P1'];
  const myRepos = csv('PERF_MY_REPOS'); // 空 = 全部

  const pollMs = (() => {
    const v = Number(process.env['PERF_POLL_MS']);
    return Number.isFinite(v) && v >= 60_000 ? v : 300_000; // 默认 5min，最小 1min
  })();

  return {
    apiUrl,
    user,
    pass,
    nick,
    targets,
    priorities,
    myRepos,
    reposBaseDir,
    pollMs,
    enabled: Boolean(apiUrl && user && pass),
  };
}
