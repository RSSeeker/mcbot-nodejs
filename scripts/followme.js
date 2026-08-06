'use strict';

/**
 * 持续跟随玩家：保持在他旁边（带空中避障）
 *
 * - 玩家在地上：用寻路走路跟着
 * - 玩家在天上/高度差大：自动开启创造飞行追上去
 * - 空中追击自带 3D 体素 A* 避障：直线被方块挡住时自动绕行（翻越/侧绕），
 *   直线畅通时直接飞过去；悬停在他旁边并持续追踪高度
 *
 * 用法:
 *   **run followme <玩家名> [距离] [debug]   开始跟随（默认距离 3 格；加 debug 打印移动日志）
 *   **run followme stop              停止
 *
 * 注意:
 *   - 空中飞行仅创造/旁观模式可用
 *   - 避障依赖已加载区块，目标太远（超出视距）时退回直线飞行
 */

const { Vec3 } = require('vec3');
const pathfinder = require('mineflayer-pathfinder');
const fs = require('fs');
const path = require('path');

const FLAG_KEY = 'followme';
// 这些方块不算“地面”（玩家站在上面视为在空中）
const AIR_LIKE = new Set(['air', 'cave_air', 'void_air', 'water', 'lava', 'flowing_water', 'flowing_lava']);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

// 调试日志写入 logs/ 目录（追加模式）
function createDebugFile(fileName) {
    const dir = path.resolve(__dirname, '..', 'logs');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const stream = fs.createWriteStream(path.join(dir, fileName), { flags: 'a' });
    return {
        write(msg) { try { stream.write(msg + '\n'); } catch (e) {} },
        close() { try { stream.end(); } catch (e) {} },
    };
}

// ─────────── 3D 体素 A* 寻路（飞行避障用）───────────

// 方块是否阻挡（没有碰撞盒的视为可通行；未加载区块保守视为阻挡）
function isSolid(bot, pos) {
    const b = bot.blockAt(pos);
    if (!b) return true;
    return b.shapes && b.shapes.length > 0;
}

// bot 是 1 格宽 2 格高：脚底格和头顶格都要可通行
function canOccupy(bot, pos) {
    return !isSolid(bot, pos) && !isSolid(bot, pos.offset(0, 1, 0));
}

// 直线是否畅通（每 0.5 格采样一次）
function lineClear(bot, from, to) {
    const dist = from.distanceTo(to);
    const steps = Math.max(1, Math.ceil(dist / 0.5));
    for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const p = from.plus(to.minus(from).scaled(t));
        if (!canOccupy(bot, p)) return false;
    }
    return true;
}

// 26 方向邻居（含对角）
const DIRS26 = [];
for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            DIRS26.push([dx, dy, dz]);
        }
    }
}

class MinHeap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(v) {
        const a = this.a;
        a.push(v);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p][0] <= a[i][0]) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }
    pop() {
        const a = this.a;
        if (a.length === 1) return a.pop();
        const top = a[0];
        a[0] = a.pop();
        let i = 0;
        for (;;) {
            const l = i * 2 + 1, r = l + 1;
            let m = i;
            if (l < a.length && a[l][0] < a[m][0]) m = l;
            if (r < a.length && a[r][0] < a[m][0]) m = r;
            if (m === i) break;
            [a[m], a[i]] = [a[i], a[m]];
            i = m;
        }
        return top;
    }
}

function keyOf(x, y, z) {
    return x + ',' + y + ',' + z;
}

