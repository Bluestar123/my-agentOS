/**
 * 飞书任务卡片构建模块。
 *
 * 职责：把任务的实时进度（TaskProgressSnapshot）与最终结果（回答 + 运行统计）
 * 渲染成飞书卡片 2.0 的 JSON 结构（CardJson），供 im/lark.ts 发送 / 更新。
 *
 * 卡片结构：
 * - config：协议配置，update_multi 允许同一张卡片反复更新（进度刷新靠它）
 * - header：顶部彩色标题栏，颜色随任务状态变化（蓝=执行中 / 绿=完成 / 红=失败 / 灰=取消）
 * - body：正文，由 markdown 文本块、按钮、折叠面板等元素组成
 *
 * 两种视图：
 * - running（执行中）：实时显示当前动作、耗时、工具调用次数、最近完成的工具轨迹，
 *   可附「停止任务」按钮（传入 abortSessionId 时）
 * - 收尾（success / failed / cancelled）：展示回答（长回答折叠）或错误信息，
 *   外加「执行详情」折叠面板（耗时、token 消耗、执行轨迹）
 *
 * 飞书 markdown 与标准 markdown 有差异，本模块做了针对性处理：
 * - 反引号 → ˋ（飞书会把反引号解析为行内代码，直接出现会破坏排版）
 * - <at>/<a> 等尖括号标签 → 用零宽连接符打断（否则被飞书解析成特殊标签）
 */
import type { CliRunStats } from '../cli/types.js';
import type { TaskActivity, TaskProgressSnapshot } from '../core/task-progress.js';

/** 飞书卡片 2.0 的 JSON 结构（schema 2.0），可直接作为发送 / 更新接口的 payload */
export type CardJson = Record<string, unknown>;

/** 卡片展示的任务状态：执行中 / 成功 / 失败 / 已取消 */
export type TaskStatus = 'running' | 'success' | 'failed' | 'cancelled';

/** 构建任务卡片所需的全部配置项 */
export interface TaskCardOptions {
    /** 卡片标题（如「Claude Code 任务」） */
    title: string;
    /** 任务状态：决定卡片颜色与正文布局（running → 进度视图，其余 → 结果视图） */
    status: TaskStatus;
    /** 状态摘要：running 时显示当前动作，收尾时显示结果或错误概要 */
    detail: string;
    /** 实时进度快照（来自 TaskProgressTracker），运行中卡片主要靠它渲染 */
    progress?: TaskProgressSnapshot;
    /** 最终回答文本（仅 success 状态使用，长回答会折叠 / 截断） */
    answer?: string;
    /** 一次 CLI 运行结束后的统计（耗时、tokens 等），收尾卡片展示 */
    stats?: CliRunStats;
    /** 错误详情（仅 failed 状态使用），收进「查看错误详情」折叠面板 */
    technicalDetail?: string;
    /** 收件人 open_id：success 卡片末尾展示「发送给 @xx」，多任务并发时便于区分归属 */
    recipientOpenId?: string;
    /** 非空时 running 卡片附「停止任务」按钮，点击回调携带 sessionId 供服务端中止任务 */
    abortSessionId?: string;
}

/**
 * 任务状态 → 卡片样式映射
 * - template：飞书卡片内置主题色（blue 蓝 / green 绿 / red 红 / grey 灰）
 * - label：状态的中文标签，显示在标题栏
 */
const STATUS_STYLE = {
    running: { template: 'blue', label: '执行中' },
    success: { template: 'green', label: '已完成' },
    failed: { template: 'red', label: '执行失败' },
    cancelled: { template: 'grey', label: '已取消' },
} as const;

