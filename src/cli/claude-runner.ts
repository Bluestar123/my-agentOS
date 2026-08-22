//这个模块只负责一件事：给它提示词和工作目录，它返回最终回答与 session_id。
import { createInterface } from "node:readline";
import { spawnCli } from "./spawn-cli.js";

export interface ClaudeRunResult {
    answer: string;
    sessionId?: string;
}

export interface RunClaudeOptions {
    prompt: string;
    cwd: string;
    signal?: AbortSignal;
}

interface ClaudeResultEvent {
    type: "result";
    is_error?: boolean;
    result?: string;
    session_id?: string;
}

function isResultEvent(value: unknown): value is ClaudeResultEvent {
    if (!value || typeof value !== "object") return false;
    return (value as { type?: unknown }).type === "result";
}

export function runClaude(options: RunClaudeOptions): Promise<ClaudeRunResult> {
    // Windows 下 prompt 走 stdin（`-p` 后不跟参数即读 stdin），其他平台直接作为 `-p <prompt>`。
    const useStdin = process.platform === "win32";
    const args = [
        "-p",
        ...(useStdin ? [] : [options.prompt]),
        "--output-format",
        "stream-json",
        "--verbose",
    ];
    // 当前是父进程
    return new Promise((resolve, reject) => {
        // 获取子进程
        const child = useStdin
            ? spawnCli("claude", args, {
                cwd: options.cwd,
                signal: options.signal,
                stdio: ["pipe", "pipe", "pipe"],
            })
            : spawnCli("claude", args, {
                cwd: options.cwd,
                signal: options.signal,
                stdio: ["ignore", "pipe", "pipe"],
            });
        const lines = createInterface({ input: child.stdout });
        let finalResult: ClaudeRunResult | undefined;
        let resultError: Error | undefined;
        let stderr = "";
        let settled = false;

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            reject(error);
        };

        lines.on("line", (line) => {
            console.log(line)
            let event: unknown;
            try {
                event = JSON.parse(line);
            } catch {
                return;
            }
            if (!isResultEvent(event)) return;
            if (event.is_error) {
                resultError = new Error(event.result || "Claude Code 执行失败");
                return;
            }
            if (typeof event.result === "string") {
                finalResult = {
                    answer: event.result,
                    sessionId: event.session_id,
                };
            }
        });

        child.stderr.on("data", (chunk: Buffer | string) => {
            stderr += chunk.toString();
        });
        child.once("error", (error) => {
            if (options.signal?.aborted) {
                fail(new Error("Claude Code 执行已取消"));
                return;
            }
            fail(error);
        });
        child.once("close", (code) => {
            if (settled) return;
            if (options.signal?.aborted) {
                return fail(new Error("Claude Code 执行已取消"));
            }
            if (resultError) return fail(resultError);
            if (code !== 0) {
                return fail(
                    new Error(stderr.trim() || `Claude Code 退出，状态码 ${code}`),
                );
            }
            if (!finalResult) {
                return fail(new Error("Claude Code 没有返回最终结果"));
            }
            settled = true;
            resolve(finalResult);
        });

        if (useStdin && child.stdin) {
            child.stdin.once("error", fail);
            // 写入prompt
            child.stdin.end(options.prompt, "utf8");
        }
    });
}
