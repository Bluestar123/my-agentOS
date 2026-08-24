/**
 * 飞书接入：WS 长连接收消息 + REST 回消息。
 *
 * 事件链路：
 * - im.message.receive_v1：用户发消息 → WS 推送 → 标准化为 IncomingMessage → 交给 onMessage
 * - card.action.trigger：用户点击卡片按钮 → WS 推送 → 解析为 CardAction → 交给 onCardAction
 *
 * 回消息方式：
 * - reply / replyCard：回复一条新消息（文本或交互卡片）
 * - updateCard：原地更新已发出的卡片（进度刷新靠它，需要卡片 config.update_multi=true）
 */
import * as Lark from '@larksuiteoapi/node-sdk';
import { mkdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parseMentions, type Mention } from './message-parser.js';
import type { CardJson } from './card.js';

export interface IncomingMessage {
    messageId: string;
    chatId: string;
    chatType: string;
    messageType: string;
    text: string;
    rootId: string;
    threadId: string;
    senderOpenId: string;
    mentions: Mention[];
    rawContent: string;
}

export interface BotOptions {
    appId: string;
    appSecret: string;
    onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
    onCardAction?: (action: CardAction) => Promise<CardActionResponse | undefined>;
}

export interface CardAction {
    /** 点击按钮的飞书用户 open_id（服务端可用它做权限校验） */
    operatorOpenId: string;
    /** 卡片所在消息的 message_id（需要时可用 updateCard 同步刷新这张卡片） */
    messageId: string;
    /** 按钮自定义参数：按钮 behaviors 里声明的 value 原样透传，业务靠它区分动作 */
    value: Record<string, unknown>;
}

export interface CardActionResponse {
    toast?: { type: 'success' | 'info' | 'warning' | 'error'; content: string };
    card?: { type: 'raw'; data: CardJson };
}

/**
 * 解析飞书卡片回调事件（card.action.trigger）：
 * 从原始载荷中提取操作者 open_id、消息 ID 与按钮自定义参数 value。
 * 兼容新旧两种载荷结构（新版在 operator 下，旧版在 operator_id 下），取不到就给空值兜底。
 */
export function parseCardAction(data: any): CardAction {
    const value = data?.action?.value;
    return {
        operatorOpenId: data?.operator?.open_id
            ?? data?.operator_id?.open_id
            ?? '',
        messageId: data?.context?.open_message_id
            ?? data?.open_message_id
            ?? '',
        value: isRecord(value) ? value : {},
    };
}

export interface Bot {
    client: Lark.Client;
    reply: (messageId: string, text: string, replyInThread?: boolean) => Promise<string | undefined>;
    replyCard: (messageId: string, card: CardJson, replyInThread?: boolean) => Promise<string | undefined>;
    updateCard: (messageId: string, card: CardJson) => Promise<void>;
    downloadResource: (
        messageId: string,
        fileKey: string,
        type: 'image' | 'file',
        saveDir: string,
        fileName?: string,
    ) => Promise<string>;
}

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
};

