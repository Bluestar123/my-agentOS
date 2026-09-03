import { randomUUID } from 'node:crypto';
import type { SessionStore } from './session-store.js';
import type { CliId } from "../cli/types.js";



/**
 * 会话状态机四态：
 * - creating：刚创建（内存已建、首次写盘未完成），任务尚未开始
 * - active：正在执行任务（任务卡片已发出）
 * - idle：空闲（任务执行完毕，等待下一条指令）
 * - closed：已关闭（该话题不再响应，用户需新开话题）
 */
export type SessionStatus = 'creating' | 'active' | 'idle' | 'closed';




/** 一次会话的完整记录（内存与磁盘共用此结构） */
export interface Session {
    /** 会话唯一 ID（UUID） */
    id: string;
    // 身份 开发者还是cr者
    botId: string;
    /** 话题 ID：同一话题内所有消息共享；无话题时退化为 rootId 或 messageId */
    threadId: string;
    /** 会话 ID：单聊/群聊的唯一标识 */
    chatId: string;
    /** 负责执行任务的 CLI 引擎 */
    cliId: CliId;
    cliSessionId?: string; // claude 的会话id，可选因为现在存的没有这个字段
    /** 当前状态 */
    status: SessionStatus;
    /** 创建时间（ISO 8601 字符串） */
    createdAt: string;
    /** 最近一次状态变更时间（ISO 8601 字符串） */
    updatedAt: string;
}

/** 定位会话所需的最小消息信息 */
export interface MessageAddress {
    /** 消息唯一 ID */
    messageId: string;
    /** 会话 ID（单聊/群聊） */
    chatId: string;
    /** 话题 ID（话题内消息才有；单聊为空） */
    threadId: string;
    /** 根消息 ID（话题内回复指向话题根消息） */
    rootId: string;
}

/** resolve() 的返回值：会话本体 + 是否本次新建 */
export interface ResolvedSession {
    session: Session;
    isNew: boolean;
}

/** SessionManager 构造参数（均可注入，便于测试） */
export interface SessionManagerOptions {
    /** 时钟注入（测试用），默认 new Date() */
    now?: () => Date;
    /** 会话 ID 生成器（测试用），默认 randomUUID */
    createId?: () => string;
    /** 持久化存储；不传则退化为纯内存模式 */
    store?: SessionStore;
}

/**
 * 合法状态迁移表（状态机核心约束）：
 * creating → active（开始执行）/ closed（准备中被关闭）
 * active   → idle（任务结束）/ closed（被 /close 中止）
 * idle     → active（新任务）/ closed（被 /close 关闭）
 * closed   → 终态，不允许任何迁移
 */
const ALLOWED_TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
    creating: ['active', 'closed'],
    active: ['idle', 'closed'],
    idle: ['active', 'closed'],
    closed: [],
};

/**
 * 计算"话题 ID"：优先 threadId，其次 rootId，最后退化为 messageId。
 * 飞书里一个话题 = 一条业务任务，话题粒度决定了会话的归属。
 * （threadId 与 rootId 通常同时存在，取其中一个即可。）
 */
function topicIdOf(message: MessageAddress): string {
    return message.threadId || message.rootId || message.messageId;
}

/** 会话在内存 Map 中的键：chatId + ":" + topicId，保证一个话题最多一个会话 */
// 以前只要群和话题相同，程序就认为是同一个会话。现在 botId 也参与计算，开发助手和审查助手即使出现在同一话题里，也会得到两个独立会话
function sessionKey(botId: string, chatId: string, threadId: string): string {
    return `${botId}:${chatId}:${threadId}`;
}

/**
 * 会话管理器：内存会话表 + 状态机 + 持久化
 * 设计要点：
 * - 所有会话数据以内存 Map 为准，查询零 IO
 * - 每次变更（新建/迁移）后整体快照落盘，保证重启可恢复
 * - 落盘失败时回滚内存变更，保证内存与磁盘一致
 */
export class SessionManager {
    /** 内存会话表：key = "chatId:topicId"，value = 会话对象 */
    private readonly sessions = new Map<string, Session>();
    private readonly now: () => Date;
    private readonly createId: () => string;
    private readonly store?: SessionStore;

    constructor(options: SessionManagerOptions = {}) {
        this.now = options.now ?? (() => new Date());
        this.createId = options.createId ?? randomUUID;
        this.store = options.store;
    }

