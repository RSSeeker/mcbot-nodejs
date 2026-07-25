"""
midi_processor.py — MIDI 文件解析 + Unicode 音符映射 + 节奏播放
================================================================
完全对应 Java 版 MidiProcesser.java 的逻辑：
1. 音符 → Unicode 汉字映射表（与 Java 版完全相同）
2. 解析 .mid 文件，提取 NOTE_ON 事件
3. 音符归一化（压缩到映射表范围）
4. 按 tick 排序 → 计算间隔 → 按节拍发送 "/// " + 汉字
"""

import os
import time
import threading
import logging

import mido

logger = logging.getLogger("bot")

# ═══════════════════════════════════════════════════════════
#  音符 → Unicode 汉字 映射表
#  (与 Java 版 addMapping 完全一致，连顺序都相同)
# ═══════════════════════════════════════════════════════════

_NOTE_MAP: dict[int, int] = {}


def _add_mapping(start: int, chars: str):
    note = start
    i = 0
    while i < len(chars):
        cp = ord(chars[i])
        # 处理代理对 (emoji 等)
        if 0xD800 <= cp <= 0xDBFF and i + 1 < len(chars):
            low = ord(chars[i + 1])
            if 0xDC00 <= low <= 0xDFFF:
                cp = 0x10000 + (cp - 0xD800) * 0x400 + (low - 0xDC00)
                i += 1
        _NOTE_MAP[note] = cp
        note += 1
        i += 1