// A*：在 start/goal 围成的盒子里搜索 3D 可行路径，返回路径点数组（不含起点），找不到返回 null
function aStar3D(bot, start, goal) {
    const sx = Math.floor(start.x), sy = Math.floor(start.y), sz = Math.floor(start.z);
    const gx = Math.floor(goal.x), gy = Math.floor(goal.y), gz = Math.floor(goal.z);

    const margin = 8;
    const minX = Math.min(sx, gx) - margin, maxX = Math.max(sx, gx) + margin;
    const minZ = Math.min(sz, gz) - margin, maxZ = Math.max(sz, gz) + margin;
    const worldMinY = bot.game && Number.isFinite(bot.game.minY) ? bot.game.minY : -64;
    const worldMaxY = bot.game && Number.isFinite(bot.game.height) ? bot.game.minY + bot.game.height : 320;
    const minY = Math.max(worldMinY, Math.min(sy, gy) - margin);
    const maxY = Math.min(worldMaxY, Math.max(sy, gy) + margin);

    // 任一轴跨度太大直接放弃（超远目标交给简单绕行/直线飞行，避免超大搜索卡死）
    const SPAN_LIMIT = 80;
    if (maxX - minX > SPAN_LIMIT || maxY - minY > SPAN_LIMIT || maxZ - minZ > SPAN_LIMIT) return null;
    const cells = (maxX - minX + 1) * (maxY - minY + 1) * (maxZ - minZ + 1);
    if (cells > 250000) return null;

    const startKey = keyOf(sx, sy, sz);
    const goalKey = keyOf(gx, gy, gz);
    const gScore = new Map([[startKey, 0]]);
    const fScore = new Map();
    const cameFrom = new Map();
    const closed = new Set();
    const open = new MinHeap();

    const h = (x, y, z) => Math.sqrt((x - gx) ** 2 + (y - gy) ** 2 + (z - gz) ** 2);
    fScore.set(startKey, h(sx, sy, sz));
    open.push([fScore.get(startKey), startKey]);

    while (open.size > 0) {
        const [, key] = open.pop();
        if (closed.has(key)) continue;
        closed.add(key);
        if (key === goalKey) {
            const path = [];
            let cur = goalKey;
            while (cur !== startKey) {
                const [x, y, z] = cur.split(',').map(Number);
                path.push(new Vec3(x, y, z));
                cur = cameFrom.get(cur);
            }
            path.reverse();
            return path;
        }
        const [x, y, z] = key.split(',').map(Number);
        const g = gScore.get(key);
        for (const d of DIRS26) {
            const nx = x + d[0], ny = y + d[1], nz = z + d[2];
            if (nx < minX || nx > maxX || ny < minY || ny > maxY || nz < minZ || nz > maxZ) continue;
            const nkey = keyOf(nx, ny, nz);
            if (closed.has(nkey)) continue;
            if (!canOccupy(bot, new Vec3(nx, ny, nz))) continue;
            const step = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
            const tentG = g + step;
            if (tentG < (gScore.get(nkey) ?? Infinity)) {
                cameFrom.set(nkey, key);
                gScore.set(nkey, tentG);
                const f = tentG + h(nx, ny, nz);
                fScore.set(nkey, f);
                open.push([f, nkey]);
            }
        }
    }
    return null;
}

// 路径直线化：能直接看到的路径点就跳过中间的
function smoothPath(bot, path, start) {
    const pts = [start.clone().floored(), ...path];
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
        let j = pts.length - 1;
        while (j > i + 1 && !lineClear(bot, pts[i], pts[j])) j--;
        out.push(pts[j]);
        i = j;
    }
    return out.slice(1); // 去掉起点
}

// 简单绕行：先升高若干格再直线飞向目标（翻越矮障碍/山坡），比 A* 便宜很多
function tryClimbDetour(bot, my, goal) {
    for (const dy of [3, 5, 8, 12]) {
        const up = new Vec3(my.x, my.y + dy, my.z);
        if (lineClear(bot, up, goal)) {
            return [up, goal.clone().floored()];
        }
    }
    return null;
}

