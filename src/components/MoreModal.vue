<script setup lang="ts">
/**
 * 「更多」抽屉：左侧分类导航 + 右侧内容区。
 * 分类：对话（预设/世界书/正则/人设）、数据（用量/工具）、
 * 应用（语言模型等区块作为子级副标题，点击直达设置页对应区块）。
 */
import { nextTick, ref, watch } from 'vue'
import { NDrawer, NDrawerContent, NSelect } from 'naive-ui'
import WorldBookEditor from './WorldBookEditor.vue'
import RegexEditor from './RegexEditor.vue'
import PresetManagerPanel from './PresetManagerPanel.vue'
import ApiSettingsPanel from './ApiSettingsPanel.vue'
import ToolsPanel from './ToolsPanel.vue'
import UsageView from '../views/UsageView.vue'
import PersonasView from '../views/PersonasView.vue'
import { useCharactersStore } from '../stores/characters'
import type { CharacterCard } from '../types'

const props = defineProps<{ show: boolean; initialTab?: string }>()
const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const characters = useCharactersStore()

interface NavItem {
  key: string
  label: string
  /** 内容面板：独立页或设置页中的锚点区块 */
  pane: 'presets' | 'worldbook' | 'regex' | 'personas' | 'usage' | 'tools' | 'settings'
  anchor?: string // pane === 'settings' 时滚动到的区块 id
  sub?: boolean // 子级副标题样式
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '对话',
    items: [
      { key: 'presets', label: '预设', pane: 'presets' },
      { key: 'worldbook', label: '世界书', pane: 'worldbook' },
      { key: 'regex', label: '正则', pane: 'regex' },
      { key: 'personas', label: '人设', pane: 'personas' },
    ],
  },
  {
    title: '数据',
    items: [
      { key: 'usage', label: '用量统计', pane: 'usage' },
      { key: 'tools', label: '工具维护', pane: 'tools' },
    ],
  },
  {
    title: '应用',
    items: [
      { key: 'sec-api', label: '语言模型', pane: 'settings', anchor: 'sec-api', sub: true },
      { key: 'sec-slots', label: '模型槽位', pane: 'settings', anchor: 'sec-slots', sub: true },
      { key: 'sec-image', label: '图片生成模型', pane: 'settings', anchor: 'sec-image', sub: true },
      { key: 'sec-video', label: '视频生成模型', pane: 'settings', anchor: 'sec-video', sub: true },
      { key: 'sec-params', label: '生成参数', pane: 'settings', anchor: 'sec-params', sub: true },
      { key: 'sec-cover', label: '聊天背景', pane: 'settings', anchor: 'sec-cover', sub: true },
    ],
  },
]

const activeKey = ref('presets')
const activeTab = ref<string>('presets')

