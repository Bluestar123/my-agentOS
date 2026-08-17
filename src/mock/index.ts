/**
 * 模拟任务模块（当前阶段的演示实现）
 *
 * 最终目标是把任务转给 Claude Code / Codex CLI 真实执行；
 * 现阶段用一段"假装在干活"的模拟任务打通全链路：
 * 收到消息 → 发任务卡片 → 分步推进进度 → 刷新卡片 → 完成收尾。
 */
import { SessionManager, type Session } from "../core/session-manager.js";
import { buildTaskCard, ThrottledCardUpdater } from "../im/card.js";

import { type Bot } from '../im/lark.js';

/** 会话状态 → 中文标签（/status 命令回复展示用） */
export const STATUS_LABELS: Record<Session['status'], string> = {
    creating: '创建中',
    active: '执行中',
    idle: '空闲',
    closed: '已关闭',
};

/** 格式化会话状态文本，用于 /status 命令回复 */
export function formatSessionStatus(session: Session): string {
    return [
        `会话：${session.id}`,
        `状态：${STATUS_LABELS[session.status]}`,
        `执行引擎：${session.cliId}`,
        `话题：${session.threadId}`,
        `更新时间：${session.updatedAt}`,
    ].join('\n');
}

/**
 * 可中止的等待：等待 ms 毫秒，期间收到 abort 信号立即结束
 * @returns true = 正常等满时长；false = 被中止（调用方应退出）
 */
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

/** 模拟任务的执行步骤（将来替换为真实 CLI 调用的阶段划分） */
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

/**
 * 后台模拟任务主流程：
 * 1. 每 700ms 推进一步（每一步都可被 abort 信号中止，如 /close）
 * 2. 每步 push 一张进度卡片（内部 2 秒防抖，只发最新一张）
 * 3. 8 步走完（进度 0→90%）后 finish 强制发送 100% 成功卡片
 * @param bot 机器人实例（用于 updateCard 刷新卡片）
 * @param cardId 已发送的任务卡片 message_id
 * @param resolved 还原 @ 后的用户原始指令（展示在最终卡片上）
 * @param signal 中止信号（来自 activeRuns 的 AbortController）
 */
export async function runCardDemo(
    bot: Bot,
    cardId: string,
    resolved: string,
    signal: AbortSignal,
): Promise<void> {
    const activities: string[] = []; // 动作历史，卡片上只展示最近 3 条
    const updater = new ThrottledCardUpdater(async (card) => {
        await bot.updateCard(cardId, card);
        console.log("[卡片] 已刷新");
    });

    for (const [index, step] of DEMO_STEPS.entries()) {
        // 每步等 700ms；/close 触发 abort 时立即退出
        if (!await wait(700, signal)) {
            await updater.cancel();
            console.log("[卡片] 已取消");
            return
        }
        activities.push(step);
        const progress = Math.round(((index + 1) / DEMO_STEPS.length) * 90); // 上限 90%，留 10% 给收尾
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

    // 全部步骤完成：强制发最终"已完成"卡片，关闭更新器
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

/**
 * 把会话标记为空闲（任务收尾时调用）：
 * 仅当当前状态是 active 才迁移到 idle；
 * 若已被 /close 置为 closed，这里直接跳过，避免覆盖关闭状态。
 */
export async function markSessionIdle(sessionId: string, sessions: SessionManager) {
    if (sessions.get(sessionId)?.status !== "active") return;
    await sessions.transition(sessionId, "idle");
    console.log(`[会话] id=${sessionId} status=idle`);
}