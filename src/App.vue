<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue'
import { darkTheme, lightTheme, zhCN, type GlobalThemeOverrides } from 'naive-ui'
import { globalErrors } from './lib/errors'
import {
  MessagesSquare, LibraryBig, Settings2, Plus,
  SunMedium, MoonStar, BarChart3, BrainCircuit, LayoutTemplate, Ellipsis, Heart, Store, Wand2, DatabaseBackup,
} from 'lucide-vue-next'
import { useSettingsStore } from './stores/settings'
import { useCharactersStore } from './stores/characters'
import { useChatStore } from './stores/chat'
import { usePersonasStore } from './stores/personas'
import ChatView from './views/ChatView.vue'
import Toaster from './components/Toaster.vue'

// 非首屏视图与「更多」弹窗按需加载：首屏只拉聊天页 + vendor 分包
const CharactersView = defineAsyncComponent(() => import('./views/CharactersView.vue'))
const AffinityView = defineAsyncComponent(() => import('./views/AffinityView.vue'))
const MemorySystemView = defineAsyncComponent(() => import('./views/MemorySystemView.vue'))
const UiTemplatesView = defineAsyncComponent(() => import('./views/UiTemplatesView.vue'))
const PlazaView = defineAsyncComponent(() => import('./views/PlazaView.vue'))
const AiWorkshopView = defineAsyncComponent(() => import('./views/AiWorkshopView.vue'))
const DataView = defineAsyncComponent(() => import('./views/DataView.vue'))
const MoreModal = defineAsyncComponent(() => import('./components/MoreModal.vue'))

type View = 'chat' | 'affinity' | 'memory' | 'uitpl' | 'characters' | 'plaza' | 'aiworkshop' | 'data'

const settings = useSettingsStore()
const characters = useCharactersStore()
const chat = useChatStore()
const personas = usePersonasStore()

const view = ref<View>('chat')
const sidebarOpen = ref(false)
const moreShow = ref(false)
const moreTab = ref('presets')
const moreMounted = ref(false)

function openMore(tab: string) {
  moreTab.value = tab
  moreMounted.value = true
  moreShow.value = true
  sidebarOpen.value = false
}

const isLight = computed(() => settings.settings.themeMode === 'light')

const naiveTheme = computed(() => (isLight.value ? lightTheme : darkTheme))

const ACCENT = {
  primaryColor: '#8b5cf6',
  primaryColorHover: '#a78bfa',
  primaryColorPressed: '#7c3aed',
  primaryColorSuppl: '#6366f1',
  infoColor: '#22d3ee',
  errorColor: '#f87171',
  warningColor: '#fbbf24',
  successColor: '#34d399',
  borderRadius: '10px',
}

const themeOverrides = computed<GlobalThemeOverrides>(() => {
  if (isLight.value) {
    return {
      common: {
        ...ACCENT,
        bodyColor: '#eef1f8',
        cardColor: '#ffffff',
        modalColor: '#ffffff',
        popoverColor: '#ffffff',
        inputColor: '#ffffff',
      },
      Select: { peers: { InternalSelection: { borderRadius: '10px' } } },
      Input: { borderRadius: '10px' },
      Button: { borderRadiusMedium: '10px', borderRadiusSmall: '9px' },
    }
  }
  return {
    common: {
      ...ACCENT,
      bodyColor: '#070a13',
      cardColor: '#0f1524',
      modalColor: '#121a2d',
      popoverColor: '#1b2440',
      inputColor: 'rgba(10,14,26,0.7)',
    },
    Select: { peers: { InternalSelection: { borderRadius: '10px' } } },
    Input: { borderRadius: '10px' },
    Button: { borderRadiusMedium: '10px', borderRadiusSmall: '9px' },
  }
})

watch(isLight, (v) => {
  document.documentElement.setAttribute('data-theme', v ? 'light' : 'dark')
})

async function toggleTheme() {
  await settings.patch({ themeMode: isLight.value ? 'dark' : 'light' })
}

const NAV: { key: View; icon: typeof MessagesSquare; label: string }[] = [
  { key: 'chat', icon: MessagesSquare, label: '聊天' },
  { key: 'characters', icon: LibraryBig, label: '角色卡管理' },
  { key: 'affinity', icon: Heart, label: '好感度' },
  { key: 'memory', icon: BrainCircuit, label: '记忆系统' },
  { key: 'uitpl', icon: LayoutTemplate, label: 'UI 模板' },
  { key: 'plaza', icon: Store, label: '卡片广场' },
  { key: 'aiworkshop', icon: Wand2, label: 'AI 工作台' },
  { key: 'data', icon: DatabaseBackup, label: '导入 / 导出' },
]

function switchView(v: string) {
  view.value = v as View
  sidebarOpen.value = false
}

async function pickCharacter(uuid: string) {
  await chat.openCharacter(uuid)
  view.value = 'chat'
  sidebarOpen.value = false
}

function sessionCount(uuid: string) {
  return chat.sessionsOfChar(uuid).length
}