// 回答文本的阈值（字符数）：
// 900 字以内直接平铺显示；超过则先给「紧凑预览」，完整内容收进折叠面板
const COMPACT_ANSWER_LENGTH = 900;
// 单张卡片内回答的硬上限（飞书卡片有长度限制），
// 超出的剩余部分通过 answerContinuation 切出来，作为新消息继续发送
const MAX_CARD_ANSWER_LENGTH = 6_000;
// 运行中卡片「最近完成」列表最多展示条数（进度要实时刷新，保持精简）
const RUNNING_ACTIVITY_LIMIT = 3;
// 收尾卡片「执行轨迹」列表最多展示条数
const FINISHED_ACTIVITY_LIMIT = 8;

/** 工具名 → 展示图标（emoji）；未覆盖的工具在 activityLine 里回退为 ⚙️ */
const TOOL_ICONS: Record<string, string> = {
    Agent: '🧩',
    Bash: '⌘',
    Edit: '✏️',
    Glob: '📁',
    Grep: '🔎',
    Read: '📄',
    Task: '🧩',
    TaskOutput: '⏳',
    WebFetch: '🌐',
    WebSearch: '🔍',
    Write: '📝',
};

/** 毫秒耗时 → 人类可读文本（不足 1 秒按 1 秒计），如 "2 分 15 秒" */
function formatDuration(durationMs: number): string {
    const totalSeconds = Math.max(1, Math.round(durationMs / 1_000));
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (seconds === 0) return `${minutes} 分钟`;
    return `${minutes} 分 ${seconds} 秒`;
}

/** 大数字缩写：≥1000 显示为 x.xk（如 12345 → 12.3k），保持卡片内文本简短 */
function formatCount(value: number): string {
    return value >= 1_000 ? `${Math.round(value / 100) / 10}k` : String(value);
}

/** 把反引号替换为形似字符 ˋ：飞书 markdown 中反引号有特殊含义，直接出现会破坏排版 */
function escapeInlineCode(value: string): string {
    return value.replaceAll('`', 'ˋ');
}

/**
 * 打断尖括号标签，防止飞书把回答文本里的 <at>、<a href> 等当作特殊标签解析。
 * 在 `<` 后插入零宽连接符（&zwj;），视觉上无变化，但飞书不再识别为标签。
 * 正则前瞻确保只处理「< 后紧跟字母、最终以 > 结尾」的疑似标签形态。
 */
function escapeFeishuMarkdown(value: string): string {
    return value.replace(/<(?=\/?[A-Za-z][^>]*>)/g, '<&zwj;');
}

/** 把一条工具活动渲染成卡片内的一行文本：图标 + 中文动作 + 操作目标 + 耗时 */
function activityLine(activity: TaskActivity): string {
    // 失败的用 ⚠️ 突出，其余按工具类型取图标
    const icon = activity.failed ? '⚠️' : (TOOL_ICONS[activity.toolName] ?? '⚙️');
    // 操作目标（如文件路径）用行内代码样式展示
    const detail = activity.detail
        ? ` · \`${escapeInlineCode(activity.detail)}\``
        : '';
    // 耗时超过 1 秒才展示，短操作不刷屏
    const duration = activity.durationMs >= 1_000
        ? ` · ${formatDuration(activity.durationMs)}`
        : '';
    return `${icon} ${activity.label}${detail}${duration}`;
}

/**
 * 计算 markdown 文本的安全截断位置：
 * 优先在段落边界（空行 \n\n）截断，其次在行尾截断，避免从一行文字中间切开；
 * 若 maxLength 的前 55% 内都找不到合适边界，则硬截（说明正文连续无分段）。
 */
function markdownSplitIndex(text: string, maxLength: number): number {
    if (text.length <= maxLength) return text.length;
    const paragraph = text.lastIndexOf('\n\n', maxLength);
    if (paragraph >= maxLength * 0.55) return paragraph;
    const line = text.lastIndexOf('\n', maxLength);
    return line >= maxLength * 0.55 ? line : maxLength;
}

