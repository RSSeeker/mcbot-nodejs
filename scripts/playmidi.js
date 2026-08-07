'use strict';

/**
 * ⚠️ 仅 Weeaxe 服务器（mc.weeaxe.cn）可用：依赖服务器钢琴插件（/piano keyboard unicode + tab_complete 符号触发）
 * MIDI 直读播放脚本（无需先转 NBS）
 *
 * 解析 MIDI → 按时间轴实时把音符发给服务器钢琴插件（tab_complete + Unicode 字符）
 * 与 playnbs 同一发声机制，但直接播放 .mid，省去中间转换。
 *
 * 用法:
 *   **run playmidi <歌曲.mid> [速度] [模式]    播放（速度 0.25-4，默认 1）
 *   **run playmidi stop                         停止
 *   **run playmidi list                         列出 midi/ 目录下的文件
 *
 * 模式（第三参数）:
 *   pitch（默认）: 按音高六八度分配乐器——低音区贝斯、标准区立琴、高音区长笛/铃铛
 *   auto: 按轨道分配——一条轨道一个乐器
 *   0-15: 固定乐器
 *
 * 注意:
 *   - MIDI 音符无时长概念，note_off 忽略（与 NBS 一致，触发一声）
 *   - 实体 key 折叠到音符盒可发声范围（33-57）
 *   - 开头静音自动裁剪
 */

const fs = require('fs');
const path = require('path');
// 强制重载共用模块（server.js 只清理脚本自身的缓存，依赖模块需要手动清）
const midiCommonPath = require.resolve('./lib/midi_common');
delete require.cache[midiCommonPath];
const midiCommon = require(midiCommonPath);

const MIDI_DIR = path.resolve(__dirname, '..', 'midi');
const FLAG_KEY = 'playmidi';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

