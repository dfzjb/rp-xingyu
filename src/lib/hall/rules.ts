/**
 * 规则系统预设：创建房间（详细模式）、KP 提示词、骰子栏快捷骰三处共用的单一事实源。
 * v1 仍是无规则书集成的表达式骰子（项目书 11.4）；预设只提供「检定约定文案 + 常用骰」，
 * 让 KP 的 <roll> 请求与掷骰习惯贴合所选规则。
 */

export interface RulePreset {
  id: string
  name: string
  /** 注入 KP 提示词的检定约定（骰子表达式与成败判法） */
  rollConventions: string
  /** 房间骰子栏的快捷骰 */
  quickDice: string[]
  /** 时代背景建议（详细模式 datalist） */
  eras: string[]
}

export const RULE_PRESETS: RulePreset[] = [
  {
    id: 'free',
    name: '自由团（无规则书）',
    rollConventions:
      '自由团：没有硬性规则书，需要随机性时直接用 NdM 表达式（如 <roll>1d20 意志</roll>），成败由你依据剧情裁量并在旁白中说明。',
    quickDice: ['1d20', '1d100', '2d6', '3d6', '1d4+1'],
    eras: ['现代都市', '近未来', '架空中世纪', '架空东方', '废土末日'],
  },
  {
    id: 'coc7',
    name: 'COC7th（克苏鲁的呼唤）',
    rollConventions:
      'COC 第七版：技能/属性检定一律 <roll>1d100 技能名</roll>；骰值 ≤ 技能值即成功，≤ 一半为困难成功，≤ 五分之一为极难困难成功；1-5 大成功、96-100 大失败（技能值 ≥50 时 100 才大失败）。理智检定同样 1d100，失败扣 SAN 并描述疯狂反应。伤害用 NdM（如 1d6、2d6+1d4）。',
    quickDice: ['1d100', '1d10', '1d6', '1d4', '1d3+1'],
    eras: ['1920s 美国', '1930s 民国', '现代都市', '1990s 小镇', '维多利亚时代'],
  },
  {
    id: 'dnd5',
    name: 'DND5e（龙与地下城）',
    rollConventions:
      'DND 第五版：d20 检定一律 <roll>1d20 属性/技能</roll>（含调整值写作 1d20+3）；DC 判定 10 容易 / 15 中等 / 20 困难；攻击骰 1d20+加值，伤害 NdM+调整值；遭遇战开始先掷 <roll>1d20 先攻</roll>。属性生成为 4d6 取三高（需要时由你指定）。',
    quickDice: ['1d20', '1d20+3', '1d8+2', '2d6+2', '4d6'],
    eras: ['费伦/被遗忘的国度', '自创高魔大陆', '低魔中世纪', '灰鹰', '艾伯伦'],
  },
  {
    id: 'custom',
    name: '自定义规则',
    rollConventions: '',
    quickDice: ['1d20', '1d100', '2d6', '3d6', '1d4+1'],
    eras: [],
  },
]

export function rulePreset(id: string): RulePreset {
  return RULE_PRESETS.find((r) => r.id === id) || RULE_PRESETS[0]
}

/** 团的基调（详细模式多选） */
export const TONE_OPTIONS = [
  '恐怖悬疑', '克苏鲁神话', '欢乐日常', '严肃正剧', '史诗冒险',
  '都市怪谈', '武侠江湖', '太空歌剧', '阵营博弈', '生存硬核', '治愈温馨', '黑色幽默',
]

/** KP 风格（详细模式单选） */
export const KP_STYLES = [
  { id: 'balanced', name: '平衡（扮演与检定并重）', hint: '叙事、扮演与检定均衡安排。' },
  { id: 'narrative', name: '重扮演（多台词少结算）', hint: '多用 NPC 台词与氛围描写，少做数值结算，检定只在关键处请求。' },
  { id: 'rules', name: '重规则（多检定严判定）', hint: '关键行动尽量给出检定，严格按骰结果判定成败，不轻易放水。' },
]

/** 开团设定（详细模式表单 → 战役持久化 → KP 提示词 / 成员快照同步） */
export interface RoomSetting {
  system: string // RULE_PRESETS id
  systemCustom: string // system === 'custom' 时的规则名
  era: string
  tones: string[]
  players: number
  world: string
  module: string // 模组 / 剧情梗概
  opening: string // 开场场景（KP 的开局指引）
  openingNarration: string // 开场白（建团后自动发到剧情流的第一段旁白）
  npcs: string
  houseRules: string
  redlines: string
  kpStyle: string
  sceneNotes: string // 场景/地图备注（v1 文字团的场景速查）
}

export function emptySetting(): RoomSetting {
  return {
    system: 'free', systemCustom: '', era: '', tones: [], players: 4,
    world: '', module: '', opening: '', openingNarration: '', npcs: '', houseRules: '', redlines: '',
    kpStyle: 'balanced', sceneNotes: '',
  }
}

/** 全部保持默认值的空设定：不值得注入 KP 提示词 */
export function isEmptySetting(s: RoomSetting): boolean {
  const b = emptySetting()
  if (s.system !== b.system || s.kpStyle !== b.kpStyle || s.players !== b.players) return false
  return !s.systemCustom.trim() && !s.era.trim() && !s.tones.length && !s.world.trim()
    && !s.module.trim() && !s.opening.trim() && !s.openingNarration.trim() && !s.npcs.trim()
    && !s.houseRules.trim() && !s.redlines.trim() && !s.sceneNotes.trim()
}

export function systemLabel(s: RoomSetting | null | undefined): string {
  if (!s) return ''
  if (s.system === 'custom') return s.systemCustom.trim() || '自定义规则'
  return rulePreset(s.system).name.replace(/（.*）/, '')
}
