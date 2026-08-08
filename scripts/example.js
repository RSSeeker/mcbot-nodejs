'use strict';

/**
 * 示例脚本：演示 | 分隔参数怎么用
 *
 * 用法:
 *   **run example | 参数1 | 参数2 | 参数3
 *
 * 所有脚本的参数统一用 | 分隔（参数内部可含空格）。
 * parseArgs 把 server.js 按空白切好的 args 拼回原始文本，再按 | 拆分：
 *   **run example hello | world  -> ['hello', 'world']
 *   **run example My Song | 2    -> ['My Song', '2']
 *   **run example stop           -> ['stop']
 * 空段保留（如 "song | | pitch" 表示中间参数用默认值）。
 */

module.exports = async function (bot, context) {
    const { reply, args, log } = context;

    // 内联 parse_args：参数用 | 分隔（参数内部可含空格）
    function parseArgs(args) {
        const joined = (args || []).join(' ').trim();
        if (!joined) return [];
        return joined.split('|').map((s) => s.trim());
    }

    const params = parseArgs(args);
    reply('示例脚本已运行！参数: ' + (params.join(' | ') || '无'));
    log('info', '示例脚本执行完毕');
};
