/**
 * {
  "text": "@_user_1 帮我看看 @_user_2 的代码",
  "mentions": [
    { "key": "@_user_1", "name": "MyBot", "id": { "open_id": "ou_aaa..." } },
    { "key": "@_user_2", "name": "运营专家", "id": { "open_id": "ou_bbb..." } }
  ]
}

 */



export interface Mention {
    key: string; // '@_user_1'
    name: string; // 显示名，如 'MyBot'
    openId: string; // 'ou_xxx'
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

/** 把 @_user_N 占位符替换成 @显示名。 */
export function resolveMentions(text: string, mentions: Mention[]): string {
    let resolved = text;
    for (const m of mentions) {
        resolved = resolved.replaceAll(m.key, `@${m.name}`);
    }
    return resolved.trim();
}




/** 从消息 content 中提取资源 key（image_key / file_key）。 */
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

    if (messageType === "image" && parsed.image_key) {
        resources.push({ type: "image", key: parsed.image_key });
    }
    if (messageType === "file" && parsed.file_key) {
        resources.push({
            type: "file",
            key: parsed.file_key,
            fileName: parsed.file_name,
        });
    }
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
