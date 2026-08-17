/**
 * Agent OS 入口（主进程）。
 *
 * 启动流程：
 * 1. 加载 .env 中的飞书应用凭证
 * 2. 恢复本地会话（data/sessions.json → 内存 Map）
 * 3. 建立飞书 WS 长连接，订阅消息事件
 *
 * 消息处理（onMessage）：
 * 还原 @提及 → 定位/新建会话 → 命令分发（/help /status /close）
 * → 会话状态拦截 → 置为 active → 下载图片/文件 → 发任务卡片
 * → 后台模拟执行任务（进度刷新卡片）→ 收尾置为 idle。
 *
 * 当前阶段：连上飞书，收到消息后以"模拟任务"方式回复一张进度卡片（demo bot）。
 */
import 'dotenv/config';
import { startBot, type Bot } from './im/lark.js';
import { join } from "node:path";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { buildTaskCard } from './im/card.js';
import { SessionManager } from "./core/session-manager.js";
import { formatSessionStatus, markSessionIdle, runCardDemo } from './mock/index.js';
import { parseCommand } from "./core/command-parser.js";
import { JsonSessionStore } from "./core/session-store.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;

if (!appId || !appSecret) {
    console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env');
    process.exit(1);
}

console.log('Agent OS 启动，正在建立飞书长连接…');

// 恢复历史会话：重启后能接着上次的话题继续对话
const sessions = await SessionManager.open({
    store: new JsonSessionStore(join("data", "sessions.json")),
});
console.log(`[会话] 已恢复 ${sessions.size} 个会话`);

// 正在执行的任务表：sessionId → AbortController，供 /close 命令中止后台任务
const activeRuns = new Map<string, AbortController>();

startBot({
    appId,
    appSecret,
    onMessage: async (msg, bot) => {
        // 还原 @占位符：把 "@_user_1" 换成 "@显示名"；
        // 将来 bot 想 @某个真人（例如危险操作需要真人拍板）时，靠 mentions 定位真实 open_id
        // eg @小助手，查看现在有什么任务
        const resolved = resolveMentions(msg.text, msg.mentions);
        console.log(`rootid=${msg.rootId} threadid=${msg.threadId}`)
        // 是否在话题内：有 threadId 或 rootId 就算（决定回复是否进入话题）
        const hasThread = !!msg.threadId || !!msg.rootId;
        // 定位会话：同一话题复用旧会话；新话题创建新会话（首次会落盘，status=creating）
        const { session, isNew } = await sessions.resolve(msg);


        console.log(
            `[收到] chat=${msg.chatId} threadId=${msg.threadId} rootId=${msg.rootId} sender=${msg.senderOpenId}`,
        );
        console.log(`  原文: ${msg.text}`);
        console.log(`  还原: ${resolved}`);
        console.log(
            `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`,
        );
        console.log(
            `  [会话] ${isNew ? "新建" : "复用"} id=${session.id} status=${session.status}`,
        );

        // ── 命令分发：/help /status /close 直接处理，不进入任务流程 ──
        const command = parseCommand(resolved);
        if (command?.name === 'help') {
            await bot.reply(
                msg.messageId,
                ['/status 查看当前会话', '/close 关闭当前会话', '/help 查看命令'].join('\n'),
                hasThread,
            );
            return;
        }
        if (command?.name === 'status') {
            await bot.reply(msg.messageId, formatSessionStatus(session), hasThread);
            return;
        }
        if (command?.name === 'close') {
            // 中止该会话正在跑的后台任务（runCardDemo 的 wait 会立即退出）
            activeRuns.get(session.id)?.abort();
            if (session.status !== 'closed') {
                await sessions.transition(session.id, 'closed')
            }
            await bot.reply(
                msg.messageId,
                '当前会话已关闭。需要继续时，请新开一个话题。',
                hasThread,
            );
            return;
        }

        // ── 会话状态拦截（非命令消息） ──
        if (session.status === 'closed') {
            // 已关闭话题：拒收新消息
            await bot.reply(
                msg.messageId,
                '这个话题的会话已经关闭，请新开一个话题继续。',
                hasThread,
            );
            return;
        }
        // 首次写盘期间的保护：刚建完会话紧接着又收到同话题消息（如并发/重试），等写盘完成
        if (!isNew && session.status === 'creating') {
            await bot.reply(
                msg.messageId,
                '当前会话正在准备，请稍后再追问。',
                hasThread,
            );
            return;
        }
        if (session.status === 'active') {
            // 任务执行中：同一话题的追问会被拒绝，保证一个话题同时只跑一个任务
            await bot.reply(
                msg.messageId,
                '当前会话还在执行，请等任务结束后再追问。',
                hasThread,
            );
            return;
        }

        // ── 进入执行流程：状态机 idle → active（落盘） ──
        await sessions.transition(session.id, 'active');

        // 登记中止句柄：/close 命令可中止本次后台任务
        const run = new AbortController();
        activeRuns.set(session.id, run);


        // 获取并下载图片/文件资源到 data/downloads/（image_key / file_key）
        const resources = extractResourceKeys(msg.messageType, msg.rawContent);
        for (const res of resources) {
            const savePath = await bot.downloadResource(
                msg.messageId,
                res.key,
                res.type,
                join("data", "downloads"),
                res.fileName,
            );
            console.log(`  [下载] ${res.type} → ${savePath}`);
        }


        // 先发一张"运行中"占位卡片，后续所有进度更新都基于这张卡片的 message_id
        let cardId: string | undefined;
        try {
            cardId = await bot.replyCard(
                msg.messageId,
                buildTaskCard({
                    title: "Agent OS 模拟任务",
                    status: "running",
                    progress: 0,
                    detail: "正在准备任务环境",
                }),
                hasThread,
            );
        } catch (error) {
            // 发卡片失败：任务无法继续，清理运行句柄并让会话回到 idle
            if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);
            // 改成 idle，后面可以继续
            await markSessionIdle(session.id, sessions);
            throw error;
        }

        if (!cardId) {
            // 飞书响应里没有 message_id：同样无法更新卡片，收尾退出
            console.error("[卡片] 响应里没有 message_id，无法继续更新");
            if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);

            await markSessionIdle(session.id, sessions);
            return;
        }

        console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);



        // 后台模拟执行：让事件回调尽快返回（否则飞书长连接会排队积压），
        // 进度通过 updateCard 持续刷新卡片；finally 里统一收尾。
        void runCardDemo(bot, cardId, resolved, run.signal).catch((error) => {
            console.error("[卡片] 演示失败:", (error as Error).message);
        }).finally(async () => {
            // 任务结束：无论成功/失败/中止，都摘除运行句柄，会话回到 idle
            // 如果需要继续对话，上面会重新设置
            if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);

            try {
                await markSessionIdle(session.id, sessions);
            } catch (error) {
                console.error('[会话] 保存空闲状态失败:', (error as Error).message);
            }
        });
        // const replyId = await bot.reply(msg.messageId, `收到：${resolved}`, hasThread);
        // console.log(`[已回] message_id=${replyId} inThread=${hasThread}`);


        // await bot.reply(msg.messageId, `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`);

    },
});