# 初始化映射表 — 直接从 Java 代码复制
_add_mapping(0, "一丁丂七丄丅丆万丈三上下丌不与丏丐丑丒专且丕世丗丘丙业丛东丝丞丟丠両丢丣两严並丧丨丩个丫丬中丮丯丰丱串丳临丵丶丷丸丹为主丼丽举丿乀乁乂乃乄久乆乇么义乊之乌乍乎乏乐乑乒乓乔乕乖乗")
_add_mapping(1, "亀亁亂亃亄亅了亇予争亊事二亍于亏亐云互亓五井亖亗亘亙亚些亜亝亞亟亠亡亢亣交亥亦产亨亩亪享京亭亮亯亰亱亲亳亴亵亶亷亸亹人亻亼亽亾亿什仁仂仃仄仅仆仇仈仉今介仌仍从仏仐仑仒仓仔仕他仗")
_add_mapping(2, "伀企伂伃伄伅伆伇伈伉伊伋伌伍伎伏伐休伒伓伔伕伖众优伙会伛伜伝伞伟传伡伢伣伤伥伦伧伨伩伪伫伬伭伮伯估伱伲伳伴伵伶伷伸伹伺伻似伽伾伿佀佁佂佃佄佅但佇佈佉佊佋佌位低住佐佑佒体佔何佖佗")
_add_mapping(3, "侀侁侂侃侄侅來侇侈侉侊例侌侍侎侏侐侑侒侓侔侕侖侗侘侙侚供侜依侞侟侠価侢侣侤侥侦侧侨侩侪侫侬侭侮侯侰侱侲侳侴侵侶侷侸侹侺侻侼侽侾便俀俁係促俄俅俆俇俈俉俊俋俌俍俎俏俐俑俒俓俔俕俖俗")
_add_mapping(4, "倀倁倂倃倄倅倆倇倈倉倊個倌倍倎倏倐們倒倓倔倕倖倗倘候倚倛倜倝倞借倠倡倢倣値倥倦倧倨倩倪倫倬倭倮倯倰倱倲倳倴倵倶倷倸倹债倻值倽倾倿偀偁偂偃偄偅偆假偈偉偊偋偌偍偎偏偐偑偒偓偔偕偖偗")
_add_mapping(5, "傀傁傂傃傄傅傆傇傈傉傊傋傌傍傎傏傐傑傒傓傔傕傖傗傘備傚傛傜傝傞傟傠傡傢傣傤傥傦傧储傩傪傫催傭傮傯傰傱傲傳傴債傶傷傸傹傺傻傼傽傾傿僀僁僂僃僄僅僆僇僈僉僊僋僌働僎像僐僑僒僓僔僕僖僗")
_add_mapping(6, "儀儁儂儃億儅儆儇儈儉儊儋儌儍儎儏儐儑儒儓儔儕儖儗儘儙儚儛儜儝儞償儠儡儢儣儤儥儦儧儨儩優儫儬儭儮儯儰儱儲儳儴儵儶儷儸儹儺儻儼儽儾儿兀允兂元兄充兆兇先光兊克兌免兎兏児兑兒兓兔兕兖兗")
_add_mapping(7, "冀冁冂冃冄内円冇冈冉冊冋册再冎冏冐冑冒冓冔冕冖冗冘写冚军农冝冞冟冠冡冢冣冤冥冦冧冨冩冪冫冬冭冮冯冰冱冲决冴况冶冷冸冹冺冻冼冽冾冿净凁凂凃凄凅准凇凈凉凊凋凌凍凎减凐凑凒凓凔凕凖凗")
_add_mapping(8, "刀刁刂刃刄刅分切刈刉刊刋刌刍刎刏刐刑划刓刔刕刖列刘则刚创刜初刞刟删刡刢刣判別刦刧刨利刪别刬刭刮刯到刱刲刳刴刵制刷券刹刺刻刼刽刾刿剀剁剂剃剄剅剆則剈剉削剋剌前剎剏剐剑剒剓剔剕剖剗")
_add_mapping(9, "劀劁劂劃劄劅劆劇劈劉劊劋劌劍劎劏劐劑劒劓劔劕劖劗劘劙劚力劜劝办功加务劢劣劤劥劦劧动助努劫劬劭劮劯劰励劲劳労劵劶劷劸効劺劻劼劽劾势勀勁勂勃勄勅勆勇勈勉勊勋勌勍勎勏勐勑勒勓勔動勖勗")
_add_mapping(10, "匀匁匂匃匄包匆匇匈匉匊匋匌匍匎匏匐匑匒匓匔匕化北匘匙匚匛匜匝匞匟匠匡匢匣匤匥匦匧匨匩匪匫匬匭匮匯匰匱匲匳匴匵匶匷匸匹区医匼匽匾匿區十卂千卄卅卆升午卉半卋卌卍华协卐卑卒卓協单卖南")
_add_mapping(11, "厀厁厂厃厄厅历厇厈厉厊压厌厍厎厏厐厑厒厓厔厕厖厗厘厙厚厛厜厝厞原厠厡厢厣厤厥厦厧厨厩厪厫厬厭厮厯厰厱厲厳厴厵厶厷厸厹厺去厼厽厾县叀叁参參叄叅叆叇又叉及友双反収叏叐发叒叓叔叕取受")
_add_mapping(12, "吀吁吂吃各吅吆吇合吉吊吋同名后吏吐向吒吓吔吕吖吗吘吙吚君吜吝吞吟吠吡吢吣吤吥否吧吨吩吪含听吭吮启吰吱吲吳吴吵吶吷吸吹吺吻吼吽吾吿呀呁呂呃呄呅呆呇呈呉告呋呌呍呎呏呐呑呒呓呔呕呖呗")
_add_mapping(13, "咀咁咂咃咄咅咆咇咈咉咊咋和咍咎咏咐咑咒咓咔咕咖咗咘咙咚咛咜咝咞咟咠咡咢咣咤咥咦咧咨咩咪咫咬咭咮咯咰咱咲咳咴咵咶咷咸咹咺咻咼咽咾咿哀品哂哃哄哅哆哇哈哉哊哋哌响哎哏哐哑哒哓哔哕哖哗")
_add_mapping(14, "唀唁唂唃唄唅唆唇唈唉唊唋唌唍唎唏唐唑唒唓唔唕唖唗唘唙唚唛唜唝唞唟唠唡唢唣唤唥唦唧唨唩唪唫唬唭售唯唰唱唲唳唴唵唶唷唸唹唺唻唼唽唾唿啀啁啂啃啄啅商啇啈啉啊啋啌啍啎問啐啑啒啓啔啕啖啗")
_add_mapping(15, "喀喁喂喃善喅喆喇喈喉喊喋喌喍喎喏喐喑喒喓喔喕喖喗喘喙喚喛喜喝喞喟喠喡喢喣喤喥喦喧喨喩喪喫喬喭單喯喰喱喲喳喴喵営喷喸喹喺喻喼喽喾喿嗀嗁嗂嗃嗄嗅嗆嗇嗈嗉嗊嗋嗌嗍嗎嗏嗐嗑嗒嗓嗔嗕嗖嗗")


