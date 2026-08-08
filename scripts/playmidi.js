'use strict';

/**
 * ⚠️ 仅 Weeaxe 服务器（mc.weeaxe.cn）可用：依赖服务器钢琴插件（/piano keyboard unicode + tab_complete 符号触发）
 * MIDI 直读播放脚本（无需先转 NBS）
 *
 * 解析 MIDI → 按时间轴实时把音符发给服务器钢琴插件（tab_complete + Unicode 字符）
 * 与 playnbs 同一发声机制，但直接播放 .mid，省去中间转换。
 *
 * 用法:
 *   **run playmidi <歌曲.mid> | [1bot] | <速度> | <模式> | notempo   播放（参数用 | 分隔）
 *   **run playmidi stop                                              停止
 *   **run playmidi list                                              列出 midi/ 目录下的文件
 *
 * 参数（均可省略，用 | 分隔）:
 *   1bot（歌曲名后）: 强制单 bot 演奏，不开小号
 *   速度: 0.25-4，默认 1（原速）
 *   模式: pitch（默认，按音高分配乐器）| auto（按轨道）| 0-15（固定乐器）
 *   notempo: 忽略 MIDI 变速事件，按固定 120BPM 播放
 *
 * 多 bot：与 playnbs 同款——按 100ms 窗口峰值 + 均值计算需要的 bot 数（上限 4），
 * 音符密集时自动开小号分担（验证码 → 注册 → 登录 → 切键盘 → 传送到主 bot）。
 *
 * 注意:
 *   - MIDI 音符无时长概念，note_off 忽略（与 NBS 一致，触发一声）
 *   - 实体 key 折叠到音符盒可发声范围（33-57）
 *   - 开头静音自动裁剪
 */

const fs = require('fs');
const path = require('path');
// ===== 内联 parse_args =====
// 统一参数解析：所有脚本的参数之间用 | 分隔（参数内部可含空格）
// 例: **run playmidi My Song | 2 | pitch
// server.js 先把整条命令按空白切分传入 args，这里拼回原始文本再按 | 拆分，
// 空段保留（用于省略中间参数，如 "song | | pitch" 表示速度用默认值）
function parseArgs(args) {
    const joined = (args || []).join(' ').trim();
    if (!joined) return [];
    return joined.split('|').map((s) => s.trim());
}

// ===== 内联 midi_common =====
// MIDI 公用库：SMF 解析 + 乐器/音高映射 + 字符表
// 供 midi2nbs.js / playmidi.js 使用

// 音符盒 key 范围：NBS key 0-83 对应 MIDI 音高 21-104
const MIN_PITCH = 54;
const MAX_PITCH = 78;
// MIDI -> NBS key offset (MIDI 21 = A0 = NBS key 0)
const NBS_KEY_BASE = 21;

// 按音高分段：把 MIDI 音高 0-127 分配到 NBS 乐器
const PITCH_BANDS = [
    { min: 0,   max: 47,  instrument: 1 },  // 低音区 (0-47) -> 贝斯
    { min: 48,  max: 71,  instrument: 0 },  // 标准区 (48-71) -> 竖琴
    { min: 72,  max: 95,  instrument: 6 },  // 高音区 (72-95) -> 长笛
    { min: 96,  max: 127, instrument: 7 },  // 极高音 (96-127) -> 铃铛
];

// 鼓通道：按 MIDI 鼓音高映射到 NBS 乐器
const DRUM_MAP = {
    35: 2, 36: 2,   // 大鼓 -> basedrum
    38: 3, 40: 3,   // 小鼓 -> snare
    42: 4, 44: 4, 46: 4, // 踩镲/镲 -> hat
    49: 9, 51: 9, 57: 9, // 木琴 -> xylophone
    39: 5, 41: 5,   // 手拍/军鼓边 -> guitar
};

// 自含的 SMF 解析器：不依赖外部 MIDI 库，可直接读 .mid 文件

class ByteReader {
    constructor(buf) {
        this.buf = buf;
        this.pos = 0;
    }
    readU8() { return this.buf[this.pos++]; }
    readU16() { const v = this.buf.readUInt16BE(this.pos); this.pos += 2; return v; }
    readU32() { const v = this.buf.readUInt32BE(this.pos); this.pos += 4; return v; }
    readVLQ() {
        let value = 0, b;
        do {
            b = this.readU8();
            value = (value << 7) | (b & 0x7f);
        } while (b & 0x80);
        return value;
    }
    readBytes(n) {
        const s = this.pos;
        this.pos += n;
        return this.buf.slice(s, s + n);
    }
}

