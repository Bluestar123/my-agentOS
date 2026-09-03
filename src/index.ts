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
import { join, resolve } from "node:path";
import { resolveMentions, extractResourceKeys } from "./im/message-parser.js";
import { answerContinuation, answerNeedsContinuation, buildTaskCard, splitLongText, ThrottledCardUpdater } from './im/card.js';
import { SessionManager } from "./core/session-manager.js";
import { formatSessionStatus, markSessionIdle } from './mock/index.js';
import { parseCommand, parseCliRequest } from "./core/command-parser.js";
import { getCliAdapter, listCliAdapters } from "./cli/registry.js";
import { JsonSessionStore } from "./core/session-store.js";
import { TaskProgressTracker } from "./core/task-progress.js";
import { runCli } from "./cli/runner.js";
import { requestTaskAbort, type ActiveRun } from "./core/task-abort.js";
import { CliAdapter } from './cli/types.js';
import {
    buildBotPrompt,
    loadBotConfigs,
    type BotConfig,
} from "./core/bot-registry.js";

// 默认 agentos 目录
const cliWorkdir = resolve(
    process.env.CLI_WORKDIR ?? process.env.CLAUDE_WORKDIR ?? process.cwd(),
);


const botConfigPath = resolve(
    process.env.BOTS_CONFIG ?? join("config", "bots.json"),
);
const botConfigs = await loadBotConfigs(botConfigPath);

// 恢复历史会话：重启后能接着上次的话题继续对话
const sessions = await SessionManager.open({
    store: new JsonSessionStore(join("data", "sessions.json"), botConfigs[0]?.id),
});

// 正在执行的任务表：sessionId → AbortController，供 /close 命令中止后台任务
const activeRuns = new Map<string, ActiveRun>();
const contextWindows = new Map<string, number>();


console.log("Agent OS 启动，正在建立飞书长连接…");
console.log(
    `[配置] 已注册 ${botConfigs.length} 个 bot，已恢复 ${sessions.size} 个会话`,
);
for (const adapter of listCliAdapters()) {
    console.log(
        `[CLI] id=${adapter.id} command=${adapter.command} cwd=${cliWorkdir}`,
    );
}
for (const config of botConfigs) {
    console.log(
        `[Bot ${config.id.toUpperCase()}] default_cli=${config.defaultCliId}`,
    );
}


