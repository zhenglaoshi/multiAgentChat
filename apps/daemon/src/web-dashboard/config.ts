/**
 * Web dashboard 配置读取。
 *
 * 关键 env：
 *   WEB_DASHBOARD_TOKEN  —— 授权 token，**必须设**才启用。请求要么 URL 带
 *                          `?token=xxx` / `#token=xxx`，要么 Authorization
 *                          `Bearer xxx`。null 就不 attach。
 *   WEB_DASHBOARD_PORT   —— 监听端口，默认 3940（避开企微 :3939）
 *   WEB_DASHBOARD_BIND   —— 监听地址，默认 '0.0.0.0'（Tailscale 场景需要）
 *
 * 安全模型：假定 daemon 只暴露给 Tailscale 私有网络（或本机）。任何情况下
 * 都必须带 token 才能操作。token 泄漏就跟 SSH key 泄漏一样，重新生成。
 */

export interface WebDashboardConfig {
  token: string;
  port: number;
  bind: string;
}

export function loadWebDashboardConfig(): WebDashboardConfig | null {
  const token = process.env['WEB_DASHBOARD_TOKEN'];
  if (!token) return null;
  const port = Number(process.env['WEB_DASHBOARD_PORT'] ?? '3940');
  return {
    token,
    port: Number.isFinite(port) && port > 0 ? port : 3940,
    bind: process.env['WEB_DASHBOARD_BIND'] ?? '0.0.0.0',
  };
}