function parseSMF(buffer) {
    const r = new ByteReader(buffer);
    if (r.readBytes(4).toString('ascii') !== 'MThd') throw new Error('不是有效的 MIDI 文件：缺少 MThd 头');
    const hdrLen = r.readU32();
    const format = r.readU16();
    const ntrks = r.readU16();
    const division = r.readU16();
    r.pos += hdrLen - 6;
    if (division & 0x8000) throw new Error('不支持 SMPTE 时间码，请使用 PPQ 格式');

    const tracks = [];
    for (let t = 0; t < ntrks; t++) {
        const id = r.readBytes(4).toString('ascii');
        const len = r.readU32();
        const end = r.pos + len;
        if (id !== 'MTrk') { r.pos = end; continue; }

        const events = [];
        let tick = 0;
        let runningStatus = 0;
        while (r.pos < end) {
            tick += r.readVLQ();
            let status = r.readU8();
            if (!(status & 0x80)) {
                r.pos--;
                status = runningStatus;
            } else {
                runningStatus = status;
            }

            if (status === 0xff) {
                const metaType = r.readU8();
                const data = r.readBytes(r.readVLQ());
                events.push({ tick, type: 'meta', metaType, data });
                if (metaType === 0x2f) break;
            } else if ((status & 0xf0) === 0xf0) {
                r.readBytes(r.readVLQ());
            } else {
                const channel = status & 0x0f;
                const kind = status & 0xf0;
                if (kind === 0x80 || kind === 0x90) {
                    const pitch = r.readU8();
                    const velocity = r.readU8();
                    if (kind === 0x90 && velocity > 0) {
                        events.push({ tick, type: 'note', channel, pitch, velocity });
                    }
                } else if (kind === 0xc0) {
                    events.push({ tick, type: 'program', channel, program: r.readU8() });
                } else if (kind === 0xb0) {
                    events.push({ tick, type: 'cc', channel, controller: r.readU8(), value: r.readU8() });
                } else {
                    r.readU8(); r.readU8();
                }
            }
        }
        tracks.push(events);
    }
    return { format, division, tracks };
}

// 把音高折叠到音符盒可发声范围（F#3~F#5，33-57）

function foldPitch(p) {
    while (p < MIN_PITCH) p += 12;
    while (p > MAX_PITCH) p -= 12;
    return p;
}

function instrumentForPitch(p) {
    for (const band of PITCH_BANDS) {
        if (p >= band.min && p <= band.max) return band.instrument;
    }
    return 0;
}

function instrumentForDrum(p) {
    return DRUM_MAP[p] ?? 3;
}

// 选择乐器：鼓通道优先，其次固定乐器/轨道乐器，最后按音高分段
function pickInstrument(channel, pitch, fixedInstrument, trackInstrument) {
    if (channel === 9) return instrumentForDrum(pitch);
    if (typeof fixedInstrument === "number") return fixedInstrument;
    if (typeof trackInstrument === "number") return trackInstrument;
    return instrumentForPitch(pitch);
}

// MIDI program -> NBS instrument (coarse map)
const PROGRAM_TO_INSTRUMENT = {
    0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0,
    24: 5, 25: 5, 26: 5, 27: 5, 28: 5, 29: 5, 30: 5, 31: 5,
    32: 1, 33: 1, 34: 1, 35: 1, 36: 1, 37: 1, 38: 1, 39: 1,
    40: 6, 41: 6, 42: 6, 43: 6, 44: 6, 45: 6, 46: 6, 47: 6,
    56: 7, 57: 7, 58: 7, 59: 7, 60: 7, 61: 7, 62: 7, 63: 7,
};

function programToInstrument(program) {
    return PROGRAM_TO_INSTRUMENT[program] ?? 0;
}

