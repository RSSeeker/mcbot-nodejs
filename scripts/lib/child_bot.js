'use strict';

// 子 bot 创建：playnbs / playmidi 共用的多 bot 逻辑
// 同一服务器、offline 模式，先过验证码再注册，然后登录、切 unicode 键盘、传送到主 bot 本体

const CHILD_LOGIN_WAIT = 5000; // 等待出生（spawn）的最长时间

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(target) {
    return target && target._client && !target._client.ended;
}

// 发包频率限制器：每个 bot 每秒最多发 maxPerSec 个 tab_complete 包，
// 防止触发服务端发包频率限制（You are sending too many packets!）被踢
const MAX_PACKETS_PER_SEC = 40;
function makeRateLimiter(maxPerSec = MAX_PACKETS_PER_SEC) {
    let last = 0;
    const interval = 1000 / maxPerSec;
    return async function waitSlot() {
        const now = performance.now();
        // 固定最小间隔（无突发），严格限速
        const wait = interval - (now - last);
        if (wait > 0) await sleep(wait);
        last = performance.now();
    };
}

// 等小号收到匹配的消息（用于确认注册/登录完成），带超时兜底
function waitChildMessage(child, pattern, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            child.removeListener('message', onMsg);
            child.removeListener('chat', onChat);
            resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        const onMsg = (jsonMsg) => {
            try {
                const text = typeof jsonMsg === 'string' ? jsonMsg : (jsonMsg && jsonMsg.toString ? jsonMsg.toString() : '');
                if (pattern.test(text)) finish();
            } catch (e) {}
        };
        const onChat = (name, msg) => {
            if (pattern.test(String(msg || ''))) finish();
        };
        child.on('message', onMsg);
        child.on('chat', onChat);
    });
}

// 创建子 bot：主名+序号（如 RS_Bot1、RS_Bot2），出生后注册/登录/切键/传送到主 bot
// 返回 child；5 秒内没 spawn 则判定登录失败返回 null
async function createChildBot(bot, index, config, isCancelled = () => false) {
    const mineflayer = require('mineflayer');
    const username = bot.username + index; // 序号命名：主名+序号
    const child = mineflayer.createBot({
        host: config.server.host,
        port: parseInt(config.server.port, 10),
        username,
        auth: 'offline',
        version: String(config.server.version || '1.21.4'),
        hideErrors: true,
    });
    const password = config.bot.password || '';

    // 服务器可能要求先输验证码（/captcha <code>）才能注册
    let captchaSent = false;
    let abandoned = false;
    const handleCaptchaText = (text) => {
        if (!text || captchaSent || abandoned) return;
        const s = String(text);
        // 只响应服务器下发的验证码请求（带“验证码/注册”等语境），
        // 避免把自己发出的 /captcha 回显当成新请求导致死循环
        if (!/captcha/i.test(s) || !/验证码|注册|请使用|请输入|require|register/i.test(s)) return;
        const m = s.match(/\/captcha\s+([A-Za-z0-9]+)/i);
        if (m) {
            captchaSent = true;
            try { child.chat('/captcha ' + m[1]); } catch (e) {}
        }
    };
    child.on('message', (jsonMsg) => {
        try {
            const text = typeof jsonMsg === 'string' ? jsonMsg : (jsonMsg && jsonMsg.toString ? jsonMsg.toString() : '');
            handleCaptchaText(text);
        } catch (e) {}
    });
    child.on('chat', (name, msg) => handleCaptchaText(msg));

    let spawned = false;
    let resolveReady;
    const readyPromise = new Promise((res) => { resolveReady = res; });
    child.on('spawn', () => {
        if (abandoned) return;
        spawned = true;

        // 依次：等验证码 → 注册（等确认） → 登录（等确认） → 切 unicode 键盘 → 传送到主 bot 本体
        const setup = async () => {
            if (abandoned) return;
            try {
                if (password) {
                    child.chat(`/register ${password} ${password}`);
                    // 注册成功或已注册过则继续
                    await waitChildMessage(child, /注册成功|注册完成|已注册|你已经登陆过了/, 2500);
                    if (abandoned) return;
                    child.chat(`/login ${password}`);
                    // 登录成功则继续
                    await waitChildMessage(child, /登录成功|已成功登录|已登录|欢迎回来/, 2500);
                    if (abandoned) return;
                }
                child.chat('/piano keyboard unicode');
                await sleep(600);
                if (abandoned) return;
                // 直接传送到主 bot 本体
                child.chat('/tp ' + bot.username);
            } catch (e) { /* 忽略 */ }
            resolveReady();
        };

        const start = Date.now();
        const waitTimer = setInterval(() => {
            if (abandoned) { clearInterval(waitTimer); return; }
            if (captchaSent || Date.now() - start > 6000) {
                clearInterval(waitTimer);
                // 发出验证码后稍等再注册，保证指令顺序
                setTimeout(() => setup().catch(() => resolveReady()), captchaSent ? 800 : 0);
            }
        }, 200);
    });
    child.on('error', () => {});
    child.on('kicked', () => {});

    // 等待出生（最多 CHILD_LOGIN_WAIT 毫秒；被取消则立即放弃），失败则放弃该小号
    const deadline = Date.now() + CHILD_LOGIN_WAIT;
    while (!spawned && Date.now() < deadline && !isCancelled()) await sleep(100);
    if (!spawned || isCancelled()) {
        // 防止“僵尸小号”晚到连接后继续注册/切键/传送，干扰服务端状态
        abandoned = true;
        try { child.removeAllListeners(); } catch (e) {}
        try { child.end(); } catch (e) {}
        try { child.quit(); } catch (e) {}
        return null;
    }
    // 等注册/登录/传送流程完成（最多 8 秒），确保小号就绪再开始播放
    await Promise.race([readyPromise, sleep(8000)]);
    if (isCancelled()) {
        // 创建期间被停止：退掉刚登录的小号
        abandoned = true;
        try { child.removeAllListeners(); } catch (e) {}
        try { child.quit(); } catch (e) {}
        return null;
    }
    return child;
}

module.exports = { createChildBot, isAlive, waitChildMessage, sleep, makeRateLimiter, MAX_PACKETS_PER_SEC, CHILD_LOGIN_WAIT };
