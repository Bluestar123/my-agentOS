/**
 * Claude Code CLI 适配器
 * 
 * 作用：将 Claude Code 的 JSON 流式输出转换为标准化的 CliEvent 事件，
 * 同时提供命令行参数构建功能
 */
import type { CliAdapter, CliEvent, CliRunStats } from "./types.js";

/**
 * Claude Code 输出的原始 JSON 事件结构
 * 字段说明：
 * - type: 事件类型（system/assistant/user/result）
 * - subtype: 子类型（如 init 表示初始化）
 * - session_id: 会话 ID
 * - message: 消息内容（包含 content blocks）
 * - result: 最终结果文本
 * - is_error: 是否错误
 * - usage: token 使用统计
 * - modelUsage: 模型上下文窗口信息
 */
interface ClaudeEvent {
    type?: unknown;
    subtype?: unknown;
    is_error?: unknown;
    result?: unknown;
    session_id?: unknown;
    duration_ms?: unknown;
    num_turns?: unknown;
    usage?: unknown;
    modelUsage?: unknown;
    message?: unknown;
}

/**
 * Claude 消息内容块结构
 * 用于解析 assistant/user 消息中的各个内容块
 * 字段说明：
 * - type: 块类型（tool_use 表示工具调用，tool_result 表示工具结果）
 * - id: 工具使用 ID
 * - name: 工具名称（如 Read、Bash、Edit 等）
 * - input: 工具输入参数
 * - tool_use_id: 关联的工具使用 ID（用于 tool_result）
 * - is_error: 工具执行是否失败
 */
interface ClaudeContentBlock {
    type?: unknown;
    id?: unknown;
    name?: unknown;
    input?: unknown;
    tool_use_id?: unknown;
    is_error?: unknown;
}

/**
 * 工具名称到中文标签的映射表
 * 用于在 UI 中显示友好的工具调用描述
 */
const TOOL_LABELS: Record<string, string> = {
    Agent: "启动子任务",
    Bash: "运行命令",
    Edit: "修改文件",
    Glob: "查找文件",
    Grep: "搜索代码",
    Read: "读取文件",
    Task: "启动子任务",
    TaskOutput: "等待子任务完成",
    WebFetch: "读取网页",
    WebSearch: "搜索资料",
    Write: "写入文件",
};

/**
 * 类型守卫：检查值是否为对象
 * 用于安全地访问对象属性
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/**
 * 安全地将未知值转换为数字
 * 如果不是有效数字则返回 undefined
 */
function asNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value)
        ? value
        : undefined;
}

/**
 * 提取文件路径的简短显示形式
 * 规则：
 * - 绝对路径取最后 2 段，相对路径取最后 3 段
 * - 统一使用正斜杠分隔
 * 示例：/a/b/c/d.ts → c/d.ts，a/b/c/d.ts → b/c/d.ts
 */
function shortPath(value: unknown): string | undefined {
    if (typeof value !== "string" || !value) return undefined;
    const normalized = value.replaceAll("\\", "/");
    const parts = normalized.split("/").filter(Boolean);
    return parts.slice(normalized.startsWith("/") ? -2 : -3).join("/");
}

/**
 * 提取文本的简短显示形式
 * - 压缩多余空白为单个空格
 * - 超过 maxLength 则截断并添加省略号
 */
