/**
 * probe-cli：AI 编程 CLI 探测工具（独立小工具，不参与机器人主流程）
 *
 * 作用：把 Claude Code / Codex 等 AI CLI 的流式 JSON 输出（--output-format stream-json）
 * 翻译成人能读懂的日志，用于观察 AI 执行任务时的每一步动作（说了什么、调了什么工具）。
 *
 * 典型用法（管道输入）：
 *   claude -p "当前目录下有哪些文件？数一下有几个" \
 *     --output-format stream-json --verbose | pnpm probe:cli
 */
import { createInterface } from "node:readline";

// 计时基准：进程启动时刻，用于给每行日志打相对时间戳（如 [3.2s]）
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

// 逐行读取 stdin（上游 CLI 的输出），每行都是一个 JSON 事件
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
    let ev: any;
    try {
        ev = JSON.parse(line);
    } catch {
        return; // 非 JSON 行（CLI 自身打印的日志噪音）直接跳过
    }

    switch (ev.type) {
        // ── Claude Code 事件 ──
        case "system":
            // system 事件：subtype=init 表示一次会话初始化（包含会话 ID 和模型名）
            if (ev.subtype === "init")
                console.log(
                    `${stamp()} 会话开始 session_id=${ev.session_id} model=${ev.model}`,
                );
            break;
        case "assistant":
            // assistant 事件：模型的一轮输出，content 里混合多种块
            // text 块 = 模型说的话；tool_use 块 = 模型发起的一次工具调用
            for (const block of ev.message?.content ?? []) {
                if (block.type === "text" && block.text)
                    console.log(`${stamp()} 模型说: ${block.text}`);
                if (block.type === "tool_use")
                    console.log(`${stamp()} 调用工具: ${block.name}`);
            }
            break;
        case "result":
            // result 事件：整轮任务结束，汇总轮次数 / 耗时 / 成本
            console.log(
                `${stamp()} 完成 turns=${ev.num_turns} 耗时=${ev.duration_ms}ms 成本=$${ev.total_cost_usd}`,
            );
            console.log(`${stamp()} 最终回答: ${ev.result}`);
            break;

        // ── Codex 事件 ──
        case "thread.started":
            // Codex 会话开始
            console.log(`${stamp()} 会话开始 thread_id=${ev.thread_id}`);
            break;
        case "item.completed":
            // Codex 的一个 item 完成：agent_message=模型回答，command_execution=执行了命令
            if (ev.item?.type === "agent_message")
                console.log(`${stamp()} 模型说: ${ev.item.text}`);
            if (ev.item?.type === "command_execution")
                console.log(`${stamp()} 执行命令: ${ev.item.command}`);
            break;
        case "turn.completed":
            // Codex 一轮对话完成，usage 里是 token 消耗统计
            console.log(`${stamp()} 完成 tokens=${JSON.stringify(ev.usage)}`);
            break;
    }
});
