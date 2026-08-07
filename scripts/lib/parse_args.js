'use strict';

// 统一参数解析：所有脚本的参数之间用 | 分隔（参数内部可含空格）
// 例: **run playmidi My Song | 2 | pitch
// server.js 先把整条命令按空白切分传入 args，这里拼回原始文本再按 | 拆分，
// 空段保留（用于省略中间参数，如 "song | | pitch" 表示速度用默认值）
function parseArgs(args) {
    const joined = (args || []).join(' ').trim();
    if (!joined) return [];
    return joined.split('|').map((s) => s.trim());
}

module.exports = parseArgs;
