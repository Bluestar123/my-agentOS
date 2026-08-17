/**
 * 消息解析工具：负责把飞书原始消息加工成 AI 能直接理解的内容
 *
 * 飞书消息里的 @ 提及在文本中只是占位符（如 "@_user_1"），
 * 真实用户信息位于事件载荷的 mentions 数组中，需要互相映射还原。
 *
 * 本模块提供三个能力：
 * - parseMentions：从飞书原始 mentions 提取结构化信息
 * - resolveMentions：把文本中的 @_user_N 占位符还原成 @显示名
 * - extractResourceKeys：从消息 content 提取图片/文件资源 key（供下载）
 *
 * 飞书 mentions 原始结构示例：
 * {
 *   "text": "@_user_1 帮我看看 @_user_2 的代码",
 *   "mentions": [
 *     { "key": "@_user_1", "name": "MyBot", "id": { "open_id": "ou_aaa..." } },
 *     { "key": "@_user_2", "name": "运营专家", "id": { "open_id": "ou_bbb..." } }
 *   ]
 * }
 */

/** 一条结构化提及信息 */
export interface Mention {
    key: string; // '@_user_1'（消息文本中的占位符，可被 replaceAll 替换）
    name: string; // 显示名，如 'MyBot'
    openId: string; // 'ou_xxx'（飞书用户唯一 ID，@真人时要用它）
}

/** 从事件的 mentions 数组中提取结构化提及信息。 */
export function parseMentions(raw: any[] | undefined): Mention[] {
    if (!raw?.length) return [];
    return raw.map((m) => ({
        key: m.key,
        name: m.name ?? "",
        openId: m.id?.open_id ?? "",
    }));
}

/**
 * 把 @_user_N 占位符替换成 @显示名。
 * 例："帮我看看 @_user_2 的代码" → "帮我看看 @运营专家 的代码"
 * 用途：还原后的文本再喂给 AI，AI 才能看到真正被 @ 的人是谁。
 */
export function resolveMentions(text: string, mentions: Mention[]): string {
    let resolved = text;
    for (const m of mentions) {
        resolved = resolved.replaceAll(m.key, `@${m.name}`);
    }
    return resolved.trim();
}




/**
 * 从消息 content 中提取资源 key（image_key / file_key），供后续下载。
 * 支持三种消息类型：
 * - image：{ "image_key": "img_v3_xxx" }
 * - file：{ "file_key": "file_v3_xxx", "file_name": "report.xlsx" }
 * - post（富文本）：content 为二维数组，遍历取 tag=img 的元素
 * @returns 资源列表，每项含类型（图片/文件）、key、可选的文件名
 */
export function extractResourceKeys(
    messageType: string,
    content: string,
): { type: "image" | "file"; key: string; fileName?: string }[] {
    const parsed = JSON.parse(content);
    const resources: {
        type: "image" | "file";
        key: string;
        fileName?: string;
    }[] = [];

    // 纯图片消息
    if (messageType === "image" && parsed.image_key) {
        resources.push({ type: "image", key: parsed.image_key });
    }
    // 文件消息（带原始文件名）
    if (messageType === "file" && parsed.file_key) {
        resources.push({
            type: "file",
            key: parsed.file_key,
            fileName: parsed.file_name,
        });
    }
    // 富文本消息：正文里可能内嵌图片
    if (messageType === "post") {
        const paragraphs: any[][] = parsed.content ?? [];
        for (const el of paragraphs.flat()) {
            if (el.tag === "img" && el.image_key) {
                resources.push({ type: "image", key: el.image_key });
            }
        }
    }

    return resources;
}