function onNavClick(it: NavItem) {
  activeKey.value = it.key
  activeTab.value = it.pane
  if (it.anchor) {
    // 切到设置面板后滚动到对应区块
    void nextTick(() => {
      setTimeout(() => {
        document.getElementById(it.anchor!)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 60)
    })
  }
}

// 世界书 / 正则页签：选择要编辑的角色卡
const wbCharUuid = ref('')
const rxCharUuid = ref('')

watch(() => props.show, (v) => {
  if (!v) return
  if (props.initialTab) {
    // 兼容旧入口：'settings' 落到第一个子项
    const hit = NAV_GROUPS.flatMap((g) => g.items).find((i) => i.pane === props.initialTab || i.key === props.initialTab)
    const item = hit || NAV_GROUPS[0].items[0]
    activeKey.value = item.key
    activeTab.value = item.pane
  }
  if (!characters.loaded) void characters.load()
  if (!wbCharUuid.value && characters.list.length) wbCharUuid.value = characters.list[0].uuid
  if (!rxCharUuid.value && characters.list.length) rxCharUuid.value = characters.list[0].uuid
}, { immediate: true })

const wbCard = ref<CharacterCard | null>(null)
watch(wbCharUuid, (u) => {
  wbCard.value = characters.list.find((c) => c.uuid === u) || null
}, { immediate: true })
watch(() => characters.list.length, () => {
  if (wbCharUuid.value && !characters.list.some((c) => c.uuid === wbCharUuid.value)) wbCard.value = null
})
function onWbListUpdate(v: unknown[]) {
  if (wbCard.value) wbCard.value.worldInfo = v
}
function onRxListUpdate(v: unknown[]) {
  const c = characters.list.find((x) => x.uuid === rxCharUuid.value)
  if (c) c.regexScripts = v
}

const drawerWidth = Math.min(880, Math.max(430, window.innerWidth - 40))
</script>

<template>
  <n-drawer :show="props.show" :width="drawerWidth" placement="right" @update:show="emit('update:show', $event)">
    <n-drawer-content title="更多" closable :body-content-style="{ padding: 0 }">
      <div class="more-layout">
        <!-- 左侧分类导航 -->
        <nav class="more-nav">
          <template v-for="g in NAV_GROUPS" :key="g.title">
            <div class="more-nav-title">{{ g.title }}</div>
            <button
              v-for="it in g.items"
              :key="it.key"
              class="more-nav-item"
              :class="{ active: activeKey === it.key, sub: it.sub }"
              @click="onNavClick(it)"
            >{{ it.label }}</button>
          </template>
        </nav>

        <!-- 右侧内容区 -->
        <div class="more-content">
          <template v-if="activeTab === 'presets'">
            <PresetManagerPanel />
          </template>

          <template v-else-if="activeTab === 'worldbook'">
            <div class="field" style="max-width: 340px">
              <label>选择角色卡</label>
              <NSelect v-model:value="wbCharUuid" size="small" filterable :options="[{ label: '— 选择 —', value: '' }, ...characters.list.map((c) => ({ label: c.name, value: c.uuid }))]" />
            </div>
            <WorldBookEditor v-if="wbCard" :list="wbCard.worldInfo" @update:list="onWbListUpdate" />
            <p v-else style="font-size: 0.8rem; color: var(--text-2)">先选择一张角色卡。</p>
          </template>

          <template v-else-if="activeTab === 'regex'">
            <div class="field" style="max-width: 340px">
              <label>选择角色卡</label>
              <NSelect v-model:value="rxCharUuid" size="small" filterable :options="[{ label: '— 选择 —', value: '' }, ...characters.list.map((c) => ({ label: c.name, value: c.uuid }))]" />
            </div>
            <p v-if="!characters.list.some((c) => c.uuid === rxCharUuid)" style="font-size: 0.8rem; color: var(--text-2)">先选择一张角色卡。</p>
            <RegexEditor
              v-else
              :list="(characters.list.find((c) => c.uuid === rxCharUuid) as CharacterCard).regexScripts"
              @update:list="onRxListUpdate"
            />
          </template>

          <template v-else-if="activeTab === 'personas'">
            <PersonasView />
          </template>

          <template v-else-if="activeTab === 'usage'">
            <UsageView />
          </template>

          <template v-else-if="activeTab === 'tools'">
            <ToolsPanel />
          </template>

          <template v-else-if="activeTab === 'settings'">
            <ApiSettingsPanel />
          </template>
        </div>
      </div>
    </n-drawer-content>
  </n-drawer>
</template>

<style scoped>
.more-layout { display: flex; align-items: stretch; min-height: 100%; }

.more-nav {
  width: 168px;
  flex-shrink: 0;
  border-right: 1px solid var(--line);
  padding: 12px 10px 20px;
  position: sticky;
  top: 0;
  align-self: flex-start;
}
.more-nav-title {
  font-size: 0.66rem;
  letter-spacing: 2px;
  color: var(--text-2);
  font-weight: 700;
  padding: 12px 10px 5px;
}
.more-nav-title:first-child { padding-top: 4px; }
.more-nav-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border-radius: 9px;
  border: none;
  background: none;
  cursor: pointer;
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-2);
  transition: all 0.15s;
}
.more-nav-item:hover { background: var(--bg-2); color: var(--text-1); }
.more-nav-item.active {
  background: var(--accent-grad);
  color: #fff;
  box-shadow: 0 3px 12px rgba(139, 92, 246, 0.3);
}
/* 应用组子级副标题：缩进 + 弱化 */
.more-nav-item.sub {
  padding-left: 24px;
  font-size: 0.76rem;
  font-weight: 500;
  padding-top: 6px;
  padding-bottom: 6px;
}

.more-content { flex: 1; min-width: 0; padding: 14px 18px 28px; }

.field label {
  font-size: 0.78rem;
  color: var(--text-1);
  font-weight: 600;
  display: block;
  margin-bottom: 5px;
}
</style>