# ═══════════════════════════════════════════════════════════
#  音符归一化
# ═══════════════════════════════════════════════════════════

def _normalize_note(note: int) -> int:
    """将 MIDI 音符压缩到映射表范围（升/降八度）"""
    if not _NOTE_MAP:
        return note
    min_note = min(_NOTE_MAP.keys())
    max_note = max(_NOTE_MAP.keys())
    while note > max_note:
        note -= 12
    while note < min_note:
        note += 12
    return note


# ═══════════════════════════════════════════════════════════
#  MIDI 事件数据
# ═══════════════════════════════════════════════════════════

class _MidiEventData:
    __slots__ = ("tick", "unicode", "channel")

    def __init__(self, tick: int, unicode_cp: int, channel: int):
        self.tick = tick
        self.unicode = unicode_cp
        self.channel = channel


# ═══════════════════════════════════════════════════════════
#  MidiProcessor
# ═══════════════════════════════════════════════════════════

class MidiProcessor:
    """MIDI 播放器 — 单例模式"""

    _play_thread: threading.Thread | None = None
    _playing = False

    @classmethod
    def play(cls, filepath: str, conn):
        """开始播放 MIDI 文件"""
        cls.stop()

        if not os.path.isfile(filepath):
            logger.error(f"MIDI 文件不存在: {filepath}")
            return

        cls._playing = True
        cls._play_thread = threading.Thread(
            target=cls._play_internal,
            args=(filepath, conn),
            daemon=True,
        )
        cls._play_thread.start()

    @classmethod
    def stop(cls):
        """停止播放"""
        cls._playing = False
        if cls._play_thread is not None:
            cls._play_thread.join(timeout=2)
            cls._play_thread = None

    @classmethod
    def _play_internal(cls, filepath: str, conn):
        try:
            # Step 0: 切换到 Unicode 模式
            conn.send_chat_command("piano keyboard unicode")

            mid = mido.MidiFile(filepath)

            # Step 1: 解析 BPM
            micro_per_quarter = 500_000  # 默认 120 BPM
            resolution = mid.ticks_per_beat

            for track in mid.tracks:
                for msg in track:
                    if msg.type == "set_tempo":
                        micro_per_quarter = msg.tempo

            # Step 2: 提取 NOTE_ON 事件
            events: list[_MidiEventData] = []

            for track in mid.tracks:
                tick = 0
                for msg in track:
                    tick += msg.time
                    if msg.type == "note_on" and msg.velocity > 0:
                        note = _normalize_note(msg.note)
                        unicode_cp = _NOTE_MAP.get(note, 0)
                        events.append(_MidiEventData(
                            tick=tick,
                            unicode_cp=unicode_cp,
                            channel=msg.channel,
                        ))

            # Step 3: 按 tick 排序
            events.sort(key=lambda e: e.tick)

            # Step 4: 按节拍发送
            transaction_id = 0
            last_tick = 0

            for e in events:
                if not cls._playing:
                    return

                delta_tick = e.tick - last_tick

                # tick → 毫秒
                sleep_ms = int(
                    delta_tick * micro_per_quarter / resolution / 1000
                )

                if sleep_ms > 0:
                    cls._sleep_interruptible(sleep_ms)

                if not cls._playing:
                    return

                if e.unicode != 0:
                    text = "/// " + chr(e.unicode)
                    conn.send_command_suggestion(transaction_id, text)
                    transaction_id += 1

                last_tick = e.tick

        except Exception as ex:
            logger.error(f"MIDI 播放出错: {ex}")
        finally:
            cls._playing = False

    @classmethod
    def _sleep_interruptible(cls, ms: int):
        """可中断的 sleep"""
        while ms > 0 and cls._playing:
            chunk = min(ms, 100)
            time.sleep(chunk / 1000.0)
            ms -= chunk
