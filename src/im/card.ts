/**
 * 飞书任务卡片：构建卡片内容，并把高频进度合并成低频更新。
 */

export type CardJson = Record<string, unknown>;
export type TaskStatus = "running" | "success" | "failed";

export interface TaskCardOptions {
    title: string;
    status: TaskStatus;
    progress: number;
    detail: string;
    activities?: string[];
}

const STATUS_STYLE = {
    running: { template: "blue", label: "运行中" },
    success: { template: "green", label: "已完成" },
    failed: { template: "red", label: "执行失败" },
} as const;

/** 把进度限制在 0-100 的整数区间 */
function clampProgress(progress: number): number {
    return Math.min(100, Math.max(0, Math.round(progress)));
}

/** 渲染进度条字符：10 格，█ 表示已完成、░ 表示未完成 */
function buildProgressBar(progress: number): string {
    const filled = Math.round(progress / 10);
    return `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
}

/**
 * 构建飞书任务卡片 JSON（卡片协议 schema 2.0）：
 * - header：彩色标题（蓝=运行中 / 绿=已完成 / 红=执行失败）
 * - body：状态 + 进度条 + 当前动作 + 最近进展列表 + 一个禁用按钮
 * - config.update_multi：共享卡片，后续 updateCard 会同步刷新所有看过的人
 * - config.summary：聊天列表里的消息预览（不点开也能看到状态）
 */
export function buildTaskCard(options: TaskCardOptions): CardJson {
    const progress = clampProgress(options.progress);
    const style = STATUS_STYLE[options.status];
    const activities = options.activities ?? [];
    const activityText = activities.length
        ? `\n\n**最近进展**\n${activities.map((item) => `- ${item}`).join("\n")}`
        : "";

    return {
        schema: "2.0",
        config: {
            //它表示这是一张共享卡片，后续更新会同步给所有看过这条消息的人
            update_multi: true,
            //summary 则控制聊天列表里的消息预览，用户不打开话题也能看到任务正在运行还是已经完成
            summary: { content: `${options.title}：${style.label}` },
        },
        header: {
            template: style.template,
            title: { tag: "plain_text", content: options.title },
        },
        body: {
            direction: "vertical",
            elements: [
                {
                    tag: "markdown",
                    content: [
                        `**状态：** ${style.label}`,
                        `**进度：** ${buildProgressBar(progress)} ${progress}%`,
                        `**当前：** ${options.detail}${activityText}`,
                    ].join("\n\n"),
                },
                {
                    tag: "button",
                    text: {
                        tag: "plain_text",
                        content: options.status === "running" ? "任务执行中" : style.label,
                    },
                    type: options.status === "success" ? "primary" : "default",
                    disabled: true,
                },
            ],
        },
    };
}

type UpdateCard = (card: CardJson) => Promise<void>;

/**
 * 飞书卡片防抖更新工具类
 * 核心策略：2秒时间窗口内，连续多次push卡片，**最终只发送最新那一张卡片**
 * 解决场景：高频刷新交互式消息卡片，避免短时间大量调用飞书更新卡片接口触发限流
 * 机制说明：
 * 1. 连续push只会暂存最新card，不会立即请求接口
 * 2. 等待窗口冷却结束，执行一次更新
 * 3. 更新执行期间如果又产生新的待更新卡片，冷却窗口自动重启
 * 4. updateChain 保证卡片更新请求**串行排队执行，不会并发调用接口**
 */
export class ThrottledCardUpdater {
    /** 待提交的最新卡片缓存（窗口内多次push，覆盖成最新） */
    private pendingCard: CardJson | undefined;
    /** 定时器句柄，用来控制2秒冷却窗口 */
    private timer: ReturnType<typeof setTimeout> | undefined;
    /**
     * 更新任务Promise链条
     * 作用：保证卡片更新接口串行执行，杜绝并发调用updateCard
     * 新的更新任务永远追加到链条尾部，等待上一次更新完成再执行
     */
    private updateChain: Promise<void> = Promise.resolve();
    /** 是否已经调用finish结束，结束后不再接收push */
    private closed = false;

    constructor(
        /** 真正执行卡片更新的底层回调（调用飞书API更新卡片） */
        private readonly updateCard: UpdateCard,
        /** 防抖冷却窗口时长，默认2000ms */
        private readonly intervalMs = 2_000,
    ) { }

    /**
     * 推入待更新卡片，会覆盖之前旧卡片
     * @param card 需要更新的最新卡片数据
     */
    push(card: CardJson): void {
        if (this.closed) throw new Error("卡片更新器已经结束");
        // 直接覆盖缓存，永远保存最新的卡片
        this.pendingCard = card;
        // 启动/维持定时器窗口
        this.schedule();
    }

    /**
     * 强制收尾：终止防抖等待，执行最终卡片，并且永久关闭更新器
     * 使用时机：交互流程结束（比如按钮操作完成），不需要再等待冷却，立刻渲染最终卡片
     * @param finalCard 最终状态卡片
     */
    async finish(finalCard: CardJson): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        // 清除等待中的定时器，取消延迟任务
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        // 丢弃还未执行的缓存卡片
        this.pendingCard = undefined;
        // 等待队列中正在执行的更新任务全部跑完
        await this.updateChain;
        // 强制推送最终卡片
        await this.updateCard(finalCard);
    }

    async cancel(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pendingCard = undefined;
        await this.updateChain;
    }


    /**
     * 调度定时器：开启2秒延迟
     * 如果定时器已存在（窗口正在计时），直接return，不会重复创建
     */
    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            // 冷却时间到，执行刷新逻辑
            this.flushPending();
        }, this.intervalMs);
    }

    /**
     * 执行刷新：取出缓存卡片，加入串行更新队列
     */
    private flushPending(): void {
        // 取出当前最新待更新卡片，并清空缓存
        const card = this.pendingCard;
        this.pendingCard = undefined;

        // 无卡片 / 已经关闭，直接退出
        if (!card || this.closed) return;

        // 将本次更新追加到Promise串行链条尾部
        this.updateChain = this.updateChain
            .then(() => this.updateCard(card))
            .finally(() => {
                // ⭐关键逻辑：本次更新完成后，如果期间又push了新卡片，重新开启计时窗口
                if (this.pendingCard && !this.closed) this.schedule();
            });
    }
}