// 构建播放时间轴：tempo 感知，返回 { timeline, tempoChanges }
function buildTimeline(midiBuf, speed, instMode = 'auto') {
    const smf = midiCommon.parseSMF(midiBuf);
    const division = smf.division;

    const tempoEvents = [];
    const allNotes = [];
    smf.tracks.forEach((events) => {
        const trackInst = instMode === 'pitch' ? undefined : midiCommon.pickTrackInstrument(events);
        for (const ev of events) {
            if (ev.type === 'meta' && ev.metaType === 0x51 && ev.data.length >= 3) {
                const t = (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2];
                // 非法 tempo（0 或极端值）兜底为默认 120BPM
                tempoEvents.push({ tick: ev.tick, tempo: (t > 0 && t <= 10000000) ? t : 500000 });
            } else if (ev.type === 'note') {
                allNotes.push({ ...ev, trackInst });
            }
        }
    });
    if (allNotes.length === 0) throw new Error('MIDI 里没有音符事件');

    // 同 tick 的 tempo 事件去重（保留最后一个）：多轨 MIDI 常见同一 tick 重复变速
    const tempoByTick = new Map();
    for (const te of tempoEvents) tempoByTick.set(te.tick, te.tempo);
    const uniqueTempi = [...tempoByTick].map(([tick, tempo]) => ({ tick, tempo }));

    // tick → 秒（tempo 分段累计）
    const ordered = [...uniqueTempi, ...allNotes].sort((a, b) => a.tick - b.tick);
    let seconds = 0, lastTick = 0, tempo = 500000;
    const tempoChanges = [{ tick: 0, seconds: 0, tempo: 500000 }];
    for (const ev of ordered) {
        seconds += (ev.tick - lastTick) / division * (tempo / 1e6);
        lastTick = ev.tick;
        if (ev.tempo !== undefined) {
            tempo = ev.tempo;
            tempoChanges.push({ tick: ev.tick, seconds, tempo });
        } else {
            ev.seconds = seconds;
        }
    }

    // 裁剪开头静音 + 应用速度倍率
    const firstSec = Math.min(...allNotes.map(n => n.seconds));
    const timeline = allNotes.map(n => ({
        seconds: (n.seconds - firstSec) / speed,
        channel: n.channel,
        pitch: n.pitch,
        velocity: n.velocity,
        trackInst: n.trackInst,
    }));
    timeline.sort((a, b) => a.seconds - b.seconds);
    return { timeline, tempoChanges };
}

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        reply('已请求停止播放');
        return;
    }
    if (sub === 'list') {
        if (!fs.existsSync(MIDI_DIR)) {
            reply('midi/ 目录不存在（把 .mid 文件放进去）');
            return;
        }
        const files = fs.readdirSync(MIDI_DIR).filter(f => /\.midi?$/i.test(f));
        reply(files.length ? 'midi/ 下的文件: ' + files.join(' | ') : 'midi/ 下没有 .mid 文件');
        return;
    }
    if (!sub || sub === 'help') {
reply('用法: **run playmidi <歌曲.mid> [速度] [模式] | stop | list（模式: pitch默认/auto/0-15）');
        return;
    }

    const fileName = sub;
    const speed = args[1] ? parseFloat(args[1]) : 1;
    if (isNaN(speed) || speed < 0.25 || speed > 4) {
        reply('速度范围: 0.25-4（1 = 原速）');
        return;
    }
    let instMode = 'pitch'; // 默认 pitch=按音高六八度分配 | auto=按轨道 | number=固定乐器
    let fixedInstrument;
    if (args[2] !== undefined) {
        if (args[2].toLowerCase() === 'pitch') {
            instMode = 'pitch';
        } else if (args[2].toLowerCase() !== 'auto') {
            fixedInstrument = parseInt(args[2], 10);
            if (isNaN(fixedInstrument) || fixedInstrument < 0 || fixedInstrument > 15) {
                reply('乐器模式: pitch=按音高六八度分配（默认） | auto=按轨道 | 0-15=固定乐器');
                return;
            }
        }
    }

    if (!fs.existsSync(MIDI_DIR)) fs.mkdirSync(MIDI_DIR, { recursive: true });
    let target = path.resolve(MIDI_DIR, fileName);
    if (!target.startsWith(MIDI_DIR + path.sep)) {
        reply('非法路径，只允许 midi/ 目录内的文件');
        return;
    }
    if (!fs.existsSync(target) && !/\.midi?$/i.test(target)) {
        const alt = target + '.mid';
        if (fs.existsSync(alt)) target = alt;
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        reply(`文件不存在: midi/${fileName}（可用 **run playmidi list 查看）`);
        return;
    }

    let timeline, tempoChanges;
    try {
        ({ timeline, tempoChanges } = buildTimeline(fs.readFileSync(target), speed, instMode));
    } catch (err) {
        reply(`解析失败: ${err.message}`);
        return;
    }
    const realChanges = tempoChanges ? tempoChanges.filter(c => c.tick > 0) : [];
    if (realChanges.length > 0) {
        log('info', `[playmidi] 检测到 ${realChanges.length} 处变速（${realChanges.map(c => (60e6 / c.tempo).toFixed(0) + 'BPM').join(' -> ')}）`);
    }

    // 同时刻同乐器同音高的重复音符去重
    const seen = new Set();
    timeline = timeline.filter((n) => {
        const resolved = midiCommon.resolveNote(n.channel, n.pitch, instMode, fixedInstrument, n.trackInst);
        const key = resolved.key;
        const inst = resolved.instrument;
        const k = Math.round(n.seconds * 1000) + ':' + inst + ':' + key;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    const duration = timeline.length ? timeline[timeline.length - 1].seconds : 0;
    reply(`开始播放 ${path.basename(target)}（${timeline.length} 个音符，预计 ${duration.toFixed(1)}s，**run playmidi stop 停止）`);
    try { bot.chat('/piano keyboard unicode'); } catch (e) {}

    bot.__scriptFlags[FLAG_KEY] = false;
    const start = performance.now();
    let transId = 1;
    let i = 0;
    let played = 0;
    let tempoLogIdx = 0;

    while (!bot.__scriptFlags[FLAG_KEY] && i < timeline.length) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止播放');
            break;
        }
        const now = performance.now() - start;
        const targetSec = timeline[i].seconds;
        if (now < targetSec * 1000) {
            await sleep(targetSec * 1000 - now);
        }
        // 发送当前时间点的所有音符
        while (i < timeline.length && timeline[i].seconds <= targetSec + 0.002) {
            const n = timeline[i++];
        const resolved = midiCommon.resolveNote(n.channel, n.pitch, instMode, fixedInstrument, n.trackInst);
        const key = resolved.key;
        const inst = resolved.instrument;
            const ch = midiCommon.charForNote(inst, key);
            if (ch) {
                try {
                    bot._client.write('tab_complete', { transactionId: transId++, text: '/// ' + ch });
                    played++;
                } catch (e) {}
                // 同时刻多个音符分开发送，避免突发把服务器插件打崩
                await sleep(15);
            }
        }
        // 经过变速点：记录实际变速时刻
        while (tempoLogIdx < tempoChanges.length && tempoChanges[tempoLogIdx].seconds <= targetSec) {
            const tc = tempoChanges[tempoLogIdx++];
            if (tc.tick > 0) log('info', `[playmidi] 变速 ${(60e6 / tc.tempo).toFixed(0)} BPM @ ${tc.seconds.toFixed(1)}s`);
        }
    }

    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`播放结束（共发出 ${played} 个音符）`);
};
