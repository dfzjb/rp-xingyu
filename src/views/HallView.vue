<script setup lang="ts">
import { computed, ref } from 'vue'
import { Dices, ExternalLink, Globe } from 'lucide-vue-next'
import { useSettingsStore } from '../stores/settings'
import { toast } from '../lib/toast'

const settings = useSettingsStore()
const draft = ref('')

const hallUrl = computed(() => (settings.settings.hallUrl || '').trim())

async function saveUrl(v: string) {
  const u = v.trim().replace(/\/+$/, '')
  await settings.patch({ hallUrl: u })
  toast.success(`跑团地址已保存${u ? '' : '（已清空）'}`)
  draft.value = ''
}

function openInNewTab() {
  if (hallUrl.value) window.open(hallUrl.value, '_blank', 'noopener')
}
</script>

<template>
  <div class="view-page">
    <div class="page-scroll">
      <div class="page-inner" style="max-width: 960px">
        <!-- 未配置：引导 -->
        <div v-if="!hallUrl" class="card-panel" style="padding: 22px; text-align: center">
          <Dices :size="34" style="color: var(--accent); margin-bottom: 8px" />
          <div style="font-size: 1.05rem; font-weight: 700; margin-bottom: 4px">在线跑团</div>
          <p class="dim" style="font-size: 0.82rem; max-width: 460px; margin: 0 auto 14px">
            在线跑团是独立部署的「星屿·跑团」（rp-hall）：多人房间、AI 主持、
            剧情只存在房主浏览器、中继全程密文转发。填入你部署的前端地址即可启用入口。
          </p>
          <div style="display: flex; gap: 10px; max-width: 480px; margin: 0 auto">
            <input
              v-model="draft"
              class="input mono"
              style="flex: 1"
              placeholder="https://hall.example.com"
              @keyup.enter="saveUrl(draft)"
            />
            <button class="btn primary" style="white-space: nowrap" @click="saveUrl(draft)">保存地址</button>
          </div>
        </div>

        <!-- 已配置：内嵌 -->
        <template v-else>
          <div class="card-panel" style="margin-bottom: 12px; padding: 10px 14px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap">
            <Globe :size="16" />
            <span class="dim" style="font-size: 0.8rem; flex: 1; min-width: 200px" title="跑团是独立应用，其数据与本站互不共享">
              {{ hallUrl }}
            </span>
            <input
              v-model="draft"
              class="input mono"
              style="max-width: 280px; font-size: 0.78rem"
              placeholder="改为其他地址"
              @keyup.enter="saveUrl(draft)"
            />
            <button v-if="draft.trim()" class="btn sm" @click="saveUrl(draft)">更新</button>
            <button class="btn ghost sm" @click="openInNewTab">
              <ExternalLink :size="14" style="vertical-align: -2px" />
              新窗口打开
            </button>
          </div>
          <iframe
            :src="hallUrl"
            class="hall-frame"
            title="星屿·跑团"
            allow="clipboard-write"
          />
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hall-frame {
  width: 100%;
  height: calc(100vh - 150px);
  min-height: 480px;
  border: 1px solid var(--line-c, rgba(128, 128, 128, 0.25));
  border-radius: 12px;
  background: #070a13;
}
</style>
