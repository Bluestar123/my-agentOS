import {
    spawn,
    type ChildProcess,
    type ChildProcessByStdio,
    type SpawnOptions,
} from "node:child_process";
import type { Readable, Writable } from "node:stream";

export function killCli(
    child: ChildProcess,
    signal: NodeJS.Signals = "SIGTERM",
): void {
    if (!child.pid) return void child.kill(signal);
    if (process.platform !== "win32") return void child.kill(signal);
    // taskkill /T 把 cmd 连同它下面的 claude.exe/codex.exe 整棵进程树一起杀
    spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
    });
}

export function spawnCli(
    command: string,
    args: string[],
    options: SpawnOptions & { stdio: ["ignore", "pipe", "pipe"] },
): ChildProcessByStdio<null, Readable, Readable>;
export function spawnCli(
    command: string,
    args: string[],
    options: SpawnOptions & { stdio: ["pipe", "pipe", "pipe"] },
): ChildProcessByStdio<Writable, Readable, Readable>;

// 启动子进程执行命令
export function spawnCli(
    command: string,
    args: string[],
    options: SpawnOptions & { stdio: SpawnOptions["stdio"] },
): ChildProcessByStdio<any, any, any> {
    if (process.platform !== "win32") {
        return spawn(command, args, options);
    }
    return spawn(command, args, {
        ...options,
        shell: true, // window cmd 形式存在，必须配置 shell: true，才能找到并启用
        windowsHide: true,
    });
}