// ---- 六八度乐器分配：MIDI 音高映射到音符盒 key（33-57），按音域分给不同乐器 ----
// 先算 S = NBS key（MIDI 音高 - 21），再把 key 折叠到 33-57 范围内，并按乐器偏移
//   sound = key + offset；offset：贝斯 -24、吉他 -12、竖琴 0、长笛 +12、铃铛 +24
const SOUND_KEY_MIN = 9;   // F#1 最低可发声
const SOUND_KEY_MAX = 81;  // F#7 最高可发声
const INSTRUMENT_OFFSET = { 0: 0, 1: -24, 5: -12, 6: 12, 7: 24 };

function foldSoundKey(S) {
    while (S < SOUND_KEY_MIN) S += 12;
    while (S > SOUND_KEY_MAX) S -= 12;
    return S;
}

// 根据折叠后的 key 分配乐器：标准区竖琴、低音区贝斯、高音区长笛/铃铛
function instrumentForKey(S) {
    if (S >= 33 && S <= 57) return 0; // 标准区 F#3-F#5（竖琴）
    if (S >= 9 && S < 33) return 1;   // 低音区 F#1-F#3，低 2 个八度（贝斯）
    if (S > 57 && S <= 69) return 6;  // 高音区 F#5-F#6（长笛）
    if (S > 69 && S <= 81) return 7;  // 极高音 F#6-F#7（铃铛）
    return 0;
}

function keyForInstrument(instrument, S) {
    const offset = INSTRUMENT_OFFSET[instrument] || 0;
    return Math.max(33, Math.min(57, S - offset));
}

// MIDI 音高 -> { instrument, key }；key 折叠到 33-57，覆盖约 6 个八度
function assignSixOctave(midiPitch) {
    const S = foldSoundKey(midiPitch - 21);
    const instrument = instrumentForKey(S);
    return { instrument, key: keyForInstrument(instrument, S) };
}

// 统一解析音符：鼓通道按鼓映射；pitch 模式走六八度分配；auto/固定/轨道乐器走普通映射
function resolveNote(channel, midiPitch, instMode, fixedInstrument, trackInstrument) {
    if (channel === 9) {
        return { instrument: instrumentForDrum(midiPitch), key: foldPitch(midiPitch) - NBS_KEY_BASE };
    }
    if (instMode === "pitch") return assignSixOctave(midiPitch);
    return {
        instrument: pickInstrument(channel, midiPitch, fixedInstrument, trackInstrument),
        key: foldPitch(midiPitch) - NBS_KEY_BASE,
    };
}

function pickTrackInstrument(events) {
    let lastProgram = null;
    const pitches = [];
    for (const ev of events) {
        if (ev.type === "program") lastProgram = ev.program;
        else if (ev.type === "note" && ev.channel !== 9) pitches.push(ev.pitch);
    }
    if (lastProgram != null) return programToInstrument(lastProgram);
    if (pitches.length > 0) {
        pitches.sort((a, b) => a - b);
        return instrumentForPitch(pitches[Math.floor(pitches.length / 2)]);
    }
    return 0;
}

