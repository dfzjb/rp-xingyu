/**
 * 为后台结构化辅助调用（UI 变量补全、记忆蒸馏/抽取等只需要 JSON 输出的任务）
 * 挑选一个「轻量、非深度思考」的模型。
 *
 * 背景（实测，2026-09）：这类任务要求模型对照一大份变量当前值做字段提取。
 * 若用深度思考模型（如 deepseek-v4-pro / *-thinking），其 reasoning token 与正文
 * 共享同一个 max_tokens 预算：变量越多，隐式思考链越长，会出现「思考吃满全部预算、
 * 正文一个 token 都没输出(finish=length)」或「只改少数直白字段、漏掉场景/选项」。
 * 换成 flash/fast/lite 类非思考模型后，秒级返回且能一次性改全 60~80 个变化字段。
 * 因此后台辅助调用默认不走主模型（往往是重型思考模型），而是优先选轻量模型；
 * 用户仍可在设置里用 uiTemplateAuxModel / memoryAuxModel 显式指定、覆盖本自动选择。
 */

/** 命中即视为「不适合做结构化补全」：思考系/重型/非文本模型 */
const EXCLUDE = /(thinking|think|opus|embedding|diffusion|image|video|audio|tts|rerank|vision)/i

/** 优先级从高到低（越靠前越优先用于补全） */
const PREFERRED: RegExp[] = [
  /deepseek[\w.\-]*flash[\w.\-]*fast/i, // deepseek flash-fast：纯输出、最快
  /deepseek[\w.\-]*flash/i, // deepseek flash：实测不产生 reasoning、字段改得最全
  /gemini[\w.\-]*flash/i, // gemini flash（非 thinking 版）
  /glm[\w.\-]*flash/i,
  /doubao[\w.\-]*(lite|turbo)/i,
  /qwen[\w.\-]*(flash|turbo|lite)/i,
  /(^|[\W])(flash|fast|lite|turbo|mini|small|nano)(\W|$)/i, // 任意其它轻量命名
]

/**
 * 从渠道可用模型里挑一个轻量非思考模型；挑不出来时回退主模型（保持旧行为）。
 * @param available 渠道 /v1/models 返回的模型 id 列表（settings.modelsCache）
 * @param mainModel 当前主模型，兜底
 */
export function pickLightModel(available: readonly string[] | undefined | null, mainModel: string): string {
  if (!mainModel) return ''
  if (!available || available.length === 0) return mainModel
  const pool = available.filter((m) => typeof m === 'string' && m && !EXCLUDE.test(m))
  for (const re of PREFERRED) {
    const hit = pool.find((m) => re.test(m))
    if (hit) return hit
  }
  return mainModel
}

/** 该模型是否看起来是「深度思考/重型」模型（用于决定补全时是否下发 reasoning_effort） */
export function isHeavyThinkingModel(model: string): boolean {
  return /(thinking|think|opus|pro|max|reasoning)/i.test(model) && !/(flash|fast|lite|mini|turbo)/i.test(model)
}
