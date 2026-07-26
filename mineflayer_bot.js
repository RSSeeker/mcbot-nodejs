/**
 * mineflayer_bot.js — Minecraft 协议代理层
 * ==========================================
 * 使用 Mineflayer 处理所有 MC 协议细节，
 * 通过 stdin/stdout JSON Lines 与 Python 控制层通信。
 *
 * 用法: node mineflayer_bot.js <host> <port> <username>
 */

const mineflayer = require('mineflayer');

// ── 解析命令行参数 ──
const [host, port, username] = process.argv.slice(2);
if (!host || !port || !username) {
    console.error('用法: node mineflayer_bot.js <host> <port> <username>');
    process.exit(1);
}

// ── JSON 输出辅助 ──
function sendJson(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

function logInfo(msg) {
    process.stderr.write(`[mineflayer] ${msg}\n`);
}

// ── 创建 Bot ──
let autoLoginDone = false;

const bot = mineflayer.createBot({
    host: host,
    port: parseInt(port),
    username: username,
    auth: 'offline',
    version: '1.21.4',
    hideErrors: false,
});

// ═══════════════════════════════════
//  事件 → Python
// ═══════════════════════════════════

bot.on('login', () => {
    logInfo(`已登录: ${username}`);
    sendJson({
        type: 'login',
        status: 'success',
        username: username,
        host: host,
    });
});

// 所有消息（JSON 格式）
bot.on('message', (jsonMsg, position) => {
    try {
        const raw = JSON.stringify(jsonMsg);
        // 过滤掉自己的加入消息避免无限循环
        sendJson({
            type: 'message',
            json: jsonMsg,
            raw: raw,
            position: position,
        });
    } catch (e) {
        // 忽略序列化错误
    }
});

// 纯文本消息（兜底）
bot.on('messagestr', (text, msg, position) => {
    logInfo(`[MSG] ${text}`);
});

// 玩家聊天（Mineflayer 识别的标准聊天格式）
bot.on('chat', (playerName, message) => {
    // 过滤自己的消息
    if (playerName === username) return;
    sendJson({
        type: 'chat',
        player: playerName,
        message: message,
    });
});

// 玩家加入/离开
bot.on('playerJoined', (player) => {
    sendJson({ type: 'player_joined', username: player.username });
});

bot.on('playerLeft', (player) => {
    sendJson({ type: 'player_left', username: player.username });
});

// 被踢出
bot.on('kicked', (reason) => {
    const text = typeof reason === 'string' ? reason : JSON.stringify(reason);
    logInfo(`被踢: ${text}`);
    sendJson({ type: 'kicked', reason: text });
    process.exit(0);
});

// 断连
bot.on('end', (reason) => {
    logInfo(`连接断开: ${reason}`);
    sendJson({ type: 'end', reason: reason });
    process.exit(0);
});

// 错误
bot.on('error', (err) => {
    logInfo(`错误: ${err.message}`);
    sendJson({ type: 'error', message: err.message });
});

// 出生完成
bot.on('spawn', () => {
    logInfo('Bot 已出生');
    sendJson({ type: 'spawn' });

    // 自动登录
    if (!autoLoginDone) {
        autoLoginDone = true;
        setTimeout(() => {
            bot.chat('/login 11111');
            logInfo('已自动执行 /login');
        }, 1000);
    }
});

// ═══════════════════════════════════
//  Python 指令 → Mineflayer
// ═══════════════════════════════════

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
    let data;
    try {
        data = JSON.parse(line);
    } catch (e) {
        logInfo(`无效 JSON: ${line}`);
        return;
    }

    try {
        switch (data.type) {
            case 'chat':
                bot.chat(data.message);
                logInfo(`[Chat] ${data.message}`);
                break;

            case 'command':
                bot.chat('/' + data.command);
                logInfo(`[Cmd] /${data.command}`);
                break;

            case 'suggestion':
                // Command Suggestions Response (MC 1.21.4 serverbound)
                bot._client.write('command_suggestion', {
                    id: data.id,
                    suggestions: [data.text],
                });
                break;

            case 'respawn':
                bot._client.write('client_command', {
                    actionId: 0, // PERFORM_RESPAWN
                });
                logInfo('[Respawn]');
                break;

            case 'quit':
                bot.quit();
                process.exit(0);
                break;

            default:
                logInfo(`未知指令类型: ${data.type}`);
        }
    } catch (e) {
        logInfo(`执行指令失败: ${e.message}`);
    }
});

rl.on('close', () => {
    logInfo('stdin 关闭，退出');
    bot.quit();
    process.exit(0);
});