const instrCharMap = {
  0: "一丁丂七丄丅丆万丈三上下丌不与丏丐丑丒专且丕世丗丘丙业丛东丝丞丟丠両丢丣两严並丧丨丩个丫丬中丮丯丰丱串丳临丵丶丷丸丹为主丼丽举丿乀乁乂乃乄久乆乇么义乊之乌乍乎乏乐乑乒乓乔乕乖乗".split(''),
  1: "亀亁亂亃亄亅了亇予争亊事二亍于亏亐云互亓五井亖亗亘亙亚些亜亝亞亟亠亡亢亣交亥亦产亨亩亪享京亭亮亯亰亱亲亳亴亵亶亷亸亹人亻亼亽亾亿什仁仂仃仄仅仆仇仈仉今介仌仍从仏仐仑仒仓仔仕他仗".split(''),
  2: "伀企伂伃伄伅伆伇伈伉伊伋伌伍伎伏伐休伒伓伔伕伖众优伙会伛伜伝伞伟传伡伢伣伤伥伦伧伨伩伪伫伬伭伮伯估伱伲伳伴伵伶伷伸伹伺伻似伽伾伿佀佁佂佃佄佅但佇佈佉佊佋佌位低住佐佑佒体佔何佖佗".split(''),
  3: "侀侁侂侃侄侅來侇侈侉侊例侌侍侎侏侐侑侒侓侔侕侖侗侘侙侚供侜依侞侟侠価侢侣侤侥侦侧侨侩侪侫侬侭侮侯侰侱侲侳侴侵侶侷侸侹侺侻侼侽侾便俀俁係促俄俅俆俇俈俉俊俋俌俍俎俏俐俑俒俓俔俕俖俗".split(''),
  4: "倀倁倂倃倄倅倆倇倈倉倊個倌倍倎倏倐們倒倓倔倕倖倗倘候倚倛倜倝倞借倠倡倢倣値倥倦倧倨倩倪倫倬倭倮倯倰倱倲倳倴倵倶倷倸倹债倻值倽倾倿偀偁偂偃偄偅偆假偈偉偊偋偌偍偎偏偐偑偒偓偔偕偖偗".split(''),
  5: "傀傁傂傃傄傅傆傇傈傉傊傋傌傍傎傏傐傑傒傓傔傕傖傗傘備傚傛傜傝傞傟傠傡傢傣傤傥傦傧储傩傪傫催傭傮傯傰傱傲傳傴債傶傷傸傹傺傻傼傽傾傿僀僁僂僃僄僅僆僇僈僉僊僋僌働僎像僐僑僒僓僔僕僖僗".split(''),
  6: "儀儁儂儃億儅儆儇儈儉儊儋儌儍儎儏儐儑儒儓儔儕儖儗儘儙儚儛儜儝儞償儠儡儢儣儤儥儦儧儨儩優儫儬儭儮儯儰儱儲儳儴儵儶儷儸儹儺儻儼儽儾儿兀允兂元兄充兆兇先光兊克兌免兎兏児兑兒兓兔兕兖兗".split(''),
  7: "冀冁冂冃冄内円冇冈冉冊冋册再冎冏冐冑冒冓冔冕冖冗冘写冚军农冝冞冟冠冡冢冣冤冥冦冧冨冩冪冫冬冭冮冯冰冱冲决冴况冶冷冸冹冺冻冼冽冾冿净凁凂凃凄凅准凇凈凉凊凋凌凍凎减凐凑凒凓凔凕凖凗".split(''),
  8: "刀刁刂刃刄刅分切刈刉刊刋刌刍刎刏刐刑划刓刔刕刖列刘则刚创刜初刞刟删刡刢刣判別刦刧刨利刪别刬刭刮刯到刱刲刳刴刵制刷券刹刺刻刼刽刾刿剀剁剂剃剄剅剆則剈剉削剋剌前剎剏剐剑剒剓剔剕剖剗".split(''),
  9: "劀劁劂劃劄劅劆劇劈劉劊劋劌劍劎劏劐劑劒劓劔劕劖劗劘劙劚力劜劝办功加务劢劣劤劥劦劧动助努劫劬劭劮劯劰励劲劳労劵劶劷劸効劺劻劼劽劾势勀勁勂勃勄勅勆勇勈勉勊勋勌勍勎勏勐勑勒勓勔動勖勗".split(''),
  10: "匀匁匂匃匄包匆匇匈匉匊匋匌匍匎匏匐匑匒匓匔匕化北匘匙匚匛匜匝匞匟匠匡匢匣匤匥匦匧匨匩匪匫匬匭匮匯匰匱匲匳匴匵匶匷匸匹区医匼匽匾匿區十卂千卄卅卆升午卉半卋卌卍华协卐卑卒卓協单卖南".split(''),
  11: "厀厁厂厃厄厅历厇厈厉厊压厌厍厎厏厐厑厒厓厔厕厖厗厘厙厚厛厜厝厞原厠厡厢厣厤厥厦厧厨厩厪厫厬厭厮厯厰厱厲厳厴厵厶厷厸厹厺去厼厽厾县叀叁参參叄叅叆叇又叉及友双反収叏叐发叒叓叔叕取受".split(''),
  12: "吀吁吂吃各吅吆吇合吉吊吋同名后吏吐向吒吓吔吕吖吗吘吙吚君吜吝吞吟吠吡吢吣吤吥否吧吨吩吪含听吭吮启吰吱吲吳吴吵吶吷吸吹吺吻吼吽吾吿呀呁呂呃呄呅呆呇呈呉告呋呌呍呎呏呐呑呒呓呔呕呖呗".split(''),
  13: "咀咁咂咃咄咅咆咇咈咉咊咋和咍咎咏咐咑咒咓咔咕咖咗咘咙咚咛咜咝咞咟咠咡咢咣咤咥咦咧咨咩咪咫咬咭咮咯咰咱咲咳咴咵咶咷咸咹咺咻咼咽咾咿哀品哂哃哄哅哆哇哈哉哊哋哌响哎哏哐哑哒哓哔哕哖哗".split(''),
  14: "唀唁唂唃唄唅唆唇唈唉唊唋唌唍唎唏唐唑唒唓唔唕唖唗唘唙唚唛唜唝唞唟唠唡唢唣唤唥唦唧唨唩唪唫唬唭售唯唰唱唲唳唴唵唶唷唸唹唺唻唼唽唾唿啀啁啂啃啄啅商啇啈啉啊啋啌啍啎問啐啑啒啓啔啕啖啗".split(''),
  15: "喀喁喂喃善喅喆喇喈喉喊喋喌喍喎喏喐喑喒喓喔喕喖喗喘喙喚喛喜喝喞喟喠喡喢喣喤喥喦喧喨喩喪喫喬喭單喯喰喱喲喳喴喵営喷喸喹喺喻喼喽喾喿嗀嗁嗂嗃嗄嗅嗆嗇嗈嗉嗊嗋嗌嗍嗎嗏嗐嗑嗒嗓嗔嗕嗖嗗".split('')
};