// 面向目标点水平飞行（垂直速度由比例控制单独处理，避免一上一下抖动）
function flyToward(bot, point) {
    const p = bot.entity.position;
    const dx = point.x - p.x, dy = point.y - p.y, dz = point.z - p.z;
    const horiz = Math.sqrt(dx * dx + dz * dz);
    const yaw = Math.atan2(-dx, -dz);
    // 视线指向目标（yaw 水平、pitch 俯仰），垂直移动由 vy 比例控制
    const pitch = horiz > 0.001 ? Math.atan2(dy, horiz) : (dy > 0 ? Math.PI / 2 : -Math.PI / 2);
    bot.look(yaw, pitch, true);
    bot.setControlState('forward', true);
}

// 逐轴速度函数：每个轴的速度 = 该轴距离的函数（比例 + 上限 + 死区）
function createAxisSpeed(maxMps, k) {
    const DEADBAND = 0.35; // 该轴距离小于此值就停，避免抖动
    return (err) => {
        const abs = Math.abs(err);
        if (abs < DEADBAND) return 0;
        const s = Math.min(maxMps, abs * k);
        return err > 0 ? s : -s;
    };
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};

    if ((args[0] || '').toLowerCase() === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        bot.pathfinder?.stop();
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        reply('已请求停止跟随');
        return;
    }

    const targetName = args[0];
    if (!targetName) {
        reply('用法: **run followme <玩家名> [距离]');
        return;
    }
    const keepDist = args[1] ? parseFloat(args[1]) : 3;
    if (Number.isNaN(keepDist) || keepDist < 1 || keepDist > 16) {
        reply('距离范围: 1-16');
        return;
    }
    const debug = (args[2] || '').toLowerCase() === 'debug';
    const debugFile = debug ? createDebugFile('followme_debug.log') : null;
    if (debugFile) debugFile.write(`=== followme 调试开始 ${new Date().toLocaleString('zh-CN', { hour12: false })} 目标=${targetName} ===`);
    // 监听服务器 position 包：判断位置大跳是否来自服务器修正
    const serverPosListener = debugFile ? (packet) => {
        const p = bot.entity.position;
        const flags = packet && typeof packet.flags === 'object' ? JSON.stringify(packet.flags) : (packet ? packet.flags : '?');
        debugFile.write(`[server_pos] bot_y=${p.y.toFixed(3)} pkt_y=${packet.y} flags=${flags} tel=${packet.teleportId}`);
    } : null;
    if (serverPosListener) bot._client.on('position', serverPosListener);

    if (!isAlive(bot)) {
        reply('Bot 未连接');
        return;
    }

    const gameMode = bot.game ? bot.game.gameMode : '';
    const canFly = gameMode === 'creative' || gameMode === 'spectator';

    // 飞行状态管理（与 server.js 的飞行实现一致）
    let flying = false;
    let flyTimer = null;
    let vx = 0, vy = 0, vz = 0; // 各轴目标速度（格/秒）
    const axisX = createAxisSpeed(10.9, 0.8); // 水平轴：上限原版创造飞行速度
    const axisZ = createAxisSpeed(10.9, 0.8);
    const axisY = createAxisSpeed(3.9, 1.0);  // 垂直轴：上限 3.9

    function enableFly() {
        if (flying) return;
        flying = true;
        try { bot.creative.startFlying(); } catch (e) { log('warn', '开启飞行失败: ' + e.message); }
        try {
            // 完整能力 flags：spectator=0x0f，creative=0x0e（含 allowFlying/creativeMode + flying）
            const flags = gameMode === 'spectator' ? 0x0f : 0x0e;
            bot._abilitiesFlags = flags;
            bot._client.write('abilities', { flags });
        } catch (e) { log('warn', '发送飞行状态失败（仅本地飞行）: ' + e.message); }
        flyTimer = setInterval(() => {
            if (!bot || !bot.entity) return;
            // 不用跳跃/潜行控制垂直，直接按比例速度走（顺带清掉可能的外部跳跃输入）
            bot.setControlState('jump', false);
            bot.setControlState('sneak', false);
            // 已经落地时禁止继续向下压（避免低空和地面碰撞导致的弹跳）
            // 注意：mineflayer 速度单位是 格/tick，不是 格/秒，这里 /20 换算成每秒格数
            const vyTick = (bot.entity.onGround && vy < 0) ? 0 : vy / 20;
            bot.entity.velocity = new Vec3(vx / 20, vyTick, vz / 20);
        }, 25);
        log('info', '已切换为飞行跟随');
    }

    function disableFly() {
        if (!flying) return;
        flying = false;
        if (flyTimer) { clearInterval(flyTimer); flyTimer = null; }
        try { bot.creative.stopFlying(); } catch (e) {}
        try {
            const flags = gameMode === 'spectator' ? 0x0d : 0x0c;
            bot._abilitiesFlags = flags;
            bot._client.write('abilities', { flags });
        } catch (e) {}
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        log('info', '已切换为地面跟随');
    }

    if (!bot.pathfinder) {
        reply('寻路不可用');
        return;
    }
    bot.pathfinder.setMovements(new pathfinder.Movements(bot));
    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`开始持续跟随 ${targetName}（距离 ${keepDist} 格，**run followme stop 停止）`);

    // 空中路径状态
    let flyPath = null;          // 当前避障路径（平滑后，不含起点）
    let flyWpIdx = 0;
    let lastPathTime = 0;
    let lastPathGoal = null;

    // 卡住保护：以 bot 实际位移判断（绕路时距离玩家可能不减，但 bot 一定在动）
    let lastMovePos = null;
    let lastMoveTime = 0;
    let noMoveCount = 0;
    let backoffUntil = 0; // 卡住后退阶段截止时间
    const startTime = Date.now();
    // 目标过远时的 /tp 尝试
    let lastTpTime = 0;
    let tpAttempts = 0;
    let tpWarned = false;
    let lastOfflineLog = 0;
    const TP_INTERVAL = 10000; // 每 10 秒最多尝试一次

    function tryTp(reason) {
        const now = Date.now();
        if (now - lastTpTime < TP_INTERVAL) return;
        lastTpTime = now;
        tpAttempts++;
        log('info', `目标 ${targetName} ${reason}，尝试 /tp（第 ${tpAttempts} 次）`);
        bot.chat('/tp ' + targetName);
    }

    try {
        while (!bot.__scriptFlags[FLAG_KEY]) {
            if (!isAlive(bot)) {
                log('warn', 'Bot 已断开，停止跟随');
                break;
            }

            const player = bot.players[targetName];
            if (!player || !player.entity) {
                bot.pathfinder?.stop();
                bot.setControlState('forward', false);
                bot.setControlState('jump', false);
                bot.setControlState('sneak', false);
                vx = 0; vy = 0; vz = 0;
                if (bot.players[targetName]) {
                    // 在线但不在视距内（实体未加载）→ 尝试传送
                    tryTp('在线但距离过远');
                    if (tpAttempts >= 5 && !tpWarned) {
                        tpWarned = true;
                        log('warn', `多次 /tp 后仍未接近 ${targetName}，可能没有传送权限，继续等待`);
                    }
                } else {
                    // 不在 tab 列表里 → 可能已下线
                    const now = Date.now();
                    if (now - lastOfflineLog > 10000) {
                        lastOfflineLog = now;
                        log('info', `目标 ${targetName} 不在玩家列表（可能已下线），等待其上线`);
                    }
                }
                await sleep(2000);
                continue;
            }

            const anchor = player.entity.position;
            const my = bot.entity.position;
            const dx = anchor.x - my.x;
            const dz = anchor.z - my.z;
            const dy = anchor.y - my.y;
            const horiz = Math.sqrt(dx * dx + dz * dz);
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

            // 实体可见但距离非常远：也定期尝试传送
            if (dist > 120) tryTp(`距离 ${Math.round(dist)} 格过远`);

            const blockBelowPlayer = bot.blockAt(anchor.offset(0, -1, 0));
            const playerInAir = blockBelowPlayer && AIR_LIKE.has(blockBelowPlayer.name);
            const needFly = playerInAir || dy > 1.5 || dy < -2.5;

            // 调试日志：飞行模式下打印移动状态
            if (debug) {
                const t = ((Date.now() - startTime) / 1000).toFixed(1);
                const p = bot.entity.position;
                const av = bot.entity.velocity;
                const line =
                    `[followme] t=${t}s pos=(${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)}) ` +
                    `dst=${dist.toFixed(2)} dy=${dy >= 0 ? '+' : ''}${dy.toFixed(2)} ` +
                    `fly=${flying ? 1 : 0} needFly=${needFly ? 1 : 0} ` +
                    `vx=${vx >= 0 ? '+' : ''}${vx.toFixed(2)} vy=${vy >= 0 ? '+' : ''}${vy.toFixed(2)} vz=${vz >= 0 ? '+' : ''}${vz.toFixed(2)} ` +
                    `av=(${av.x.toFixed(2)},${av.y.toFixed(2)},${av.z.toFixed(2)}) ` +
                    `gnd=${bot.entity.onGround ? 1 : 0} colV=${bot.entity.isCollidedVertically ? 1 : 0} ` +
                    `fwd=${bot.getControlState('forward') ? 1 : 0} jmp=${bot.getControlState('jump') ? 1 : 0} ` +
                    `snk=${bot.getControlState('sneak') ? 1 : 0} ` +
                    `path=${flyPath ? flyPath.length : '-'} ` +
                    `wp=${flyPath && flyWpIdx < flyPath.length ? flyWpIdx + '/' + flyPath.length + ' d' + my.distanceTo(flyPath[flyWpIdx]).toFixed(1) : '-'}`;
                log('info', line);
                if (debugFile) debugFile.write(line);
            }

            if (needFly && canFly) {
                if (!flying) {
                    bot.pathfinder?.stop();
                    enableFly();
                }

                if (dist <= keepDist + 0.5) {
                    // 已在目标旁边：悬停（持续追踪高度）
                    bot.setControlState('forward', false);
                    vx = 0; vz = 0;
                    vy = axisY(dy);
                    noMoveCount = 0;
                    flyPath = null;
                } else {
                    const now = Date.now();
                    const goal = anchor.clone().floored();

                    // 需要重新规划：没路径 / 路径走完 / 目标移动超过 2 格 /
                    // 或路径超过 2 秒但当前路径点还没推进（可能卡住/世界变化）
                    const needRepath = !flyPath || flyWpIdx >= flyPath.length ||
                        (lastPathGoal && lastPathGoal.distanceTo(goal) > 2) ||
                        (now - lastPathTime > 2000 && flyPath && my.distanceTo(flyPath[flyWpIdx]) < 1.2);

                    if (needRepath) {
                        if (lineClear(bot, my, goal)) {
                            flyPath = null; // 直线畅通，直接飞
                        } else {
                            // 先试便宜的“升高再直飞”，不行再上 A*
                            const detour = tryClimbDetour(bot, my, goal);
                            if (detour) {
                                flyPath = detour;
                                log('info', '简单绕行：先升高再直飞');
                            } else {
                                const raw = aStar3D(bot, my, goal);
                                flyPath = raw ? smoothPath(bot, raw, my) : null;
                                if (flyPath) log('info', `规划绕行路径: ${flyPath.length} 个路径点`);
                                else log('warn', '找不到绕行路径，退回直线飞行');
                            }
                        }
                        flyWpIdx = 0;
                        lastPathTime = now;
                        lastPathGoal = goal;
                    }

                    // 卡住检测：3 秒窗口内净位移 < 0.5 视为卡住（忽略来回抖动）
                    if (!lastMovePos) {
                        lastMovePos = my.clone();
                        lastMoveTime = now;
                    } else if (now - lastMoveTime >= 3000) {
                        const net = lastMovePos.distanceTo(my);
                        if (net < 0.5) noMoveCount++;
                        else noMoveCount = 0;
                        lastMovePos = my.clone();
                        lastMoveTime = now;
                    }
                    if (noMoveCount >= 2) {
                        log('warn', '飞行跟随卡住（可能撞到角落/天花板），后退 3 秒重新寻路');
                        flyPath = null;
                        noMoveCount = 0;
                        backoffUntil = Date.now() + 3000;
                        continue;
                    }

                    // 卡住后退阶段：水平远离玩家，垂直不动，避开死角后再重新寻路
                    if (Date.now() < backoffUntil) {
                        const h = Math.hypot(dx, dz);
                        if (h > 0.1) {
                            vx = Math.max(-2.5, Math.min(2.5, -dx / h * 2.5));
                            vz = Math.max(-2.5, Math.min(2.5, -dz / h * 2.5));
                        } else {
                            vx = 0; vz = 0;
                        }
                        vy = 0;
                        bot.setControlState('forward', false);
                        await sleep(300);
                        continue;
                    }

                    // 路径点推进：接近 1.2 格，或已冲过头（离下一个更近）时换下一个
                    if (flyPath && flyWpIdx < flyPath.length) {
                        const cur = flyPath[flyWpIdx];
                        const next = flyPath[flyWpIdx + 1];
                        if (my.distanceTo(cur) < 1.2 || (next && my.distanceTo(next) < my.distanceTo(cur))) {
                            flyWpIdx++;
                        }
                    }

                    if (flyPath && flyWpIdx < flyPath.length) {
                        // 沿避障路径点飞：移动追路径点，但视线始终朝向玩家
                        // （避免爬升时抬头看路径点，视角保持自然）
                        const wp = flyPath[flyWpIdx];
                        vx = axisX(wp.x - my.x);
                        vy = axisY(wp.y - my.y);
                        vz = axisZ(wp.z - my.z);
                        flyToward(bot, anchor);
                    } else {
                        // 直线追玩家：水平停在 keepDist 距离处，垂直追高度
                        const hErr = Math.sqrt(dx * dx + dz * dz);
                        let ex = dx, ez = dz;
                        if (hErr > keepDist) {
                            const scale = (hErr - keepDist) / hErr;
                            ex = dx * scale;
                            ez = dz * scale;
                        } else {
                            ex = 0; ez = 0;
                        }
                        vx = axisX(ex);
                        vz = axisZ(ez);
                        vy = axisY(dy);
                        flyToward(bot, anchor);
                    }
                }
            } else if (needFly && !canFly) {
                log('warn', `目标飞得太高，但当前模式(${gameMode})不能飞行，只能地面跟随`);
                if (flying) disableFly();
                vx = 0; vy = 0; vz = 0;
                flyPath = null;
                try {
                    await bot.pathfinder.goto(new pathfinder.goals.GoalFollow(player.entity, keepDist));
                } catch (err) {
                    await sleep(1000);
                }
            } else {
                if (flying) disableFly();
                vx = 0; vy = 0; vz = 0;
                flyPath = null;
                if (dist > keepDist + 0.5) {
                    try {
                        await bot.pathfinder.goto(new pathfinder.goals.GoalFollow(player.entity, keepDist));
                    } catch (err) {
                        await sleep(1000);
                    }
                } else {
                    bot.pathfinder?.stop();
                }
            }

            await sleep(300);
        }
    } finally {
        if (debugFile) {
            debugFile.write('=== followme 调试结束 ===');
            debugFile.close();
        }
        if (serverPosListener) {
            try { bot._client.removeListener('position', serverPosListener); } catch (e) {}
        }
        if (flying) disableFly();
        vx = 0; vy = 0; vz = 0;
        bot.pathfinder?.stop();
        bot.setControlState('forward', false);
        bot.setControlState('jump', false);
        bot.setControlState('sneak', false);
        bot.__scriptFlags[FLAG_KEY] = false;
    }

    reply('跟随结束');
};