function executeCli(
    adapter: CliAdapter,
    prompt: string,
    sessionId: string | undefined,
    signal: AbortSignal,
    onEvent: Parameters<typeof runCli>[0]["onEvent"],
) {
    return runCli({
        adapter,
        prompt,
        cwd: cliWorkdir,
        signal,
        sessionId,
        onEvent
    });
}
async function startConfiguredBot(config: BotConfig): Promise<void> {
    startBot({
        appId: config.appId,
        appSecret: config.appSecret,
        onCardAction: async (action) => {
            if (action.value.action !== "abort_task") return undefined;
            const sessionId =
                typeof action.value.sessionId === "string" ? action.value.sessionId : "";
            const outcome = requestTaskAbort(
                activeRuns,
                sessionId,
                action.operatorOpenId,
            );
            if (outcome === "not_found") {
                return {
                    toast: { type: "info", content: "任务已经结束，无需再次停止。" },
                };
            }
            if (outcome === "forbidden") {
                return {
                    toast: { type: "warning", content: "只有任务发起人可以停止它。" },
                };
            }
            if (outcome === "already_stopping") {
                return { toast: { type: "info", content: "正在停止任务，请稍候。" } };
            }
            return { toast: { type: "success", content: "已发送停止指令。" } };
        },
        onMessage: async (msg, bot) => {
            // 还原 @占位符：把 "@_user_1" 换成 "@显示名"；
            // 将来 bot 想 @某个真人（例如危险操作需要真人拍板）时，靠 mentions 定位真实 open_id
            // eg @小助手，查看现在有什么任务
            const resolved = resolveMentions(msg.text, msg.mentions);
            console.log(`rootid=${msg.rootId} threadid=${msg.threadId}`)
            // 是否在话题内：有 threadId 或 rootId 就算（决定回复是否进入话题）
            const hasThread = !!msg.threadId || !!msg.rootId;
            const cliRequest = parseCliRequest(resolved);
            if (cliRequest && !cliRequest.prompt) {
                await bot.reply(
                    msg.messageId,
                    `请在 /${cliRequest.cliId} 后面写下任务，例如：/${cliRequest.cliId} 检查项目状态`,
                    hasThread,
                );
                return;
            }
            // 显式写了 /claude 或 /codex 时优先使用用户选择，否则使用当前 bot 的 defaultCliId
            const { session, isNew } = await sessions.resolve(msg,
                cliRequest?.cliId ?? config.defaultCliId, config.id);
            const cliAdapter = getCliAdapter(session.cliId);
            const prompt = buildBotPrompt(
                config.systemPrompt,
                cliRequest?.prompt ?? resolved,
            );
            if (!isNew && cliRequest && cliRequest.cliId !== session.cliId) {
                await bot.reply(
                    msg.messageId,
                    `当前话题已经在使用 ${cliAdapter.displayName}。如需切换执行引擎，请新开一个话题。`,
                    hasThread,
                );
                return;
            }


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
                    ['/status 查看当前会话',
                        '/close 关闭当前会话',
                        '/help 查看命令',
                        '/claude <任务> 新话题使用 Claude Code',
                        '/codex <任务> 新话题使用 Codex',
                    ].join('\n'),
                    hasThread,
                );
                return;
            }
            if (command?.name === 'status') {
                await bot.reply(msg.messageId, formatSessionStatus(session, config.id), hasThread);
                return;
            }
            if (command?.name === 'close') {
                // 中止该会话正在跑的后台任务
                const active = activeRuns.get(session.id);
                if (active) {
                    active.cancelMode = "close";
                    active.controller.abort();
                }
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
            const activeRun: ActiveRun = {
                controller: run,
                ownerOpenId: msg.senderOpenId, // 会话发起人
            };
            activeRuns.set(session.id, activeRun);


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
                        title: cliAdapter.displayName,
                        status: "running",
                        detail: "正在启动执行引擎",
                        abortSessionId: session.id,
                    }),
                    hasThread,
                );
            } catch (error) {
                // 发卡片失败：任务无法继续，清理运行句柄并让会话回到 idle
                if (activeRuns.get(session.id)?.controller === run)
                    activeRuns.delete(session.id);
                // 改成 idle，后面可以继续
                await markSessionIdle(session.id, sessions);
                throw error;
            }

            if (!cardId) {
                // 飞书响应里没有 message_id：同样无法更新卡片，收尾退出
                console.error("[卡片] 响应里没有 message_id，无法继续更新");
                if (activeRuns.get(session.id)?.controller === run)
                    activeRuns.delete(session.id);

                await markSessionIdle(session.id, sessions);
                return;
            }

            console.log(`[卡片] 已发送 message_id=${cardId} inThread=${hasThread}`);
            const progress = new TaskProgressTracker(
                Date.now,
                contextWindows.get(session.id),
                !session.cliSessionId
            );

            const cardUpdater = new ThrottledCardUpdater((card) =>
                bot.updateCard(cardId, card),
            );
            const renderProgress = () => {
                const snapshot = progress.snapshot();
                cardUpdater.push(
                    buildTaskCard({
                        title: cliAdapter.displayName,
                        status: "running",
                        detail: snapshot.current,
                        progress: snapshot,
                        abortSessionId: session.id,
                    }),
                );
            };
            const progressHeartbeat = setInterval(renderProgress, 1_000);
            progressHeartbeat.unref();

            // 让事件回调尽快返回，Claude Code 在后台继续执行。
            void executeCli(cliAdapter, resolved, session.cliSessionId, run.signal, (event) => {
                if (
                    event.type !== "tool_start" &&
                    event.type !== "tool_end" &&
                    event.type !== "context"
                )
                    return;

                progress.accept(event);
                renderProgress();
            })
                // result 是 claude 返回的结果
                .then(async (result) => {
                    clearInterval(progressHeartbeat);
                    // 执行完 有了 claude 会话 id，在设置
                    if (result.sessionId && result.sessionId !== session.cliSessionId) {
                        await sessions.setCliSessionId(session.id, result.sessionId);
                    }
                    if (result.stats?.contextWindowTokens) {
                        contextWindows.set(session.id, result.stats.contextWindowTokens);
                    }
                    const snapshot = progress.snapshot();
                    await cardUpdater.finish(
                        buildTaskCard({
                            title: cliAdapter.displayName,
                            status: "success",
                            detail: "执行完成",
                            progress: snapshot,
                            answer: result.answer,
                            stats: result.stats,
                            recipientOpenId: msg.senderOpenId,
                        }),
                    );
                    if (answerNeedsContinuation(result.answer)) {
                        for (const chunk of splitLongText(
                            answerContinuation(result.answer),
                        )) {
                            await bot.reply(msg.messageId, chunk, hasThread);
                        }
                    }
                    console.log(
                        `[CLI] ${cliAdapter.id} 完成 session_id=${result.sessionId ?? "(无)"}`,
                    );

                })
                .catch(async (error) => {
                    clearInterval(progressHeartbeat);
                    if (run.signal.aborted) {
                        console.log("[CLI] 任务已取消");
                        await cardUpdater.finish(
                            buildTaskCard({
                                title: cliAdapter.displayName,
                                status: "cancelled",
                                detail:
                                    activeRun.cancelMode === "close"
                                        ? "本次任务已停止，当前会话已经关闭。"
                                        : "本次任务已停止。你可以继续在当前话题里提问。",
                                progress: progress.snapshot(),
                            }),
                        );
                        return;
                    }
                    const message = (error as Error).message;
                    console.error("[CLI] 执行失败:", message);
                    await cardUpdater.finish(
                        buildTaskCard({
                            title: cliAdapter.displayName,
                            status: "failed",
                            detail: "执行没有完成。你可以调整指令后，在当前话题里重试。",
                            technicalDetail: message,
                            progress: progress.snapshot(),
                        }),
                    );
                })
                .finally(async () => {
                    clearInterval(progressHeartbeat);
                    if (activeRuns.get(session.id)?.controller === run) {
                        activeRuns.delete(session.id);
                    }
                    try {
                        await markSessionIdle(session.id, sessions);
                    } catch (error) {
                        console.error("[会话] 保存空闲状态失败:", (error as Error).message);
                    }
                })
                // 这个 catch 用于接住卡片更新或状态持久化自身的异常，
                // 避免后台出现 Unhandled Promise rejection
                .catch((error) => {
                    console.error("[任务] 回传或收尾失败:", (error as Error).message);
                });


            // 后台模拟执行：让事件回调尽快返回（否则飞书长连接会排队积压），
            // 进度通过 updateCard 持续刷新卡片；finally 里统一收尾。
            // void runCardDemo(bot, cardId, resolved, run.signal).catch((error) => {
            //     console.error("[卡片] 演示失败:", (error as Error).message);
            // }).finally(async () => {
            //     // 任务结束：无论成功/失败/中止，都摘除运行句柄，会话回到 idle
            //     // 如果需要继续对话，上面会重新设置
            //     if (activeRuns.get(session.id) === run) activeRuns.delete(session.id);

            //     try {
            //         await markSessionIdle(session.id, sessions);
            //     } catch (error) {
            //         console.error('[会话] 保存空闲状态失败:', (error as Error).message);
            //     }
            // });
            // const replyId = await bot.reply(msg.messageId, `收到：${resolved}`, hasThread);
            // console.log(`[已回] message_id=${replyId} inThread=${hasThread}`);


            // await bot.reply(msg.messageId, `<at user_id="${process.env.OWNER_OPEN_ID}"></at> 收到，这条是点名回复`);

        },
    })
    console.log(`[Bot ${config.id.toUpperCase()}] 已连接`);
}

await Promise.all(botConfigs.map(startConfiguredBot));