function shortText(value: unknown, maxLength = 72): string | undefined {
    if (typeof value !== "string") return undefined;
    const text = value.replace(/\s+/g, " ").trim();
    if (!text) return undefined;
    return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * 根据工具名称和输入生成简短的描述信息
 * 用于在工具调用事件中显示有意义的摘要
 * 不同工具提取不同字段：
 * - 文件操作类（Read/Edit/Write）：提取文件路径
 * - 搜索类（Glob/Grep）：提取搜索模式
 * - 命令执行（Bash）：提取命令描述
 * - 任务类（Agent/Task）：提取任务描述
 * - 网络搜索（WebSearch）：提取搜索关键词
 */
function toolDetail(name: string, input: unknown): string | undefined {
    if (!isRecord(input)) return undefined;
    if (["Read", "Edit", "Write"].includes(name)) {
        return shortPath(input.file_path);
    }
    if (name === "Glob") return shortText(input.pattern);
    if (name === "Grep") return shortText(input.pattern);
    if (name === "Bash") return shortText(input.description);
    if (name === "Agent" || name === "Task") return shortText(input.description);
    if (name === "WebSearch") return shortText(input.query);
    return undefined;
}

/**
 * 从消息对象中提取内容块数组
 * 过滤掉非对象类型的无效块
 */
function messageBlocks(message: unknown): ClaudeContentBlock[] {
    if (!isRecord(message) || !Array.isArray(message.content)) return [];
    return message.content.filter(isRecord);
}

/**
 * 计算总 token 使用量
 * 包括：输入 token + 输出 token + 缓存读取 token + 缓存创建 token
 */
function usageTokens(usage: unknown): number | undefined {
    if (!isRecord(usage)) return undefined;
    const values = [
        asNumber(usage.input_tokens),
        asNumber(usage.output_tokens),
        asNumber(usage.cache_read_input_tokens),
        asNumber(usage.cache_creation_input_tokens),
    ].filter((value): value is number => value !== undefined);
    return values.length
        ? values.reduce((sum, value) => sum + value, 0)
        : undefined;
}

/**
 * 提取模型上下文窗口大小
 * 从 modelUsage 对象中找出最大的 contextWindow 值
 */
function contextWindowTokens(modelUsage: unknown): number | undefined {
    if (!isRecord(modelUsage)) return undefined;
    const windows = Object.values(modelUsage)
        .filter(isRecord)
        .map((usage) => asNumber(usage.contextWindow))
        .filter((value): value is number => value !== undefined && value > 0);
    return windows.length ? Math.max(...windows) : undefined;
}

/**
 * 从 Claude result 事件解析运行统计信息
 * 包括：耗时、轮次、各类 token 使用量、上下文窗口大小
 * 如果没有任何有效数据则返回 undefined
 */
function parseStats(event: ClaudeEvent): CliRunStats | undefined {
    const usage = isRecord(event.usage) ? event.usage : {};
    const totalTokens = usageTokens(usage);
    const windowTokens = contextWindowTokens(event.modelUsage);
    const stats: CliRunStats = {
        durationMs: asNumber(event.duration_ms),
        turns: asNumber(event.num_turns),
        totalTokens,
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        cacheReadTokens: asNumber(usage.cache_read_input_tokens),
        cacheCreationTokens: asNumber(usage.cache_creation_input_tokens),
        contextWindowTokens: windowTokens,
    };
    return Object.values(stats).some((value) => value !== undefined)
        ? stats
        : undefined;
}

/**
 * 构建 Claude Code 输出模式的命令行参数
 * - -p: 提示词
 * - --output-format stream-json: 流式 JSON 输出（便于解析）
 * - --verbose: 详细模式（包含更多事件信息）
 */
function outputArgs(prompt: string): string[] {
    return ["-p", prompt, "--output-format", "stream-json", "--verbose"];
}

/**
 * Claude Code CLI 适配器实现
 * 
 * 职责：
 * 1. 构建命令行参数（新会话/恢复会话）
 * 2. 解析 Claude Code 的 JSON 流式输出为标准事件
 * 
 * Claude Code 事件流程：
 * system/init → 返回 session_id
 * assistant → 包含 tool_use（工具调用开始）
 * user → 包含 tool_result（工具调用结束）
 * result → 最终结果 + 统计信息
 * error → 错误信息
 */
export class ClaudeAdapter implements CliAdapter {
    readonly id = "claude" as const;
    readonly command = "claude";
    readonly displayName = "Claude Code";

    /**
     * 构建新会话的命令行参数
     */
    buildArgs(prompt: string): string[] {
        return outputArgs(prompt);
    }

    /**
     * 构建恢复会话的命令行参数
     * 添加 --resume <sessionId> 来继续之前的对话
     */
    buildResumeArgs(prompt: string, sessionId: string): string[] {
        return ["--resume", sessionId, ...outputArgs(prompt)];
    }

    /**
     * 解析单行 JSON 输出为单个事件（仅返回第一个）
     * 用于只需要处理单个事件的场景
     */
    parseEvent(line: string): CliEvent | undefined {
        return this.parseEvents(line)[0];
    }

    /**
     * 解析 Claude Code 的 JSON 流式输出为标准事件数组
     * 
     * 解析规则：
     * 1. system/init 事件 → 提取 session_id，返回 session 事件
     * 2. assistant 事件 → 提取工具调用（tool_use），返回 tool_start 事件
     * 3. user 事件 → 提取工具结果（tool_result），返回 tool_end 事件
     * 4. result 事件 → 提取最终答案和统计信息，返回 result/error 事件
     * 
     * @param line Claude Code 输出的一行 JSON
     * @returns 解析后的事件数组（可能为多个事件）
     */
    parseEvents(line: string): CliEvent[] {
        // 尝试解析 JSON，失败返回空数组
        let event: ClaudeEvent;
        try {
            event = JSON.parse(line) as ClaudeEvent;
        } catch {
            return [];
        }

        // 提取会话 ID
        const sessionId =
            typeof event.session_id === "string" ? event.session_id : undefined;

        // 1. 系统初始化事件：提取 session_id
        if (event.type === "system" && event.subtype === "init" && sessionId) {
            return [{ type: "session", sessionId }];
        }
        // 2. 助手响应事件：提取工具调用和上下文信息
        if (event.type === "assistant") {
            const message = isRecord(event.message) ? event.message : {};

            // 提取 token 使用量，生成 context 事件
            const usedTokens = usageTokens(message.usage);
            const contextEvent: CliEvent[] =
                usedTokens === undefined ? [] : [{ type: "context", usedTokens }];

            // 遍历消息内容块，提取工具调用事件
            const toolEvents = messageBlocks(event.message).flatMap(
                (block): CliEvent[] => {
                    // 只处理 tool_use 类型的块
                    if (
                        block.type !== "tool_use" ||
                        typeof block.id !== "string" ||
                        typeof block.name !== "string"
                    )
                        return [];

                    // 生成工具调用的简短描述
                    const detail = toolDetail(block.name, block.input);
                    return [
                        {
                            type: "tool_start",
                            toolUseId: block.id,
                            toolName: block.name,
                            label: TOOL_LABELS[block.name] ?? `调用 ${block.name}`,
                            ...(detail ? { detail } : {}),
                        },
                    ];
                },
            );
            return [...contextEvent, ...toolEvents];
        }
        // 3. 用户消息事件：提取工具执行结果
        if (event.type === "user") {
            return messageBlocks(event.message).flatMap((block): CliEvent[] => {
                // 只处理 tool_result 类型的块
                if (
                    block.type !== "tool_result" ||
                    typeof block.tool_use_id !== "string"
                ) {
                    return [];
                }
                return [
                    {
                        type: "tool_end",
                        toolUseId: block.tool_use_id,
                        failed: block.is_error === true,
                    },
                ];
            });
        }
        // 4. 结果事件：提取最终答案和统计信息
        if (event.type !== "result") return [];

        // 错误结果：返回 error 事件
        if (event.is_error) {
            return [
                {
                    type: "error",
                    message:
                        typeof event.result === "string"
                            ? event.result
                            : "Claude Code 执行失败",
                    ...(sessionId ? { sessionId } : {}),
                },
            ];
        }

        // 成功结果：提取答案文本和运行统计
        if (typeof event.result !== "string") return [];
        const stats = parseStats(event);
        return [
            {
                type: "result",
                answer: event.result,
                ...(sessionId ? { sessionId } : {}),
                ...(stats ? { stats } : {}),
            },
        ];
    }
}
