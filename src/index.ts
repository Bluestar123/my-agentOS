/**
 * Agent OS 入口。
 * 当前阶段：连上飞书，收到消息原样回一句（echo bot）。
 */
import 'dotenv/config';
import { startBot, type Bot } from './im/lark.js';
import { join } from "node:path";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { buildTaskCard } from './im/card.js';
import { SessionManager } from "./core/session-manager.js";
import { formatSessionStatus, markSessionIdle, runCardDemo } from './mock/index.js';
import { parseCommand } from "./core/command-parser.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;

if (!appId || !appSecret) {
    console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env');
    process.exit(1);
}

console.log('Agent OS 启动，正在建立飞书长连接…');

const sessions = new SessionManager();

const activeRuns = new Map<string, AbortController>();

startBot({
    appId,
    appSecret,
    onMessage: async (msg, bot) => {
        // sender 机器人想 @某个真人，靠的就是它， 例如危险操作拍板
        const resolved = resolveMentions(msg.text, msg.mentions);
        console.log(`rootid=${msg.rootId} threadid=${msg.threadId}`)
        // 回复（话题内回复，replyInThread=true）
        const hasThread = !!msg.threadId || !!msg.rootId;
        const { session, isNew } = sessions.resolve(msg);


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
            activeRuns.get(session.id)?.abort();
            if (session.status !== 'closed') sessions.transition(session.id, 'closed');
            await bot.reply(
                msg.messageId,
                '当前会话已关闭。需要继续时，请新开一个话题。',
                hasThread,
            );
            return;
        }

        if (session.status === 'closed') {
            await bot.reply(
                msg.messageId,
                '这个话题的会话已经关闭，请新开一个话题继续。',
                hasThread,
            );
            return;
        }
        if (session.status === 'active') {
            await bot.reply(
                msg.messageId,
                '当前会话还在执行，请等任务结束后再追问。',
                hasThread,
            );
            return;
        }

        sessions.transition(session.id, 'active');

        const run = new AbortController();
        activeRuns.set(session.id, run);


        // 获取图片和文件资源
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
            // 失败了，要删除
            if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);

            markSessionIdle(session.id, sessions);
            throw error;
        }

        if (!cardId) {
            console.error("[卡片] 响应里没有 message_id，无法继续更新");
            if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);

            markSessionIdle(session.id, sessions);
            return;
        }

        console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);



        // 让事件回调尽快返回，后续模拟更新在后台继续。
        void runCardDemo(bot, cardId, resolved, run.signal).catch((error) => {
            console.error("[卡片] 演示失败:", (error as Error).message);
        }).finally(() => {
            if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);

            markSessionIdle(session.id, sessions);
        });
        // const replyId = await bot.reply(msg.messageId, `收到：${resolved}`, hasThread);
        // console.log(`[已回] message_id=${replyId} inThread=${hasThread}`);


        // await bot.reply(msg.messageId, `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`);

    },
});
