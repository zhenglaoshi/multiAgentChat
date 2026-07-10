import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';
import { logger } from 'multiagent-orchestrator';
import type { CryptoContext } from './crypto.js';
import { decrypt, verifySignature, verifyUrl, encrypt, signResponse } from './crypto.js';

/**
 * 企微事件接收器 —— 内嵌 HTTP server。
 * POST /wecom/event  —— 收消息 / 卡片交互回调
 * GET  /wecom/event  —— 首次 URL 校验（echostr 明文回）
 *
 * 事件从 events emitter 出：
 *   'raw-message'  { xmlPayload, headers } —— 解密后的原始 XML（供上层做具体 parse）
 *   'url-verified' { echostr }
 *   'error'        Error
 *
 * 上层（WeComTransport）负责把 xmlPayload 解析成 IMMessageEvent / IMCardActionEvent。
 */
export class WeComEventServer {
  readonly events = new EventEmitter();
  private server: Server | null = null;

  constructor(
    private readonly ctx: CryptoContext,
    private readonly port: number,
    private readonly path: string = '/wecom/event',
  ) {}

  async start(): Promise<void> {
    return new Promise((resolveP, rejectP) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          logger.warn('wecom event handler crashed', { err: (e as Error).message });
          try { res.statusCode = 500; res.end('error'); } catch { /* ignore */ }
        });
      });
      this.server.once('error', rejectP);
      this.server.listen(this.port, () => {
        logger.info('wecom event server listening', { port: this.port, path: this.path });
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
    const rawUrl = req.url ?? '/';
    if (!rawUrl.startsWith(this.path)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    const qs = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));
    const msg_signature = qs.get('msg_signature') ?? '';
    const timestamp = qs.get('timestamp') ?? '';
    const nonce = qs.get('nonce') ?? '';
    const echostr = qs.get('echostr');

    // GET → URL 校验
    if (req.method === 'GET') {
      if (!echostr) {
        res.statusCode = 400;
        res.end('missing echostr');
        return;
      }
      try {
        const plain = verifyUrl(this.ctx, msg_signature, timestamp, nonce, echostr);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end(plain);
        this.events.emit('url-verified', { echostr, plain });
        logger.info('wecom URL verified', { echostrLen: echostr.length });
      } catch (e) {
        logger.warn('wecom URL verify failed', { err: (e as Error).message });
        res.statusCode = 401;
        res.end('unauthorized');
      }
      return;
    }

    // POST → 事件推送
    if (req.method === 'POST') {
      const body = await readBody(req);
      let encryptField: string | null = null;
      try {
        // 简单 XML 提取 <Encrypt>...</Encrypt>，避免装 xml parser
        const m = /<Encrypt><!\[CDATA\[([\s\S]+?)\]\]><\/Encrypt>|<Encrypt>([^<]+)<\/Encrypt>/.exec(body);
        if (!m) throw new Error('no <Encrypt> in body');
        encryptField = m[1] ?? m[2] ?? null;
        if (!encryptField) throw new Error('empty Encrypt');
        if (!verifySignature(this.ctx, msg_signature, timestamp, nonce, encryptField)) {
          throw new Error('signature mismatch');
        }
        const { plainMsg } = decrypt(this.ctx, encryptField);
        // 立即 200 ack（否则企微会重试）
        res.statusCode = 200;
        res.end('');
        // 事件让上层 async parse
        this.events.emit('raw-message', { xml: plainMsg, timestamp, nonce });
      } catch (e) {
        logger.warn('wecom event POST failed', { err: (e as Error).message });
        res.statusCode = 400;
        res.end('bad request');
      }
      return;
    }

    res.statusCode = 405;
    res.end('method not allowed');
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolveP(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectP);
  });
}

/**
 * 从企微推来的 XML 里 pluck 常用字段（避免装 xml lib）。
 * 支持：MsgType, Event, EventKey, FromUserName, MsgId, Content, ChatId, AgentID
 */
export function pluckXml(xml: string, tag: string): string | undefined {
  const cdata = new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i').exec(xml);
  if (cdata) return cdata[1];
  const plain = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i').exec(xml);
  return plain?.[1];
}

// Re-export helpers up-layer might want to build encrypted response
export { encrypt, signResponse };
