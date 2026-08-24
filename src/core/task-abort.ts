export interface ActiveRun {
    controller: AbortController; // 中断控制器
    ownerOpenId: string; // 谁有操作权限
    cancelMode?: 'stop' | 'close';
}

export type AbortTaskOutcome =
    | 'stopped'
    | 'already_stopping'
    | 'not_found'
    | 'forbidden';


//任务不存在、操作者不匹配、停止信号已经发出，都不会再次触碰进程；只有检查全部通过，才会调用 abort()
export function requestTaskAbort(
    activeRuns: Map<string, ActiveRun>,
    sessionId: string,
    operatorOpenId: string,
): AbortTaskOutcome {
    const active = activeRuns.get(sessionId);
    if (!active) return 'not_found';
    if (operatorOpenId !== active.ownerOpenId) return 'forbidden';
    if (active.controller.signal.aborted) return 'already_stopping';
    active.cancelMode = 'stop';
    active.controller.abort();
    return 'stopped';
}
