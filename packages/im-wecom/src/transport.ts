import { EventEmitter } from 'node:events';
import { logger } from 'multiagent-orchestrator';
import type {
  CardSpec,
  IMCardActionEvent,
  IMMessageEvent,
  IMTransport,
  SendFileOptions,
  SendResult,
  SendTextOptions,
} from 'multiagent-framework';
import { withKindPrefix } from 'multiagent-framework';
import type { WeComConfig } from './config.js';
import { TokenManager } from './auth.js';
import { guessMediaType, sendAppChat, sendAppMessage, uploadMedia, type WeComApiOpts } from './api.js';
import { WeComEventServer, pluckXml } from './event-server.js';
import { decodeButtonKey, renderWeComCard } from './cards.js';

/**
 * WeComTransport · 企微 IM 层，implement IMTransport。
 *
 * 目前实现：文本 / 文件 / 图片 / template_card 发消息；HTTP webhook 事件接收 +
 * 解密 + 事件 emit。patchCard 用 recall + 重发实现（企微 update_template_card
 * 有局限，改 body 只能重发）。
 */
export class WeComTransport implements IMTransport {
  readonly kind = 'wecom' as const;
  readonly events = new EventEmitter();

  private readonly token: TokenManager;
  private readonly eventServer: WeComEventServer;
  private started = false;

  constructor(private readonly cfg: WeComConfig) {
    this.token = new TokenManager(cfg);
    this.eventServer = new WeComEventServer(
      { token: cfg.token, aesKey: cfg.aesKey, corpId: cfg.corpId },
      cfg.callbackHttpPort,
    );
  }

  private get apiOpts(): WeComApiOpts {
    return { cfg: this.cfg, token: this.token };
  }

  async start(): Promise<void> {
    if (this.started) return;
    // 先起 event server（起不来直接抛错，让 daemon 早发现）
    await this.eventServer.start();

    this.eventServer.events.on('raw-message', ({ xml }: { xml: string }) => {
      try {
        this.dispatchRawMessage(xml);
      } catch (e) {
        logger.warn('wecom dispatchRawMessage failed', { err: (e as Error).message });
      }
    });

    // 提前 fetch 一次 token，验证凭证是否 ok（失败 daemon 早知道）
    try {
      await this.token.get();
    } catch (e) {
      logger.warn('wecom access_token 首次拉取失败（凭证可能有误）', {
        err: (e as Error).message,
      });
      // 不 throw —— event server 已起，token 后续用时会重试
    }

    this.started = true;
    logger.info('wecom transport started', {
      corpId: this.cfg.corpId,
      agentId: this.cfg.agentId,
      port: this.cfg.callbackHttpPort,
    });
  }

  async stop(): Promise<void> {
    await this.eventServer.stop();
    this.started = false;
  }

  // ---- 发消息（IMTransport 接口） ----

  async sendText(
    chatId: string,
    text: string,
    _opts?: SendTextOptions,
  ): Promise<SendResult> {
    const target = this.resolveTarget(chatId);
    const content = text.slice(0, 2000);
    if (target.kind === 'chat') {
      await sendAppChat(this.apiOpts, {
        chatid: target.id,
        msgtype: 'text',
        text: { content },
      });
      return { messageId: '' };
    }
    const r = await sendAppMessage(this.apiOpts, {
      touser: target.id,
      msgtype: 'text',
      agentid: Number(this.cfg.agentId),
      text: { content },
    });
    return { messageId: r.msgid, raw: r };
  }

  async sendCard(chatId: string, card: CardSpec): Promise<SendResult> {
    const target = this.resolveTarget(chatId);
    const template = renderWeComCard(card);
    if (target.kind === 'chat') {
      await sendAppChat(this.apiOpts, {
        chatid: target.id,
        msgtype: 'template_card',
        template_card: template,
      });
      return { messageId: '' };
    }
    const r = await sendAppMessage(this.apiOpts, {
      touser: target.id,
      msgtype: 'template_card',
      agentid: Number(this.cfg.agentId),
      template_card: template,
    });
    return { messageId: r.msgid, raw: r };
  }

  async patchCard(_messageId: string, card: CardSpec, chatId?: string): Promise<void> {
    // 企微 update_template_card 只能改按钮 replace_name 之类局部字段；改整卡 body
    // 得撤回重发。为了简单起见我们直接**重发一条新消息**（因为撤回受 24h 限制 +
    // 撤回后原消息位置消失体验也怪）。
    //
    // 上游调用方（notifier）拿新 messageId 更新到 pending.progressMessageId。
    // 由于我们的 IMTransport.patchCard 签名是 void，"重发"这个副作用 daemon 侧
    // 用不到；作为最基础实现暂时空处理，未来优化：暴露 upsertCard(oldId, spec) API。
    if (!chatId) {
      logger.warn('wecom patchCard: chatId missing, skipping');
      return;
    }
    try {
      await this.sendCard(chatId, card);
    } catch (e) {
      logger.warn('wecom patchCard fallback resend failed', { err: (e as Error).message });
    }
  }