/** 若 markdown 存在未闭合的 ``` 代码围栏（出现奇数次），补一个闭合围栏防止预览格式崩坏 */
function closeOpenFence(markdown: string): string {
    const fences = markdown.match(/^```/gm)?.length ?? 0;
    return fences % 2 === 1 ? `${markdown}\n\n\`\`\`` : markdown;
}

/** 生成截断后的 markdown 预览：按安全边界截断 + 补全未闭合围栏 + 去首尾空白 */
function markdownPreview(text: string, maxLength: number): string {
    return closeOpenFence(text.slice(0, markdownSplitIndex(text, maxLength)).trim());
}

/**
 * 生成回答的「紧凑预览」（长回答折叠时展示）：
 * 1. 只取第一段代码围栏之前的纯文字部分——代码通常很长且不适合做预览
 * 2. 按边界截断，并去掉结尾的标题 / 分隔线残片
 * 3. 若剩余文字过少（<40 字）说明主体是代码，返回引导文案让用户展开查看
 */
function compactAnswerPreview(answer: string): string {
    const fenceIndex = answer.search(/\n```/);
    const prose = fenceIndex > 0 ? answer.slice(0, fenceIndex) : answer;
    const preview = markdownPreview(prose, COMPACT_ANSWER_LENGTH)
        .replace(/\n(?:---|#{1,6}\s+[^\n]+)\s*$/, '')
        .trim();
    return preview.length >= 40
        ? preview
        : '回答包含较多代码与细节，展开后可以查看完整内容。';
}

/** 计算累计消耗 token 总数：优先用 stats.totalTokens，缺省时由各项之和兜底 */
function usageTotal(stats: CliRunStats | undefined): number | undefined {
    if (!stats) return undefined;
    if (stats.totalTokens !== undefined) return stats.totalTokens;
    const values = [
        stats.inputTokens,
        stats.outputTokens,
        stats.cacheReadTokens,
        stats.cacheCreationTokens,
    ].filter((value): value is number => value !== undefined);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : undefined;
}

/**
 * 格式化上下文用量文本：
 * - 不知道窗口大小 → 「当前上下文约 X tokens」
 * - 用量超过窗口（数据异常）→ 不展示（undefined）
 * - 正常 → 「当前上下文 X / Y（Z%）」
 */
function formatContextUsage(
    usedTokens: number | undefined,
    windowTokens: number | undefined,
): string | undefined {
    if (usedTokens === undefined) return undefined;
    if (windowTokens === undefined || windowTokens <= 0) {
        return `当前上下文约 ${formatCount(usedTokens)} tokens`;
    }
    if (usedTokens > windowTokens) return undefined;
    const percentage = Math.round((usedTokens / windowTokens) * 100);
    return `当前上下文 ${formatCount(usedTokens)} / ${formatCount(windowTokens)}（${percentage}%）`;
}

/**
 * 格式化上下文增长情况：相对「起始点」的用量变化。
 * - startedNewSession=true：startTokens 是新建会话时的用量 → 对比整个会话
 * - false：startTokens 是本次运行开始时的用量 → 只对比本轮
 */
function formatContextGrowth(
    usedTokens: number | undefined,
    startTokens: number | undefined,
    startedNewSession = false,
): string | undefined {
    if (usedTokens === undefined || startTokens === undefined) return undefined;
    const delta = usedTokens - startTokens;
    const change = delta >= 0
        ? `新增 ${formatCount(delta)}`
        : `减少 ${formatCount(Math.abs(delta))}`;
    const startLabel = startedNewSession ? '新会话基础' : '本轮开始';
    return `${startLabel} ${formatCount(startTokens)} · ${change}`;
}

/**
 * 构建「运行中」卡片的正文元素：
 * 1. 当前动作行：图标 + 动作名 + 正在操作的目标（如文件路径）+ 耗时 / 调用次数 + 上下文用量
 * 2. 最近完成的工具轨迹（最多 RUNNING_ACTIVITY_LIMIT 条）
 * 3. 可选的「停止任务」按钮（触发 abort_task 回调，携带 sessionId 供服务端中止任务）
 */
function buildRunningElements(options: TaskCardOptions): Record<string, unknown>[] {
    const progress = options.progress;
    const currentIcon = progress?.currentToolName
        ? `${TOOL_ICONS[progress.currentToolName] ?? '⚙️'} `
        : '';
    const currentDetail = progress?.currentDetail
        ? `\n\`${escapeInlineCode(progress.currentDetail)}\``
        : '';
    const meta = progress
        ? `${formatDuration(progress.elapsedMs)} · ${progress.toolCount} 次工具调用`
        : '刚刚开始';
    const context = formatContextUsage(
        progress?.contextUsedTokens,
        progress?.contextWindowTokens,
    );
    const contextGrowth = formatContextGrowth(
        progress?.contextUsedTokens,
        progress?.contextStartTokens,
        progress?.startedNewSession,
    );
    const elements: Record<string, unknown>[] = [{
        tag: 'markdown',
        content: `**${currentIcon}${progress?.current ?? options.detail}**${currentDetail}\n\n${meta}${context ? `\n_${context}_` : ''}${contextGrowth ? `\n_${contextGrowth}_` : ''}`,
    }];
    if (progress?.activities.length) {
        const visible = progress.activities.slice(0, RUNNING_ACTIVITY_LIMIT);
        elements.push({
            tag: 'markdown',
            content: `**最近完成（${visible.length} / ${progress.completedCount}）**\n${visible.map(activityLine).join('\n')}`,
        });
    }
    if (options.abortSessionId) {
        elements.push({
            tag: 'button',
            text: { tag: 'plain_text', content: '停止任务' },
            type: 'danger',
            width: 'default',
            size: 'medium',
            behaviors: [{
                type: 'callback',
                value: {
                    action: 'abort_task',
                    sessionId: options.abortSessionId,
                },
            }],
        });
    }
    return elements;
}

/**
 * 构建「收尾」卡片的正文元素（success / failed / cancelled 共用）：
 * - success：展示回答——≤900 字平铺；否则「紧凑预览 + 查看完整回答折叠面板」，
 *   回答超长时提示剩余内容已另发新消息
 * - 其他状态：展示错误概要 + 可选「查看错误详情」折叠面板
 * - 统一附「执行详情」折叠面板：耗时、工具调用次数、token 消耗、上下文变化、执行轨迹
 * - success 且指定收件人时，末尾展示归属信息（Agent OS · 发送给 @xx）
 */
function buildFinishedElements(options: TaskCardOptions): Record<string, unknown>[] {
    const progress = options.progress;
    const durationMs = options.stats?.durationMs ?? progress?.elapsedMs;
    const totalTokens = usageTotal(options.stats);
    const context = formatContextUsage(
        progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
        options.stats?.contextWindowTokens ?? progress?.contextWindowTokens,
    );
    const contextGrowth = formatContextGrowth(
        progress?.contextUsedTokens ?? options.stats?.contextUsedTokens,
        progress?.contextStartTokens,
        progress?.startedNewSession,
    );
    const executionMeta = [
        durationMs !== undefined ? `**耗时** ${formatDuration(durationMs)}` : undefined,
        progress ? `**工具调用** ${progress.toolCount} 次` : undefined,
    ].filter(Boolean).join(' · ');
    const usageMeta = [
        totalTokens !== undefined
            ? `**累计消耗** ${formatCount(totalTokens)} tokens`
            : undefined,
        context
            ? `**当前上下文** ${context.replace(/^当前上下文(?:约)?\s+/, '')}`
            : undefined,
        contextGrowth ? `**本轮变化** ${contextGrowth}` : undefined,
    ].filter(Boolean).join('\n');
    const meta = [executionMeta, usageMeta].filter(Boolean).join('\n\n');
    const elements: Record<string, unknown>[] = [];

    if (options.status === 'success') {
        const answer = options.answer || options.detail;
        if (answer.length <= COMPACT_ANSWER_LENGTH) {
            elements.push({ tag: 'markdown', content: escapeFeishuMarkdown(answer) });
        } else {
            elements.push({
                tag: 'markdown',
                content: `${escapeFeishuMarkdown(compactAnswerPreview(answer))}\n\n_完整回答已收起_`,
            });
            elements.push({
                tag: 'collapsible_panel',
                expanded: false,
                header: collapsibleHeader('查看完整回答'),
                vertical_spacing: '8px',
                padding: '8px 8px 8px 8px',
                elements: [{
                    tag: 'markdown',
                    content: escapeFeishuMarkdown(markdownPreview(answer, MAX_CARD_ANSWER_LENGTH)),
                }],
            });
        }
        if (answerNeedsContinuation(answer)) {
            elements.push({
                tag: 'markdown',
                content: '_回答较长，剩余内容已继续发送。_',
            });
        }
    } else {
        elements.push({ tag: 'markdown', content: `**${options.detail}**` });
        if (options.technicalDetail) {
            elements.push({
                tag: 'collapsible_panel',
                expanded: false,
                header: collapsibleHeader('查看错误详情'),
                vertical_spacing: '8px',
                padding: '8px 8px 8px 8px',
                elements: [{
                    tag: 'markdown',
                    content: `\`${escapeInlineCode(options.technicalDetail)}\``,
                }],
            });
        }
    }

    if (meta || progress?.activities.length) {
        const visible = progress?.activities.slice(0, FINISHED_ACTIVITY_LIMIT) ?? [];
        const activityText = visible.length
            ? `\n\n**最近执行轨迹**\n${visible.map(activityLine).join('\n')}`
            : '';
        elements.push({
            tag: 'collapsible_panel',
            expanded: false,
            header: collapsibleHeader('执行详情'),
            vertical_spacing: '8px',
            padding: '8px 8px 8px 8px',
            elements: [{
                tag: 'markdown',
                content: `${meta || options.detail}${activityText}`,
            }],
        });
    }
    if (options.status === 'success' && options.recipientOpenId) {
        elements.push({ tag: 'hr' });
        elements.push({
            tag: 'markdown',
            content: `**Agent OS** · 发送给：<at id=${options.recipientOpenId}></at>`,
        });
    }
    return elements;
}

/** 折叠面板的头部结构：标题 + 右侧展开箭头图标（展开时旋转 -180°） */
function collapsibleHeader(content: string): Record<string, unknown> {
    return {
        title: { tag: 'plain_text', content },
        vertical_align: 'center',
        icon: {
            tag: 'standard_icon',
            token: 'down-small-ccm_outlined',
            size: '16px 16px',
        },
        icon_position: 'right',
        icon_expanded_angle: -180,
    };
}

/**
 * 主入口：把 TaskCardOptions 组装成一张完整飞书卡片。
 * 布局：状态色标题栏（header）+ 正文（body）。
 * 正文按状态分流：running → 进度视图（buildRunningElements）；其余 → 结果视图（buildFinishedElements）。
 */
export function buildTaskCard(options: TaskCardOptions): CardJson {
    const style = STATUS_STYLE[options.status];
    return {
        schema: '2.0',
        config: {
            update_multi: true,
            summary: { content: `${options.title}：${style.label}` },
        },
        header: {
            template: style.template,
            title: { tag: 'plain_text', content: `${options.title} · ${style.label}` },
        },
        body: {
            direction: 'vertical',
            vertical_spacing: '12px',
            elements: options.status === 'running'
                ? buildRunningElements(options)
                : buildFinishedElements(options),
        },
    };
}

/** 回答是否超过单张卡片上限（超过则需要分多条消息继续发送） */
export function answerNeedsContinuation(answer: string): boolean {
    return answer.length > MAX_CARD_ANSWER_LENGTH;
}

/** 从回答中切出「剩余部分」：与卡片内预览使用同一截断规则，保证前后拼接无缝 */
export function answerContinuation(answer: string): string {
    return answer.slice(markdownSplitIndex(answer, MAX_CARD_ANSWER_LENGTH));
}

/**
 * 把超长文本按行边界切成多段（每段 ≤ maxLength，默认 4000，飞书单条消息长度上限），
 * 供回答分段发送使用。
 */
export function splitLongText(text: string, maxLength = 4_000): string[] {
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxLength) {
        const newline = remaining.lastIndexOf('\n', maxLength);
        const splitAt = newline > maxLength / 2 ? newline : maxLength;
        chunks.push(remaining.slice(0, splitAt).trim());
        remaining = remaining.slice(splitAt).trim();
    }
    if (remaining) chunks.push(remaining);
    return chunks;
}

type UpdateCard = (card: CardJson) => Promise<void>;

/**
 * 节流卡片更新器：避免进度事件高频触发时疯狂调用飞书更新接口（会被限流）。
 *
 * 原理：push() 只记录「最新的一张卡片」并启动一个 intervalMs 的定时器；
 * 窗口内再多的进度更新都合并为一次请求，且始终提交最新状态（旧的直接丢弃）。
 * finish()/cancel() 用于收尾：停掉定时器、清空待发，等链上请求落定后再
 * 提交最终卡片（finish）或直接放弃（cancel）。
 */
export class ThrottledCardUpdater {
    /** 待提交的最新卡片（节流窗口内会被 push 反复覆盖，只保留最新的） */
    private pendingCard: CardJson | undefined;
    /** 节流定时器句柄 */
    private timer: ReturnType<typeof setTimeout> | undefined;
    /** 更新请求链：把 updateCard 调用串行化，避免并发请求导致卡片状态乱序 */
    private updateChain: Promise<void> = Promise.resolve();
    /** 收尾标记：finish/cancel 之后 push 不再生效 */
    private closed = false;

    constructor(
        /** 底层更新函数（通常是 bot.updateCard 的封装） */
        private readonly updateCard: UpdateCard,
        /** 节流窗口时长（毫秒），默认 1 秒 */
        private readonly intervalMs = 1_000,
    ) { }

    /**
     * 提交一次卡片更新（可能被节流合并）。
     * 只保留最新卡片：窗口内重复调用只刷新内容，不增加请求次数。
     */
    push(card: CardJson): void {
        if (this.closed) return;
        this.pendingCard = card;
        this.schedule();
    }

    /**
     * 收尾：丢弃所有中间态，最终提交 finalCard（如 100% 完成卡片）。
     * 等待在途请求完成后才发送，保证最终状态一定生效。
     */
    async finish(finalCard: CardJson): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pendingCard = undefined;
        // 等链上在途请求落定（失败也忽略，不阻断收尾）
        await this.updateChain.catch(() => undefined);
        await this.updateCard(finalCard);
    }

    /** 取消：清空待发卡片并等待在途请求结束，不提交任何最终卡片 */
    async cancel(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pendingCard = undefined;
        await this.updateChain.catch(() => undefined);
    }

    /** 启动节流定时器（已有定时器时不重复启动，保证窗口内只触发一轮） */
    private schedule(): void {
        if (this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flushPending();
        }, this.intervalMs);
    }

    /** 窗口结束：把最新的 pendingCard 提交出去；若期间又有新 push，则继续下一轮 */
    private flushPending(): void {
        const card = this.pendingCard;
        this.pendingCard = undefined;
        if (!card || this.closed) return;

        // 串到链尾执行，避免并发；结束后若又有新卡片待发，再开下一轮定时器
        this.updateChain = this.updateChain
            .then(() => this.updateCard(card))
            .finally(() => {
                if (this.pendingCard && !this.closed) this.schedule();
            });
    }
}