// 乐器 + key -> Unicode 字符（与 playnbs.js 同款字符表）
function charForNote(instrument, key) {
    return (instrCharMap[instrument] || [])[key + 4] || '';
}

module.exports = {
    parseSMF,
    foldPitch,
    instrumentForPitch,
    instrumentForDrum,
    pickInstrument,
    pickTrackInstrument,
    programToInstrument,
    assignSixOctave,
    instrumentForKey,
    keyForInstrument,
    resolveNote,
    charForNote,
    MIN_PITCH,
    MAX_PITCH,
    NBS_KEY_BASE,
    PITCH_BANDS,
    DRUM_MAP,
    instrCharMap,
};

// ===== 内联 child_bot（复用本文件的 sleep/isAlive）=====
// 子 bot 创建：playnbs / playmidi 共用的多 bot 逻辑
// 同一服务器、offline 模式，先过验证码再注册，然后登录、切 unicode 键盘、传送到主 bot 本体

const CHILD_LOGIN_WAIT = 5000; // 等待出生（spawn）的最长时间



// 发包频率限制器：每个 bot 每 7 秒最多发 MAX_PACKETS_PER_WINDOW 个 tab_complete 包，
// 与 Paper 的 packet-limiter（500 包/7s）同款滑动窗口语义。
// 450 = 500 的 90%，给 GC 抖动 / TPS 波动 / ViaVersion 封装等留生产余量
const MAX_PACKETS_PER_WINDOW = 450;
const RATE_WINDOW_MS = 7000;
// 发包限速开关（false 关闭）
const RATE_LIMIT_ENABLED = true;