/** 处理聊天页空态的快捷跳转 */
function onChatGoto(target: string) {
  if (target === 'data') switchView('data')
  else if (target === 'settings') openMore('settings')
  else if (target === 'affinity') switchView('affinity')
  else switchView(target)
}

onMounted(async () => {
  await Promise.all([settings.load(), characters.load(), chat.load(), personas.load()])
  document.documentElement.setAttribute('data-theme', isLight.value ? 'light' : 'dark')
  const target = settings.settings.lastActiveCharUuid || characters.list[0]?.uuid
  if (target) await chat.openCharacter(target)
  window.addEventListener('beforeunload', () => { void chat.flushOnUnload() })

  // 开发种子通道：仅本地回环地址 + 显式 #devseed 时，从同源 Mock 服务灌入夹具数据
  if (location.hash === '#devseed' && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    try {
      const resp = await fetch('/api/dev/fixture-keys')
      const j = await resp.json()
      const mod = await import('./lib/migrate')
      await mod.migrateLegacyData(mod.parseLegacyBackupFile(j.keys ?? j), 'devseed')
      console.info('[devseed] done')
    } catch (e) {
      console.warn('[devseed] failed', e)
    }
    history.replaceState(null, '', location.pathname)
    location.reload()
  }
})
</script>

<template>
  <n-config-provider :theme="naiveTheme" :theme-overrides="themeOverrides" :locale="zhCN" style="height: 100%">
    <n-message-provider placement="top">
      <n-dialog-provider>
        <div class="app-shell">
          <div class="sidebar-backdrop" :class="{ show: sidebarOpen }" @click="sidebarOpen = false" />

          <aside class="sidebar" :class="{ open: sidebarOpen }">
            <div class="sidebar-brand">
              <div class="logo">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"
                  stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
                </svg>
              </div>
              <div>
                <h1 class="gradient-text">RP · 星屿</h1>
                <div class="sub">数据只存你的浏览器</div>
              </div>
            </div>

            <nav class="nav-list">
              <button
                v-for="n in NAV"
                :key="n.key"
                class="nav-item"
                :class="{ active: view === n.key }"
                @click="switchView(n.key)"
              >
                <component :is="n.icon" class="nav-icon-svg" />
                {{ n.label }}
              </button>
              <button class="nav-item" :class="{ active: moreShow }" @click="openMore('presets')">
                <Ellipsis class="nav-icon-svg" />
                更多
              </button>
            </nav>

            <div class="sidebar-scroll">
              <div class="sidebar-section-title">
                角色（{{ characters.list.length }}）
                <button title="角色卡管理" @click="switchView('characters')">
                  <Plus :size="15" />
                </button>
              </div>
              <div
                v-for="c in characters.list"
                :key="c.uuid"
                class="char-row"
                :class="{ active: view === 'chat' && chat.currentSession?.charUuid === c.uuid }"
                @click="pickCharacter(c.uuid)"
              >
                <div class="avatar">
                  <img v-if="c.avatar" :src="c.avatar" alt="" />
                  <template v-else>{{ c.name.slice(0, 1) }}</template>
                </div>
                <div class="meta">
                  <div class="name">{{ c.name }}</div>
                  <div class="count">{{ sessionCount(c.uuid) ? `${sessionCount(c.uuid)} 个会话` : '未开始' }}</div>
                </div>
              </div>
              <div v-if="!characters.list.length" class="sidebar-empty-hint">
                还没有角色卡——去「角色卡管理」新建，或用「导入 / 导出」恢复备份
              </div>
            </div>

            <div class="sidebar-foot">
              <button class="nav-item" @click="toggleTheme" :title="isLight ? '切换到深色' : '切换到浅色'">
                <SunMedium v-if="!isLight" class="nav-icon-svg" />
                <MoonStar v-else class="nav-icon-svg" />
                {{ isLight ? '深色模式' : '浅色模式' }}
              </button>
            </div>
          </aside>

          <main class="main-area dot-grid">
            <ChatView v-show="view === 'chat'" @open-sidebar="sidebarOpen = true" @goto="onChatGoto" />
            <AffinityView v-if="view === 'affinity'" />
            <MemorySystemView v-if="view === 'memory'" />
            <UiTemplatesView v-if="view === 'uitpl'" />
            <CharactersView v-if="view === 'characters'" @open-ai-workshop="view = 'aiworkshop'" />
            <PlazaView v-if="view === 'plaza'" />
            <AiWorkshopView v-if="view === 'aiworkshop'" @close="view = 'characters'" @goto="switchView" />
            <DataView v-if="view === 'data'" @finish="switchView('chat')" />
          </main>

          <!-- 「更多」弹窗（首次打开时才加载） -->
          <MoreModal v-if="moreMounted" v-model:show="moreShow" :initial-tab="moreTab" />

          <!-- 轻量 toast -->
          <Toaster />

          <!-- 全局错误横幅（未捕获异常可见化） -->
          <div v-if="globalErrors.length" class="err-banner">
            <div v-for="(e, i) in globalErrors" :key="i" class="err-line">{{ e }}</div>
            <button class="btn sm ghost" style="margin-top: 6px" @click="globalErrors.length = 0">知道了</button>
          </div>
        </div>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>
