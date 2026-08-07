'use strict';

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