function getHeader(headers: any, name: string): string {
    const value = typeof headers?.get === 'function'
        ? headers.get(name)
        : headers?.[name] ?? headers?.[name.toLowerCase()];
    return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function resourceExtension(type: 'image' | 'file', fileName: string | undefined, contentType: string): string {
    const original = fileName ? extname(fileName).slice(1).toLowerCase() : '';
    if (/^[a-z0-9]{1,10}$/.test(original)) return original;

    const mime = contentType.split(';', 1)[0].trim().toLowerCase();
    return CONTENT_TYPE_EXTENSIONS[mime] ?? (type === 'image' ? 'img' : 'bin');
}

interface PostElement {
    tag?: string;
    text?: string;
    user_id?: string;
}

// 富文本每个段落处理
function renderPostElement(element: PostElement): string {
    if (element.tag === 'at') return element.user_id ?? '';
    if (element.tag === 'br') return '\n';
    if (['text', 'a', 'code', 'code_block', 'md'].includes(element.tag ?? '')) {
        return element.text ?? '';
    }
    return '';
}

/** 从消息 JSON 内容中提取纯文本：text 直接取，post 富文本把各段落元素拼接成文本 */
export function extractMessageText(messageType: string, content: string): string {
    const parsed = JSON.parse(content);
    if (messageType === 'text') {
        return parsed.text ?? '';
    }
    if (messageType === 'post') {
        const paragraphs: PostElement[][] = parsed.content ?? [];
        return paragraphs
            .map((paragraph) => paragraph.map(renderPostElement).join(''))
            .filter(Boolean)
            .join('\n')
            .trim();
    }
    return '';
}

export function startBot(opts: BotOptions): Bot {
    const { appId, appSecret, onMessage, onCardAction } = opts;

    const client = new Lark.Client({ appId, appSecret });

    const bot: Bot = {
        client,

        // 回复一条纯文本消息；replyInThread=true 时作为话题内回复发出
        async reply(messageId, text, replyInThread = false) {
            const res = await client.im.v1.message.reply({
                path: { message_id: messageId },
                data: {
                    msg_type: 'text',
                    content: JSON.stringify({ text }),
                    ...(replyInThread ? { reply_in_thread: true } : {}),
                },
            });
            return res.data?.message_id;
        },

        // 回复一张交互卡片（msg_type=interactive），返回新卡片的 message_id 供后续 updateCard
        async replyCard(messageId, card, replyInThread = false) {
            const res = await client.im.v1.message.reply({
                path: { message_id: messageId },
                data: {
                    msg_type: 'interactive', // 交互卡片
                    content: JSON.stringify(card),
                    ...(replyInThread ? { reply_in_thread: true } : {}),
                },
            });
            return res.data?.message_id;
        },

        // 原地更新已发出的卡片（不产生新消息），进度刷新 / 最终收尾都走这里
        async updateCard(messageId, card) {
            await client.im.v1.message.patch({
                path: { message_id: messageId },
                data: { content: JSON.stringify(card) },
            });
        },

        // 下载消息中的图片 / 文件资源，按文件扩展名或 Content-Type 推断后缀并落盘，返回保存路径
        async downloadResource(messageId, fileKey, type, saveDir, fileName) {
            const res = await client.im.v1.messageResource.get({
                path: { message_id: messageId, file_key: fileKey },
                params: { type },
            });
            const contentType = getHeader(res.headers, 'content-type');
            const extension = resourceExtension(type, fileName, contentType);
            const savePath = join(saveDir, `${fileKey}.${extension}`);
            await mkdir(saveDir, { recursive: true });
            await res.writeFile(savePath);
            return savePath;
        },
    };

    const dispatcher = new Lark.EventDispatcher({}).register({
        // 卡片按钮点击事件：解析成 CardAction 后交给业务回调；
        // 返回值中的 toast / card 会由飞书 SDK 回写（如「已发送停止指令」的提示条）
        'card.action.trigger': async (data: any) => {
            if (!onCardAction) return undefined;
            return onCardAction(parseCardAction(data));
        },
        // 收到用户消息：标准化为 IncomingMessage 后交给业务回调
        'im.message.receive_v1': async (data) => {
            const m = data.message;
            const msg: IncomingMessage = {
                messageId: m.message_id,
                chatId: m.chat_id,
                chatType: m.chat_type,
                messageType: m.message_type,
                text: extractMessageText(m.message_type, m.content),
                rootId: m.root_id ?? '',
                threadId: m.thread_id ?? '',
                senderOpenId: data.sender.sender_id?.open_id ?? '',
                mentions: parseMentions(m.mentions),
                rawContent: m.content,
            };
            await onMessage(msg, bot);
        },
    });

    const wsClient = new Lark.WSClient({ appId, appSecret });
    wsClient.start({ eventDispatcher: dispatcher });

    return bot;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
