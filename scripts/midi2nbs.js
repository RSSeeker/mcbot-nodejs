'use strict';

/**
 * MIDI → NBS 转换脚本（自含 SMF 解析器，无需额外依赖）
 *
 * 用法:
 *   **run midi2nbs <歌曲.mid> [曲速tick/s] [模式]   转换（默认曲速 10 tick/s）
 *   **run midi2nbs convert <歌曲.mid> [曲速] [模式]  同上
 *   **run midi2nbs list                              列出 midi/ 目录下的文件
 *
 * 模式（第三参数）:
 *   pitch（默认）: 按音高六八度分配乐器——低音区贝斯、标准区立琴、高音区长笛/铃铛，总音域约 F#1-F#7（6 个八度）
 *   auto: 按轨道分配——一条轨道一个乐器（优先 program，否则按中位音高）
 *   0-15: 固定乐器
 *
 * 输入: 项目根目录 midi/ 文件夹下的 .mid 文件
 * 输出: songs/<同名>.nbs（可直接用 **run playnbs 播放）
 *
 * 转换规则:
 *   - 实体 key 折叠到音符盒可发声范围（33-57，F#3~F#5）
 *   - 鼓通道按鼓音高映射
 *   - 同 tick 同乐器同音高重复去重；同 tick 多音符自动分层
 *   - 开头静音自动裁剪；MIDI 变速（tempo 事件）按时间轴正确换算
 */

const fs = require('fs');
const path = require('path');
// 强制重载共用模块（server.js 只清理脚本自身的缓存，依赖模块需要手动清）
const midiCommonPath = require.resolve('./lib/midi_common');
delete require.cache[midiCommonPath];
const midiCommon = require(midiCommonPath);

const MIDI_DIR = path.resolve(__dirname, '..', 'midi');
const SONG_DIR = path.resolve(__dirname, '..', 'songs');

function midiToNbs(midiBuf, nbsTempo = 10, instMode = 'auto', fixedInstrument) {
    const smf = midiCommon.parseSMF(midiBuf);
    const division = smf.division;

    // 1. 收集 tempo 变化和音符事件
    const tempoEvents = [];
    const allNotes = [];
    smf.tracks.forEach((events, trackIdx) => {
        // 按轨道选一个乐器（pitch 模式则为 undefined，音符再按音高分段）
        const trackInst = instMode === 'pitch' ? undefined : midiCommon.pickTrackInstrument(events);
        for (const ev of events) {
            if (ev.type === 'meta' && ev.metaType === 0x51 && ev.data.length >= 3) {
                tempoEvents.push({ tick: ev.tick, type: 'tempo', tempo: (ev.data[0] << 16) | (ev.data[1] << 8) | ev.data[2] });
            } else if (ev.type === 'note') {
                allNotes.push({ tick: ev.tick, type: 'note', channel: ev.channel, pitch: ev.pitch, velocity: ev.velocity, track: trackIdx, trackInst });
            }
        }
    });
    if (allNotes.length === 0) throw new Error('MIDI 里没有音符事件');

    // 2. tick → 秒（tempo 分段累计）
    const ordered = [...tempoEvents, ...allNotes].sort((a, b) => a.tick - b.tick);
    let seconds = 0, lastTick = 0, tempo = 500000;
    for (const ev of ordered) {
        seconds += (ev.tick - lastTick) / division * (tempo / 1e6);
        lastTick = ev.tick;
        if (ev.type === 'tempo') tempo = ev.tempo;
        else ev.seconds = seconds;
    }

    // 3. 裁剪开头静音
    const firstSec = Math.min(...allNotes.map(n => n.seconds));
    for (const n of allNotes) n.seconds -= firstSec;

    // 4. 构建 NBS
    const { Song, Note, toArrayBuffer } = require('@nbsjs/core');
    const song = new Song();
    song.setTimePerTick(1000 / nbsTempo);

    const tickGroups = new Map(); // tick -> [{instrument, key, velocity}]
    const seen = new Set(); // 去重：tick+instrument+key
    let noteCount = 0;

    for (const n of allNotes) {
        // 统一解析：鼓按鼓映射；pitch 模式走六八度分配；auto/固定走轨道/固定乐器
        const resolved = midiCommon.resolveNote(n.channel, n.pitch, instMode, fixedInstrument, n.trackInst);
        const key = resolved.key;
        const instrument = resolved.instrument;
        const tick = Math.max(0, Math.round(n.seconds * nbsTempo));
        const velocity = Math.max(1, Math.min(100, Math.round(n.velocity / 127 * 100)));

        const dedupKey = tick + ':' + instrument + ':' + key;
        if (seen.has(dedupKey)) continue; // 重复音符只保留一个
        seen.add(dedupKey);
        if (!tickGroups.has(tick)) tickGroups.set(tick, []);
        tickGroups.get(tick).push({ instrument, key, velocity });
        noteCount++;
    }

    // NBS 一个层在同一 tick 只能放一个音符：同 tick 的多个音符分配到不同层，避免互相覆盖
    const layers = [];
    const MAX_LAYERS = 40;
    for (const [tick, group] of tickGroups) {
        group.forEach((note, idx) => {
            let layer = layers[idx];
            if (!layer) {
                if (layers.length >= MAX_LAYERS) layer = layers[0]; // 极端密集时合并到第 0 层
                else {
                    layer = song.layers.create();
                    layers[idx] = layer;
                }
            }
            layer.notes.set(tick, new Note(note.instrument, { key: note.key, velocity: note.velocity }));
        });
    }

    const buf = Buffer.from(toArrayBuffer(song));
    return { buffer: buf, noteCount, layers: layers.filter(Boolean).length, durationSec: seconds, nbsTempo };
}

