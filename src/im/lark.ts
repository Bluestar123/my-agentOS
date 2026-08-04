/**
 * 飞书机器人封装
 * 实现方案：WS长连接订阅飞书事件 + REST接口回复消息
 * 优势：无需公网域名、不用配置HTTPS回调地址，本地/内网直接调试机器人
 * 依赖包：@larksuiteoapi/node-sdk
 */
import * as Lark from '@larksuiteoapi/node-sdk';

/**
 * 收到的飞书消息标准化结构
 */
export interface IncomingMessage {
    /** 消息唯一ID，回复消息必须携带此ID */
    messageId: string;
    /** 会话ID：单聊/群聊唯一标识 */
    chatId: string;
    /** 会话类型 p2p=单聊 group=群聊 */
    chatType: 'p2p' | 'group';
    /** 消息类型 text文本 / post富文本 / image图片 等 */
    messageType: string;
    /** 提取之后的纯文本内容，非文本消息为空字符串 */
    text: string;
    /** 发送者open_id，飞书用户唯一标识 */
    senderOpenId: string;
}

/**
 * 机器人启动入参配置
 */
export interface BotOptions {
    /** 飞书开放平台应用 AppID */
    appId: string;
    /** 飞书开放平台应用 AppSecret */
    appSecret: string;
    /**
     * 消息回调函数
     * @param msg 标准化后的消息对象
     * @param bot 机器人实例，内置reply回复方法
     */
    onMessage: (msg: IncomingMessage, bot: Bot) => Promise<void>;
}

/**
 * Bot对外暴露实例类型
 */
export interface Bot {
    /** 飞书原始SDK Client，可自行调用其他飞书接口 */
    client: Lark.Client;
    /**
     * 快捷回复消息
     * @param messageId 原始消息id
     * @param text 需要发送的文本内容
     * @returns 返回新生成的消息ID，发送失败返回undefined
     */
    reply: (messageId: string, text: string) => Promise<string | undefined>;
}

/**
 * 解析飞书消息内容，统一提取纯文本
 * @param messageType 消息类型
 * @param content 飞书原始content字符串（JSON）
 * @returns 提取出的纯文本
 */
function extractText(messageType: string, content: string): string {
    // 解析飞书标准content JSON
    const parsed = JSON.parse(content);

    // 普通文本消息
    if (messageType === 'text') {
        return parsed.text ?? '';
    }

    // Post富文本消息（飞书图文、换行、链接富文本）
    if (messageType === 'post') {
        // post结构：content是二维数组 [[元素1,元素2], [第二行元素]]
        const paragraphs: any[][] = parsed.content ?? [];
        return paragraphs
            .flat() // 二维数组扁平化
            .filter((el) => el.tag === 'text') // 只筛选文本标签
            .map((el) => el.text)
            .join('')
            .trim();
    }

    // image/file/sticker等其他类型消息，暂时返回空文本
    return '';
}

/**
 * 启动飞书机器人（WS长连接模式）
 * @param opts 机器人配置参数
 * @returns Bot实例
 */
export function startBot(opts: BotOptions): Bot {
    const { appId, appSecret, onMessage } = opts;

    // 初始化飞书SDK客户端，用于调用REST API（发消息、获取用户信息等）
    const client = new Lark.Client({ appId, appSecret });

    // 构造对外暴露的Bot实例
    const bot: Bot = {
        client,
        async reply(messageId: string, text: string) {
            try {
                // 调用飞书消息回复接口
                const res = await client.im.v1.message.reply({
                    path: { message_id: messageId },
                    // content必须序列化字符串，飞书接口规范要求
                    data: {
                        msg_type: 'text',
                        content: JSON.stringify({ text }),
                    },
                });
                return res.data?.message_id;
            } catch (err) {
                // 消息发送异常直接返回undefined，上层可捕获处理
                console.error('[飞书] 回复消息失败：', err);
                return undefined;
            }
        },
    };

    // 事件分发器：注册需要监听的飞书事件
    const dispatcher = new Lark.EventDispatcher({}).register({
        /**
         * 核心事件：im.message.receive_v1
         * 机器人收到用户消息触发
         * 注意：飞书后台需要开通【消息与事件接收】权限
         */
        'im.message.receive_v1': async (data) => {
            // data为飞书原始事件载荷
            const m = data.message;

            // 组装标准化消息结构体，屏蔽飞书原始复杂结构
            const msg: IncomingMessage = {
                messageId: m.message_id,
                chatId: m.chat_id,
                chatType: m.chat_type as 'p2p' | 'group',
                messageType: m.message_type,
                text: extractText(m.message_type, m.content),
                senderOpenId: data.sender.sender_id?.open_id ?? '',
            };

            // 执行业务回调逻辑
            await onMessage(msg, bot);
        },
    });

    // 创建WS长连接客户端
    // 原理：主动向外建立websocket长轮询，飞书服务端通过通道推送事件
    // 无需配置请求地址、无需公网，适合本地开发、内网服务
    const wsClient = new Lark.WSClient({ appId, appSecret });
    // 启动长连接，绑定事件分发器
    wsClient.start({ eventDispatcher: dispatcher });

    // 返回bot实例，外部可以保存调用reply/client能力
    return bot;
}