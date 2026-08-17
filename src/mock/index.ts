import { SessionManager, type Session } from "../core/session-manager.js";
import { buildTaskCard, ThrottledCardUpdater } from "../im/card.js";

import { type Bot } from '../im/lark.js';


export const STATUS_LABELS: Record<Session['status'], string> = {
    creating: '创建中',
    active: '执行中',
    idle: '空闲',
    closed: '已关闭',
};

export function formatSessionStatus(session: Session): string {
    return [
        `会话：${session.id}`,
        `状态：${STATUS_LABELS[session.status]}`,
        `执行引擎：${session.cliId}`,
        `话题：${session.threadId}`,
        `更新时间：${session.updatedAt}`,
    ].join('\n');
}


export function wait(ms: number, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", stopWaiting);
            resolve(true);
        }, ms);
        const stopWaiting = () => {
            clearTimeout(timer);
            resolve(false);
        };
        signal.addEventListener("abort", stopWaiting, { once: true });
    });
}

export const DEMO_STEPS = [
    "读取项目结构",
    "定位任务入口",
    "分析相关文件",
    "生成修改方案",
    "写入代码改动",
    "检查类型错误",
    "运行验证命令",
    "整理执行结果",
];


export async function runCardDemo(
    bot: Bot,
    cardId: string,
    resolved: string,
    signal: AbortSignal,
): Promise<void> {
    const activities: string[] = [];
    const updater = new ThrottledCardUpdater(async (card) => {
        await bot.updateCard(cardId, card);
        console.log("[卡片] 已刷新");
    });

    for (const [index, step] of DEMO_STEPS.entries()) {
        if (!await wait(700, signal)) {
            await updater.cancel();
            console.log("[卡片] 已取消");
            return
        }
        activities.push(step);
        const progress = Math.round(((index + 1) / DEMO_STEPS.length) * 90);
        console.log(`[进度] ${progress}% ${step}`);
        updater.push(
            buildTaskCard({
                title: "Agent OS 模拟任务",
                status: "running",
                progress,
                detail: step,
                activities: activities.slice(-3),
            }),
        );
    }

    await updater.finish(
        buildTaskCard({
            title: "Agent OS 模拟任务",
            status: "success",
            progress: 100,
            detail: `已处理：${resolved || "富媒体消息"}`,
            activities: activities.slice(-3),
        }),
    );
    console.log("[卡片] 任务完成");
}

export async function markSessionIdle(sessionId: string, sessions: SessionManager) {
    if (sessions.get(sessionId)?.status !== "active") return;
    await sessions.transition(sessionId, "idle");
    console.log(`[会话] id=${sessionId} status=idle`);
}