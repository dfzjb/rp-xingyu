<script setup lang="ts">
import { useToasts } from '../lib/toast'

const { toasts, dismiss } = useToasts()
</script>

<template>
  <div class="toaster">
    <div v-for="t in toasts" :key="t.id" class="toast" :class="'t-' + t.type" @click="dismiss(t.id)">
      <span
        class="dot"
        :style="{ background: t.type === 'success' ? '#34d399' : t.type === 'error' ? '#f87171' : t.type === 'warning' ? '#fbbf24' : '#22d3ee' }"
      />
      {{ t.text }}
    </div>
  </div>
</template>

<style scoped>
.toaster {
  position: fixed;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 500;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  pointer-events: none;
  width: min(92vw, 480px);
}
.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 9px;
  background: var(--bg-glass);
  backdrop-filter: blur(12px);
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  padding: 9px 15px;
  font-size: 0.82rem;
  color: var(--text-0);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35);
  animation: fade-slide-up 0.22s ease both;
  cursor: pointer;
}
.dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
</style>