function makeRateLimiter(windowPackets = MAX_PACKETS_PER_WINDOW, windowMs = RATE_WINDOW_MS) {
    if (!RATE_LIMIT_ENABLED) {
        // 不限速：每次调用立即返回
        return async function waitSlot() {};
    }
    const times = [];
    return async function waitSlot() {
        const now = performance.now();
        // 滚动窗口：7 秒内已满则等到最早的包滑出窗口
        while (times.length && now - times[0] >= windowMs) times.shift();
        if (times.length >= windowPackets) {
            const wait = times[0] + windowMs - now;
            if (wait > 0) await sleep(wait);
            times.shift();
        }
        times.push(performance.now());
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

// ===== 内联 note_alloc =====
// 音符的“约束分配”：保证每个 bot 在任意 7 秒窗口内的包数 ≤ safeLimit。
//
// 原理：按时间轴顺序处理每个音符，把它分给“最近 7 秒窗口负载最低”的 bot（贪心平衡）；
// 若某个 bot 的窗口已满（bestLoad >= safeLimit），说明当前 bot 数不够，
// 增加一个 bot 从头重新分配，直到全部满足或达到 maxBots。
// 这样不是“轮询”，而是真正的逐 bot 7 秒窗口约束。
//
// notes: [{ seconds }]，按时间升序
// 返回 { botCount, assign, fits, maxLoad }
//   assign[i] = 第 i 个音符分配的 bot 下标；fits=false 表示 maxBots 内无法满足

function allocateBots(notes, safeLimit, maxBots, windowSec = 7) {
    const n = notes.length;
    if (n === 0) return { botCount: 1, assign: [], fits: true, maxLoad: 0 };
    for (let botCount = 1; botCount <= maxBots; botCount++) {
        // 每个 bot 维护一个时间数组 + head 指针（数组有序，滑动窗口 O(1) 均摊）
        const queues = Array.from({ length: botCount }, () => ({ arr: [], head: 0 }));
        const assign = new Array(n);
        let fits = true;
        for (let i = 0; i < n; i++) {
            const t = notes[i].seconds;
            let best = 0, bestLoad = Infinity;
            for (let b = 0; b < botCount; b++) {
                const q = queues[b];
                while (q.head < q.arr.length && q.arr[q.head] < t - windowSec) q.head++;
                const load = q.arr.length - q.head;
                if (load < bestLoad) { bestLoad = load; best = b; }
            }
            if (bestLoad >= safeLimit) { fits = false; break; }
            queues[best].arr.push(t);
            assign[i] = best;
        }
        if (fits) {
            // 独立验证：统计每个 bot 的实际 7s 窗口峰值
            let maxLoad = 0;
            const perBot = Array.from({ length: botCount }, () => []);
            for (let i = 0; i < n; i++) perBot[assign[i]].push(notes[i].seconds);
            for (const times of perBot) {
                let left = 0;
                for (let right = 0; right < times.length; right++) {
                    while (times[right] - times[left] > windowSec) left++;
                    maxLoad = Math.max(maxLoad, right - left + 1);
                }
            }
            return { botCount, assign, fits: true, maxLoad };
        }
    }
    // 达到 maxBots 仍不满足：返回贪心结果（由限速器兜底，最多只是拖慢）
    return { botCount: maxBots, assign: null, fits: false, maxLoad: 0 };
}
// 最多同时使用的 bot 数（1 主 + 9 小号）
const MAX_BOTS = 10;

const MIDI_DIR = path.resolve(__dirname, '..', 'midi');
const FLAG_KEY = 'playmidi';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAlive(bot) {
    return bot && bot.entity && bot._client && !bot._client.ended;
}

function quitPlaymidiChildren(bot) {
    const list = bot.__playmidiChildren || [];
    for (const c of list) {
        try { if (c && c._client && !c._client.ended) c.quit(); } catch (e) {}
    }
    bot.__playmidiChildren = [];
}

// 每个 bot 独立的发包限速器（服务端有发包频率限制，超了会被踢）
const botLimiters = new Map();
function limiterFor(bot) {
    let lim = botLimiters.get(bot);
    if (!lim) {
        lim = makeRateLimiter();
        botLimiters.set(bot, lim);
    }
    return lim;
}

// 构建播放时间轴：tempo 感知（ignoreTempo=true 时忽略所有变速，按固定 120BPM 计算）
function buildTimeline(midiBuf, speed, instMode = 'auto', ignoreTempo = false) {
    const smf = parseSMF(midiBuf);
    const division = smf.division;

    const tempoEvents = [];
    const allNotes = [];
    smf.tracks.forEach((events) => {
        const trackInst = instMode === 'pitch' ? undefined : pickTrackInstrument(events);
        for (const ev of events) {
            if (!ignoreTempo && ev.type === 'meta' && ev.metaType === 0x51 && ev.data.length >= 3) {
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
    const tempoChanges = ignoreTempo ? [] : [{ tick: 0, seconds: 0, tempo: 500000 }];
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
    const { reply, args, log, config } = context;
    if (!bot.__scriptFlags) bot.__scriptFlags = {};
    if (!bot.__playmidiChildren) bot.__playmidiChildren = [];
    // 参数用 | 分隔；歌曲名后的参数可为 1bot/single/solo 强制单 bot 演奏
    const params = parseArgs(args);
    let singleBot = false;
    if (params[1] && /^(1bot|single|solo)$/i.test(params[1])) {
        singleBot = true;
        params.splice(1, 1);
    }
    const sub = (params[0] || '').toLowerCase();

    if (sub === 'stop') {
        bot.__scriptFlags[FLAG_KEY] = true;
        bot.__playmidiToken = (bot.__playmidiToken || 0) + 1; // 也取消并发播放循环
        quitPlaymidiChildren(bot);
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
reply('用法: **run playmidi <歌曲.mid> | [1bot] | <速度> | <模式> | notempo | stop | list');
        return;
    }

    // 参数用 | 分隔（曲名可含空格）
    const [fileName = '', speedStr = '', modeStr = '', tempoStr = ''] = params;
    if (!fileName) {
        reply('用法: **run playmidi <歌曲.mid> | [1bot] | <速度> | <模式> | notempo | stop | list');
        return;
    }
    const speed = speedStr ? parseFloat(speedStr) : 1;
    if (isNaN(speed) || speed < 0.25 || speed > 4) {
        reply('速度范围: 0.25-4（1 = 原速）');
        return;
    }
    let instMode = 'pitch'; // 默认 pitch=按音高六八度分配 | auto=按轨道 | number=固定乐器
    let fixedInstrument;
    let ignoreTempo = false;
    const modeStrL = (modeStr || '').toLowerCase();
    if (modeStrL === 'notempo' || modeStrL === 'ignoretempo' || modeStrL === 'none') {
        ignoreTempo = true;
    } else if (modeStrL === 'pitch') {
        instMode = 'pitch';
    } else if (modeStrL !== '' && modeStrL !== 'auto') {
        fixedInstrument = parseInt(modeStrL, 10);
        if (isNaN(fixedInstrument) || fixedInstrument < 0 || fixedInstrument > 15) {
            reply('乐器模式: pitch=按音高六八度分配（默认） | auto=按轨道 | 0-15=固定乐器 | 可加 notempo 忽略变速');
            return;
        }
    }
    const tempoStrL = (tempoStr || '').toLowerCase();
    if (tempoStrL === 'notempo' || tempoStrL === 'ignoretempo' || tempoStrL === 'none') ignoreTempo = true;

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
        ({ timeline, tempoChanges } = buildTimeline(fs.readFileSync(target), speed, instMode, ignoreTempo));
    } catch (err) {
        reply(`解析失败: ${err.message}`);
        return;
    }
    if (ignoreTempo) {
        log('info', '[playmidi] 已忽略变速，按固定 120BPM 播放');
    }
    const realChanges = tempoChanges ? tempoChanges.filter(c => c.tick > 0) : [];
    if (realChanges.length > 0) {
        const bpmList = realChanges.map(c => (60e6 / c.tempo).toFixed(0) + 'BPM');
        const bpmStr = bpmList.length > 12
            ? bpmList.slice(0, 6).join(' -> ') + ' ... -> ' + bpmList.slice(-3).join(' -> ')
            : bpmList.join(' -> ');
        log('info', `[playmidi] 检测到 ${realChanges.length} 处变速（${bpmStr}）`);
    }

    // 同时刻同乐器同音高的重复音符去重
    const seen = new Set();
    timeline = timeline.filter((n) => {
        const resolved = resolveNote(n.channel, n.pitch, instMode, fixedInstrument, n.trackInst);
        const key = resolved.key;
        const inst = resolved.instrument;
        const k = Math.round(n.seconds * 1000) + ':' + inst + ':' + key;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });

    const duration = timeline.length ? timeline[timeline.length - 1].seconds : 0;
    reply(`开始播放 ${path.basename(target)}（${timeline.length} 个音符，预计 ${duration.toFixed(1)}s${ignoreTempo ? '，已忽略变速' : ''}，**run playmidi stop 停止）`);

    // 多 bot：约束分配——每个音符按时间轴贪心分给“7 秒窗口负载最低”的 bot，
    // 保证每个 bot 任意 7 秒窗口 ≤ MAX_PACKETS_PER_WINDOW（450，500 留 10% 余量），上限 MAX_BOTS
    let alloc = null;
    let botNum;
    if (singleBot) {
        botNum = 1;
    } else {
        alloc = allocateBots(timeline, MAX_PACKETS_PER_WINDOW, MAX_BOTS);
        botNum = alloc.botCount;
        if (alloc.fits) log('info', `[playmidi] 约束分配：${botNum} 个 bot，每 bot 7 秒窗口最多 ${alloc.maxLoad} 包（上限 ${MAX_PACKETS_PER_WINDOW}）`);
        else log('warn', `[playmidi] ${MAX_BOTS} 个 bot 仍无法满足约束，限速器兜底`);
    }
    if (singleBot) log('info', '[playmidi] 已强制单 bot 演奏');

    // 先退出旧小号，再串行创建新小号（失败不影响主 bot 播放）
    quitPlaymidiChildren(bot);
    if (botNum > 1) {
        for (let k = 1; k < botNum; k++) {
            if (bot.__scriptFlags[FLAG_KEY]) break; // **stop 后不再创建新小号
            const child = await createChildBot(bot, k, config, () => !!bot.__scriptFlags[FLAG_KEY]).catch(() => null);
            if (bot.__scriptFlags[FLAG_KEY]) {
                // 创建期间被 stop：退掉刚创建的小号
                if (child) { try { child.quit(); } catch (e) {} }
                break;
            }
            if (child) {
                bot.__playmidiChildren.push(child);
                log('info', `子 bot ${child.username} 已就绪`);
            } else {
                log('warn', `子 bot ${k} 登录失败，继续用现有 bot 播放`);
            }
        }
    }

    // 创建期间被 stop：退掉所有小号，不再开始播放
    if (bot.__scriptFlags[FLAG_KEY]) {
        quitPlaymidiChildren(bot);
        return;
    }

    // 小号就绪后再切 unicode 键盘
    try { bot.chat('/piano keyboard unicode'); } catch (e) {}

    bot.__scriptFlags[FLAG_KEY] = false;
    const playToken = (bot.__playmidiToken = (bot.__playmidiToken || 0) + 1);
    // 小号在前、主 bot 兜底（与 playnbs 一致）
    const botList = [...bot.__playmidiChildren, bot];
    const start = performance.now();
    let transId = 1;
    let i = 0;
    let played = 0;
    let tempoLogIdx = 0;

    while (!bot.__scriptFlags[FLAG_KEY] && playToken === bot.__playmidiToken && i < timeline.length) {
        if (!isAlive(bot)) {
            log('warn', 'Bot 已断开，停止播放');
            break;
        }
        const now = performance.now() - start;
        const targetSec = timeline[i].seconds;
        if (now < targetSec * 1000) {
            await sleep(targetSec * 1000 - now);
        }
        // 发送当前时间点的所有音符（按预分配结果发给指定 bot，掉线则退到存活 bot，限速器兜底）
        const senders = botList.filter((b) => b && isAlive(b));
        if (senders.length === 0) break;
        let fallback = 0;
        while (i < timeline.length && timeline[i].seconds <= targetSec + 0.002) {
            const noteIdx = i;
            const n = timeline[i++];
            const resolved = resolveNote(n.channel, n.pitch, instMode, fixedInstrument, n.trackInst);
            const key = resolved.key;
            const inst = resolved.instrument;
            const ch = charForNote(inst, key);
            if (ch) {
                let sender;
                if (alloc && alloc.assign && alloc.assign[noteIdx] !== undefined) {
                    const target = botList[alloc.assign[noteIdx]];
                    sender = (target && isAlive(target)) ? target : senders[fallback % senders.length];
                    if (sender !== target) fallback++;
                } else {
                    sender = senders[fallback % senders.length];
                    fallback++;
                }
                // 每个 bot 独立限速（7 秒窗口 450 包），兜底防止“发包过多”被踢
                await limiterFor(sender)();
                try {
                    sender._client.write('tab_complete', { transactionId: transId++, text: '/// ' + ch });
                    played++;
                } catch (e) {}
            }
        }
        // 经过变速点：记录实际变速时刻
        while (tempoLogIdx < tempoChanges.length && tempoChanges[tempoLogIdx].seconds <= targetSec) {
            const tc = tempoChanges[tempoLogIdx++];
            if (tc.tick > 0) log('info', `[playmidi] 变速 ${(60e6 / tc.tempo).toFixed(0)} BPM @ ${tc.seconds.toFixed(1)}s`);
        }
    }

    quitPlaymidiChildren(bot);
    bot.__scriptFlags[FLAG_KEY] = false;
    reply(`播放结束（共发出 ${played} 个音符）`);
};
