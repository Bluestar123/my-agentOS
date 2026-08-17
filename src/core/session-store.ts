import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { Session } from './session-manager.js';

/** 会话持久化接口：load 恢复历史会话，save 落盘全部会话 */
export interface SessionStore {
    load(): Promise<Session[]>;
    save(sessions: Session[]): Promise<void>;
}

/**
 * zod 校验模式：逐字段校验磁盘读出的数据，
 * 结构非法的记录直接丢弃（防止手改文件或旧版本残留数据导致崩溃）。
 */
const SessionSchema = z.object({
    id: z.string().min(1),
    threadId: z.string().min(1),
    chatId: z.string().min(1),
    cliId: z.literal('claude'),
    status: z.enum(['creating', 'active', 'idle', 'closed']),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
});

/**
 * 崩溃恢复：上次退出时仍处于 creating / active 的会话，
 * 其任务进程早已随进程消亡，必须重置为 idle，
 * 否则重启后该话题会永远卡在"执行中"无人处理。
 */
function recoverInterruptedSession(session: Session): Session {
    if (session.status !== 'creating' && session.status !== 'active') return session;
    return { ...session, status: 'idle' };
}

/**
 * JSON 文件会话存储（data/sessions.json）
 * 可靠性设计：
 * - 原子写：先写 *.tmp 临时文件，再 rename 覆盖原文件，避免写一半崩溃损坏数据
 * - 串行写：内部 Promise 队列保证 save 按调用顺序执行，杜绝并发写交错
 */
export class JsonSessionStore implements SessionStore {
    /** 写队列：每次 save 追加一个任务，前一个完成后才执行下一个 */
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly filePath: string) { }

    /**
     * 读取并校验会话文件，完整流程：
     * 1. 文件不存在（ENOENT）→ 返回空数组（首次启动）
     * 2. 顶层不是数组 → 抛错（文件损坏，阻止带病启动）
     * 3. 逐行 zod 校验：非法记录丢弃，并标记 needsCleanup
     * 4. creating/active → 恢复为 idle（崩溃恢复）
     * 5. 有任何清理动作 → 回写一次文件，让磁盘数据自愈
     * @returns 恢复出的会话数组（供 SessionManager 重建内存）
     */
    async load(): Promise<Session[]> {
        let content: string;
        try {
            content = await readFile(this.filePath, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }

        const rows: unknown = JSON.parse(content);
        if (!Array.isArray(rows)) {
            throw new Error(`会话文件格式错误: ${this.filePath}`);
        }

        const sessions: Session[] = [];
        let needsCleanup = false; // 是否需要回写修复磁盘数据
        for (const row of rows) {
            const result = SessionSchema.safeParse(row);
            if (!result.success) {
                // 结构非法的记录：跳过 + 触发回写清理
                needsCleanup = true;
                // 跳过非法记录
                continue;
            }
            // 把每一条中断的状态改为 idle
            const recovered = recoverInterruptedSession(result.data);
            if (recovered.status !== result.data.status) needsCleanup = true;
            sessions.push(recovered);
        }
        if (needsCleanup) await this.save(sessions);
        return sessions;
    }

    /**
     * 保存全部会话（整体覆盖写），执行步骤：
     * 1. 序列化为带缩进的 JSON 快照（便于人读/人改）
     * 2. 递归创建目录（首次运行时 data/ 可能还不存在）
     * 3. 写入临时文件 sessions.json.tmp
     * 4. rename 原子替换正式文件（写一半断电也不会损坏原文件）
     * 5. 整个流程追加进 writeQueue 串行执行，保证调用顺序
     */
    save(sessions: Session[]): Promise<void> {
        const snapshot = JSON.stringify(sessions, null, 2);
        const write = async () => {
            await mkdir(dirname(this.filePath), { recursive: true });
            // 能避开进程恰好在写到一半时留下半截 JSON 的常见情况，有问题只损坏 tmp，不影响原来的
            const tempPath = `${this.filePath}.tmp`;
            await writeFile(tempPath, `${snapshot}\n`, 'utf8');
            await rename(tempPath, this.filePath);
        };

        this.writeQueue = this.writeQueue.then(write, write);
        return this.writeQueue;
    }
}
