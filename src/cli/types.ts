export type CliId = "claude" | 'codex';

export type CliPromptInput = "argument" | "stdin";

// // Windows 上 prompt 必须走 stdin（避免 cmd 对命令行参数转义/乱码），其他平台直接走参数。
export function promptInputForPlatform(platform: NodeJS.Platform): CliPromptInput {
    return platform === "win32" ? "stdin" : "argument";
}

export interface CliRunStats {
    durationMs?: number;
    turns?: number;
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    contextUsedTokens?: number;
    contextWindowTokens?: number;
}

export type CliEvent =
    | { type: "session"; sessionId: string }
    | {
        type: "tool_start";
        toolUseId: string;
        toolName: string;
        label: string;
        detail?: string;
    }
    | { type: "tool_end"; toolUseId: string; failed: boolean }
    | { type: "context"; usedTokens: number }
    | { type: "result"; answer: string; sessionId?: string; stats?: CliRunStats }
    | { type: "error"; message: string; sessionId?: string };

export interface CliAdapter {
    readonly id: CliId;
    readonly command: string;
    readonly displayName: string;
    // 新会话怎么组装参数
    buildArgs(prompt: string, promptInput: CliPromptInput): string[];
    // 以后会话怎么续接
    buildResumeArgs(prompt: string, sessionId: string, promptInput: CliPromptInput): string[];
    // 原始输出统一解析
    parseEvents(line: string): CliEvent[];
    parseEvent(line: string): CliEvent | undefined;
}

export interface CliRunResult {
    answer: string;
    sessionId?: string;
    stats?: CliRunStats
}
