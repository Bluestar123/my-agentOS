/**
 * 斜杠命令解析器
 *
 * 支持命令：
 * - /close  关闭当前会话（中止正在执行的任务）
 * - /status 查看当前会话状态
 * - /help   查看命令列表
 *
 * 格式要求：一行内只包含一条命令；允许命令前带 "@机器人 " 前缀
 * （群聊里先 @ 机器人再发命令时，文本形如 "@MyBot /status"）。
 */

import { CliId } from "../cli/types";

/** 当前支持的命令名 */
export type SlashCommand =
    | { name: 'close' | 'status' | 'help' }
    | { name: 'cd'; path?: string };



/**
 * 命令匹配正则，逐段解释：
 * ^              —— 文本开头
 * (?:@.+\s+)?    —— 可选的非捕获组：@某人 + 至少一个空白（@ 前缀）
 * \/(close|status|help) —— 捕获组 1：斜杠 + 命令名（三选一）
 * \s*$           —— 命令之后只允许空白，不允许再带参数或其他文字
 * 因此 "/status 给我看看" 这类带尾缀的文本不会被误判为命令。
 */
const COMMAND_RE = /^(?:@.+\s+)?\/(close|status|help)\s*$/;
const CD_RE = /^(?:@\S+\s+)?\/cd(?:\s+([\s\S]+?))?\s*$/;
const CLI_REQUEST_RE = /^(?:@\S+\s+)?\/(claude|codex)(?:\s+([\s\S]*))?$/;

/**
 * 从用户消息纯文本中解析斜杠命令
 * @param text 已还原 @占位符后的消息纯文本
 * @returns 匹配到命令返回 { name }；否则返回 undefined（按普通消息继续处理）
 */
export function parseCommand(text: string): SlashCommand | undefined {
    const value = text.trim();
    const cdMatch = CD_RE.exec(value);
    if (cdMatch) return { name: 'cd', path: cdMatch[1]?.trim() || undefined };
    const match = COMMAND_RE.exec(value);
    if (!match) return undefined;
    return { name: match[1] as 'close' | 'status' | 'help' };
}


export interface CliRequest {
    cliId: CliId;
    prompt: string;
}

export function parseCliRequest(text: string): CliRequest | undefined {
    const match = CLI_REQUEST_RE.exec(text.trim());
    if (!match) return undefined;
    return {
        cliId: match[1] as CliId,
        prompt: (match[2] ?? '').trim(),
    };
}