// ─────────── 脚本入口 ───────────

module.exports = async function (bot, context) {
    const { reply, args, log } = context;
    const sub = (args[0] || '').toLowerCase();

    if (sub === 'list') {
        if (!fs.existsSync(MIDI_DIR)) {
            reply('midi/ 目录不存在（把 .mid 文件放进去）');
            return;
        }
        const files = fs.readdirSync(MIDI_DIR).filter(f => /\.midi?$/i.test(f));
        reply(files.length ? 'midi/ 下的文件: ' + files.join(' | ') : 'midi/ 下没有 .mid 文件');
        return;
    }

    let fileName;
    let nbsTempo = 10;
    let instMode = 'pitch'; // 默认 pitch=按音高六八度分配 | auto=按轨道 | number=固定乐器
    let fixedInstrument;
    if (sub === 'convert') {
        fileName = args[1];
        nbsTempo = args[2] ? parseInt(args[2], 10) : 10;
        if (args[3] !== undefined) {
            if (args[3].toLowerCase() === 'pitch') instMode = 'pitch';
            else if (args[3].toLowerCase() !== 'auto') fixedInstrument = parseInt(args[3], 10);
        }
    } else {
        fileName = sub;
        nbsTempo = args[1] ? parseInt(args[1], 10) : 10;
        if (args[2] !== undefined) {
            if (args[2].toLowerCase() === 'pitch') instMode = 'pitch';
            else if (args[2].toLowerCase() !== 'auto') fixedInstrument = parseInt(args[2], 10);
        }
    }
    if (!fileName || fileName === 'help') {
reply('用法: **run midi2nbs <歌曲.mid> [曲速] [模式] | convert <歌曲.mid> [曲速] [模式] | list（模式: pitch默认/auto/0-15）');
        return;
    }
    if (isNaN(nbsTempo) || nbsTempo < 1 || nbsTempo > 100) {
        reply('曲速范围: 1-100 tick/秒');
        return;
    }
    if (fixedInstrument !== undefined && (isNaN(fixedInstrument) || fixedInstrument < 0 || fixedInstrument > 15)) {
        reply('乐器模式: pitch=按音高六八度分配（默认） | auto=按轨道 | 0-15=固定乐器');
        return;
    }

    // 路径安全：只允许 midi/ 目录内
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
        reply(`文件不存在: midi/${fileName}（可用 **run midi2nbs list 查看）`);
        return;
    }

    reply(`正在转换 ${path.basename(target)} ...`);
    try {
        const midiBuf = fs.readFileSync(target);
        const result = midiToNbs(midiBuf, nbsTempo, instMode, fixedInstrument);
        if (!fs.existsSync(SONG_DIR)) fs.mkdirSync(SONG_DIR, { recursive: true });
        const outName = path.basename(target).replace(/\.midi?$/i, '') + '.nbs';
        const outPath = path.join(SONG_DIR, outName);
        fs.writeFileSync(outPath, result.buffer);
        reply(`转换完成: songs/${outName}`);
        reply(`音符 ${result.noteCount} 个 | ${result.layers} 层 | 时长 ${result.durationSec.toFixed(1)}s | 曲速 ${result.nbsTempo} tick/s`);
        reply(`播放: **run playnbs ${outName}`);
    } catch (err) {
        log('error', `MIDI 转换失败: ${err.message}`);
        reply(`转换失败: ${err.message}`);
    }
};