    /**
     * 打开会话管理器（异步初始化）：
     * 从 store 加载历史会话并重建内存 Map。
     * 服务重启后能接着上次的话题继续对话。
     * @returns 就绪的 SessionManager 实例
     */
    static async open(options: SessionManagerOptions = {}): Promise<SessionManager> {
        const manager = new SessionManager(options);
        const restored = await options.store?.load() ?? [];
        for (const session of restored) {
            manager.sessions.set(sessionKey(session.botId, session.chatId, session.threadId), session);
        }
        return manager;
    }

    /** 当前内存中的会话总数（用于启动日志） */
    get size(): number {
        return this.sessions.size;
    }

    /** 按会话 ID 查会话（内存线性扫描；会话量小，性能无碍） */
    get(sessionId: string): Session | undefined {
        return [...this.sessions.values()].find((session) => session.id === sessionId);
    }

    /**
     * 根据消息定位会话（核心方法）：
     * 1. 按 "chatId:topicId" 查内存表，命中直接复用（isNew=false）
     * 2. 未命中则新建会话（status=creating）并立即落盘；
     *    首次写盘失败则回滚删除内存中的新会话，保证"磁盘为准"，
     *    下次消息到来会重新创建
     * @returns { session, isNew }：isNew=true 表示本次消息创建了新会话
     */
    async resolve(
        message: MessageAddress,
        cliId: CliId = 'claude',
        botId = 'default'
    ): Promise<ResolvedSession> {
        const threadId = topicIdOf(message);
        const key = sessionKey(botId, message.chatId, threadId);
        const existing = this.sessions.get(key);
        if (existing) return { session: existing, isNew: false };

        const now = this.now().toISOString();
        const session: Session = {
            id: this.createId(),
            botId,
            threadId,
            chatId: message.chatId,
            cliId,
            status: 'creating',
            createdAt: now,
            updatedAt: now,
        };
        this.sessions.set(key, session);
        try {
            await this.persist();
        } catch (error) {
            // 首次写盘失败：从内存摘除，下次消息会重新创建
            if (this.sessions.get(key) === session) this.sessions.delete(key);
            throw error;
        }
        return { session, isNew: true };
    }

    /**
     * 会话状态迁移：
     * 1. 校验会话存在 + 迁移合法（见 ALLOWED_TRANSITIONS），非法直接抛错
     * 2. 更新 status 与 updatedAt，写回内存
     * 3. 落盘；失败则回滚内存到旧状态，保持内存与磁盘一致
     * @returns 迁移后的最新会话对象
     */
    async transition(sessionId: string, nextStatus: SessionStatus): Promise<Session> {
        const current = this.get(sessionId);
        if (!current) throw new Error(`会话不存在: ${sessionId}`);
        if (!ALLOWED_TRANSITIONS[current.status].includes(nextStatus)) {
            throw new Error(`会话 ${current.status} 不能切换到 ${nextStatus}`);
        }

        const updated: Session = {
            ...current,
            status: nextStatus,
            updatedAt: this.now().toISOString(),
        };
        const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
        this.sessions.set(key, updated);
        try {
            await this.persist();
        } catch (error) {
            // 落盘失败：回滚为旧状态
            if (this.sessions.get(key) === updated) this.sessions.set(key, current);
            throw error;
        }
        return updated;
    }

    /** 将内存中的全部会话快照交给 store 落盘（整体覆盖写） */
    private async persist(): Promise<void> {
        await this.store?.save([...this.sessions.values()]);
    }


    async setCliSessionId(
        sessionId: string, // agentos 的会话id
        cliSessionId: string, // claude 的会话id
    ): Promise<Session> {
        const current = this.get(sessionId);
        if (!current) throw new Error(`会话不存在: ${sessionId}`);
        if (!cliSessionId) throw new Error("CLI 会话 ID 不能为空");

        const updated: Session = {
            ...current,
            cliSessionId,
            updatedAt: this.now().toISOString(),
        };
        const key = sessionKey(updated.botId, updated.chatId, updated.threadId);
        this.sessions.set(key, updated);

        try {
            await this.persist();
        } catch (error) {
            // 落盘失败：回滚为旧状态, 避免磁盘没有clisessionid
            if (this.sessions.get(key) === updated) this.sessions.set(key, current);
            throw error;
        }

        return updated;
    }

}
