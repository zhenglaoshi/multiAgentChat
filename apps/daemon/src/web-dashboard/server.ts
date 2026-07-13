import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { logger } from 'multiagent-orchestrator';
import {
  captureScreen,
  getHistory,
  listTabs,
  send as terminalSend,
  sendKeys,
  forceEnter,
} from 'multiagent-host-mac';
import { pendingTracker, handleCommand } from 'multiagent-im-lark';
import type { WebDashboardConfig } from './config.js';
import { DASHBOARD_HTML } from './html.js';

/**
 * Web dashboard —— 简单 REST + SSE，配合 SPA。
 *
 * 路由：
 *   GET  /                         → HTML 单页
 *   GET  /api/tabs                 → { tabs: TerminalTab[] }
 *   GET  /api/pending              → { pending: PendingOutput[] }
 *   GET  /api/history?tty=X&lines=N → { text, totalLines }
 *   POST /api/send  {tty,text}     → 派命令到 tab
 *   POST /api/keys  {tty,sequence} → 发按键
 *   POST /api/screen {tty}         → { dataUrl: 'data:image/png;base64,…' }
 *   POST /api/exec  {text}         → 走 mchat handleCommand（只处理 text-kind）
 *   GET  /api/events               → SSE（pending/tabs 事件）
 *
 * 认证：Authorization: Bearer <token>；或 query ?token= 或 hash #token=（HTML 侧读）
 */
export class WebDashboardServer {
  private server: Server | null = null;

  constructor(private readonly cfg: WebDashboardConfig) {}

  async start(): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          logger.warn('web-dashboard handler crashed', { err: (e as Error).message });
          try {
            res.statusCode = 500;
            res.end('error');
          } catch {
            /* ignore */
          }
        });
      });
      this.server.once('error', rejectP);
      this.server.listen(this.cfg.port, this.cfg.bind, () => {
        logger.info('web-dashboard listening', {
          bind: this.cfg.bind,
          port: this.cfg.port,
          tokenPreview: this.cfg.token.slice(0, 4) + '…',
        });
        resolveP();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolveP) => {
      this.server!.close(() => resolveP());
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // GET / → HTML（HTML 里再自己带 token 打 API）
    if (path === '/' && req.method === 'GET') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(DASHBOARD_HTML);
      return;
    }

    // 其他都要 auth
    if (!this.checkAuth(req, url)) {
      res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized (missing/invalid token)' }));
      return;
    }

    // 路由
    try {
      if (path === '/api/tabs' && req.method === 'GET') {
        const tabs = await listTabs();
        return sendJson(res, { tabs });
      }
      if (path === '/api/pending' && req.method === 'GET') {
        return sendJson(res, { pending: pendingTracker.all() });
      }
      if (path === '/api/history' && req.method === 'GET') {
        const tty = url.searchParams.get('tty');
        const lines = Number(url.searchParams.get('lines') ?? '60');
        if (!tty) return sendJson(res, { error: 'missing tty' }, 400);
        const full = await getHistory(tty);
        const arr = full.split('\n');
        const tail = arr.slice(-lines).join('\n');
        return sendJson(res, { text: tail, totalLines: arr.length });
      }
      if (path === '/api/send' && req.method === 'POST') {
        const body = await readJson(req);
        const tty = body.tty as string;
        const text = body.text as string;
        if (!tty || !text) return sendJson(res, { error: 'missing tty/text' }, 400);
        const result = await terminalSend(tty, text);
        // TUI (claude) 要 forceEnter
        const tabs = await listTabs();
        const tab = tabs.find((t) => t.tty === tty);
        if (result.ok && tab?.hasTUI) {
          await new Promise((r) => setTimeout(r, 400));
          await forceEnter(tty);
        }
        return sendJson(res, { ok: result.ok, reason: result.reason });
      }
      if (path === '/api/keys' && req.method === 'POST') {
        const body = await readJson(req);
        const tty = body.tty as string;
        const sequence = body.sequence as string;
        if (!tty || !sequence) return sendJson(res, { error: 'missing tty/sequence' }, 400);
        await sendKeys(tty, sequence);
        return sendJson(res, { ok: true });
      }
      if (path === '/api/screen' && req.method === 'POST') {
        const body = await readJson(req);
        const tty = body.tty as string;
        if (!tty) return sendJson(res, { error: 'missing tty' }, 400);
        const rawWidth = body.width as number | undefined;
        const targetWidth = typeof rawWidth === 'number' && rawWidth >= 400 && rawWidth <= 2400
          ? rawWidth
          : 1200;   // 默认 1200px 宽度 —— Retina 全窗口 13MB → 降到 100-400KB
        const pngPath = await captureScreen(tty);
        // sips 降采样 + 转 JPEG（RGB 无 alpha，体积再降 2-4x，手机 4G 秒开）
        const jpgPath = pngPath.replace(/\.png$/i, '.jpg');
        await runSipsResize(pngPath, jpgPath, targetWidth);
        const buf = await readFile(jpgPath);
        const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
        return sendJson(res, { dataUrl, path: jpgPath, bytes: buf.length, width: targetWidth });
      }
      if (path === '/api/exec' && req.method === 'POST') {
        const body = await readJson(req);
        const text = body.text as string;
        const chatId = (body.chatId as string) || 'web-dashboard';
        if (!text) return sendJson(res, { error: 'missing text' }, 400);
        const action = await handleCommand(chatId, text);
        if (action.kind === 'text') return sendJson(res, { kind: 'text', text: action.text });
        if (action.kind === 'card') {
          return sendJson(res, {
            kind: 'card',
            text: '（此命令返回卡片，web dashboard 暂不 render。可在飞书里执行看卡）',
          });
        }
        return sendJson(res, { kind: action.kind, text: '(non-text ReplyAction)' });
      }
      if (path === '/api/events' && req.method === 'GET') {
        return this.handleSse(req, res);
      }
      res.statusCode = 404;
      res.end('not found');
    } catch (e) {
      const msg = (e as Error).message;
      logger.warn('web-dashboard route err', { path, err: msg });
      sendJson(res, { error: msg }, 500);
    }
  }

  private checkAuth(req: IncomingMessage, url: URL): boolean {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string') {
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      if (m && m[1] === this.cfg.token) return true;
    }
    const q = url.searchParams.get('token');
    if (q && q === this.cfg.token) return true;
    return false;
  }

  private handleSse(_req: IncomingMessage, res: ServerResponse): void {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.setHeader('connection', 'keep-alive');
    res.write('retry: 3000\n\n');

    // 每 3s 发一次 tabs / pending 变化提示（简化：不精细，只广播）
    // 更好的做法是接 watcher.events；这里 MVP 先走 tick
    const timer = setInterval(() => {
      try {
        res.write('event: pending\ndata: ping\n\n');
      } catch {
        /* client closed */
      }
    }, 3000);
    const closer = () => {
      clearInterval(timer);
      try { res.end(); } catch { /* ignore */ }
    };
    _req.on('close', closer);
    _req.on('aborted', closer);
  }
}

function sendJson(res: ServerResponse, obj: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
}

/**
 * 用 macOS 内建 sips 把 PNG 降采样成 JPEG（宽度 targetWidth，压缩率 75%）。
 * Retina 全窗口 png 13MB → jpg 100-400KB，手机 4G 秒开。
 */
function runSipsResize(srcPng: string, outJpg: string, targetWidth: number): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const p = spawn('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', '75',
      '--resampleWidth', String(targetWidth),
      srcPng,
      '--out', outJpg,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    p.on('error', rejectP);
    p.on('close', (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`sips exit ${code}: ${stderr}`));
    });
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}
