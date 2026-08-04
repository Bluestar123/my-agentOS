/**
 * Agent OS 入口。
 * 当前阶段：连上飞书，收到消息原样回一句（echo bot）。
 */
import 'dotenv/config';
import { startBot } from './im/lark.js';
import { join } from "node:path";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";

const appId = process.env.BOT_A_APP_ID;
const appSecret = process.env.BOT_A_APP_SECRET;

if (!appId || !appSecret) {
    console.error('缺少 BOT_A_APP_ID / BOT_A_APP_SECRET，请检查 .env');
    process.exit(1);
}

console.log('Agent OS 启动，正在建立飞书长连接…');



startBot({
    appId,
    appSecret,
    onMessage: async (msg, bot) => {
        // sender 机器人想 @某个真人，靠的就是它， 例如危险操作拍板
        const resolved = resolveMentions(msg.text, msg.mentions);
        console.log(`  原文: ${msg.text}`);
        console.log(`  还原: ${resolved}`);
        console.log(
            `  mentions: ${msg.mentions.map((m) => `${m.key}=${m.name}(${m.openId})`).join(", ") || "(无)"}`,
        );
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
        console.log(`rootid=${msg.rootId} threadid=${msg.threadId}`)
        // 回复（话题内回复，replyInThread=true）
        const hasThread = !!msg.threadId || !!msg.rootId;
        const replyId = await bot.reply(msg.messageId, `收到：${resolved}`, hasThread);
        console.log(`[已回] message_id=${replyId} inThread=${hasThread}`);


        // await bot.reply(msg.messageId, `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`);

    },
});