  async sendFile(
    chatId: string,
    path: string,
    opts?: SendFileOptions,
  ): Promise<SendResult> {
    const target = this.resolveTarget(chatId);
    const type = guessMediaType(path);
    const options: Parameters<typeof uploadMedia>[3] = opts?.name ?? '';
    const media = await uploadMedia(this.apiOpts, path, type === 'image' ? 'file' : type, options);
    const msgtype = type === 'image' ? 'file' : type;
    if (target.kind === 'chat') {
      await sendAppChat(this.apiOpts, {
        chatid: target.id,
        msgtype,
        [msgtype]: { media_id: media.media_id },
      });
      return { messageId: '' };
    }
    const r = await sendAppMessage(this.apiOpts, {
      touser: target.id,
      msgtype,
      agentid: Number(this.cfg.agentId),
      [msgtype]: { media_id: media.media_id },
    });
    return { messageId: r.msgid, raw: r };
  }

  async sendImage(chatId: string, path: string): Promise<SendResult> {
    const target = this.resolveTarget(chatId);
    const media = await uploadMedia(this.apiOpts, path, 'image');
    if (target.kind === 'chat') {
      await sendAppChat(this.apiOpts, {
        chatid: target.id,
        msgtype: 'image',
        image: { media_id: media.media_id },
      });
      return { messageId: '' };
    }
    const r = await sendAppMessage(this.apiOpts, {
      touser: target.id,
      msgtype: 'image',
      agentid: Number(this.cfg.agentId),
      image: { media_id: media.media_id },
    });
    return { messageId: r.msgid, raw: r };
  }

  // ---- 内部：事件解析 ----

  private dispatchRawMessage(xml: string): void {
    const msgType = pluckXml(xml, 'MsgType');
    const eventType = pluckXml(xml, 'Event');
    const eventKey = pluckXml(xml, 'EventKey');
    const fromUser = pluckXml(xml, 'FromUserName') ?? '';
    const chatIdRaw = pluckXml(xml, 'ChatId');
    const msgId = pluckXml(xml, 'MsgId') ?? '';

    // 群聊 vs 1v1：ChatId 存在 → 群
    const chatId = chatIdRaw
      ? withKindPrefix('wecom', `chat:${chatIdRaw}`)
      : withKindPrefix('wecom', `user:${fromUser}`);

    if (msgType === 'text') {
      const content = pluckXml(xml, 'Content') ?? '';
      const ev: IMMessageEvent = {
        chatId,
        senderId: fromUser,
        text: content,
        messageId: msgId,
        raw: xml,
      };
      this.events.emit('message', ev);
      return;
    }

    if (msgType === 'event') {
      // 卡片交互回调：EventKey 里带 encoded button key，或 SelectedItems 带 vote 结果
      if (eventKey) {
        const value = decodeButtonKey(eventKey);
        const action = String(value['action'] ?? '');
        const ev: IMCardActionEvent = {
          chatId,
          operatorId: fromUser,
          action,
          value,
          originalMessageId: msgId,
          raw: xml,
        };
        this.events.emit('cardAction', ev);
      } else {
        // 其他 event（订阅 / 取消订阅等）—— 暂不处理
        logger.debug('wecom unhandled event', { eventType, fromUser });
      }
      return;
    }

    logger.debug('wecom unhandled msgtype', { msgType, fromUser });
  }

  /**
   * 从 chatId 解析出目标类型和 ID：
   *   'wecom:user:xxx' → { kind: 'user', id: 'xxx' } —— 走 /message/send
   *   'wecom:chat:xxx' → { kind: 'chat', id: 'xxx' } —— 走 /appchat/send（企微应用群）
   *   'wecom:xxx'（无子前缀）→ 视作 user
   *   fallback：WECOM_DEFAULT_TO_USER
   */
  private resolveTarget(chatId: string): { kind: 'user' | 'chat'; id: string } {
    const noPrefix = chatId.startsWith('wecom:') ? chatId.slice('wecom:'.length) : chatId;
    if (noPrefix.startsWith('user:')) {
      return { kind: 'user', id: noPrefix.slice('user:'.length) };
    }
    if (noPrefix.startsWith('chat:')) {
      return { kind: 'chat', id: noPrefix.slice('chat:'.length) };
    }
    if (this.cfg.defaultToUser) {
      return { kind: 'user', id: this.cfg.defaultToUser };
    }
    throw new Error(`wecom: 无法解析 target chatId=${chatId}，设 WECOM_DEFAULT_TO_USER 或用 wecom:user:<userid> / wecom:chat:<chatid>`);
  }
}
