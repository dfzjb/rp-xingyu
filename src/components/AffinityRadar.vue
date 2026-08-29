<script setup lang="ts">
/**
 * 好感度雷达图（蜘蛛网样式）：
 * - 四层六边形蛛网，弦边微微向中心内垂（真蜘蛛网质感）；三根对轴直径
 * - 数据面用闭合 Catmull-Rom 平滑成有机曲线：径向渐变粉填充 + 柔光 + 顶点圆点
 * - 六轴从 AFFINITY_AXES 派生（单一事实源，与编辑弹窗双端滑条同组对轴）；
 *   渲染前必须按角度排序，否则多边形连线自交成星形
 */
import { computed } from 'vue'
import { AFFINITY_AXES, type NpcAffinity } from '../lib/affinity'

const props = withDefaults(defineProps<{
  row: NpcAffinity
  size?: number
  showLabels?: boolean
}>(), {
  size: 220,
  showLabels: true,
})

/** 每条对轴正面端的角度（°，0 = 正上方顺时针）：兴趣左上、吸引右上、信任正上；负面端 = 正面端 + 180° */
const AXIS_ANGLES = [300, 60, 0]

interface RadarAxis { key: keyof NpcAffinity; label: string; angle: number; neg: boolean }

const AXES: RadarAxis[] = AFFINITY_AXES.flatMap((ax, i) => [
  { key: ax.pos, label: ax.posLabel, angle: AXIS_ANGLES[i], neg: false },
  { key: ax.neg, label: ax.negLabel, angle: (AXIS_ANGLES[i] + 180) % 360, neg: true },
]).sort((a, b) => a.angle - b.angle)

const uid = `radar-${Math.random().toString(36).slice(2, 8)}`

const c = computed(() => props.size / 2)
const R = computed(() => c.value - (props.showLabels ? 30 : 6))

function pt(angleDeg: number, r: number): [number, number] {
  const a = (angleDeg * Math.PI) / 180
  return [c.value + r * Math.sin(a), c.value - r * Math.cos(a)]
}

function val(key: keyof NpcAffinity): number {
  const v = Number(props.row[key])
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0))
}

/** 六边形蛛网的一层：弦边向中心内垂 sag 比例，形成蜘蛛网质感 */
function ringPath(r: number, sag = 0.09): string {
  const pts = AXES.map((ax) => pt(ax.angle, r))
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2
    const cx = mx + (c.value - mx) * sag, cy = my + (c.value - my) * sag
    d += ` Q ${cx},${cy} ${b[0]},${b[1]}`
  }
  return d + ' Z'
}

const rings = [0.25, 0.5, 0.75, 1].map((lv) => ({ lv, d: ringPath(R.value * lv) }))

const spokes = computed(() =>
  AXES.filter((ax) => !ax.neg).map((ax) => {
    const [x1, y1] = pt(ax.angle, R.value)
    const [x2, y2] = pt(ax.angle + 180, R.value)
    return { x1, y1, x2, y2 }
  }),
)

/** 数据面：闭合 Catmull-Rom 平滑（s=0.5 轻度），曲线仍精确过各顶点 */
const dataGeo = computed(() => {
  const pts = AXES.map((ax) => pt(ax.angle, (R.value * val(ax.key)) / 100))
  const n = pts.length
  const s = 0.5
  let d = `M ${pts[0][0]},${pts[0][1]}`
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n], p3 = pts[(i + 2) % n]
    const c1x = p1[0] + ((p2[0] - p0[0]) / 6) * s
    const c1y = p1[1] + ((p2[1] - p0[1]) / 6) * s
    const c2x = p2[0] - ((p3[0] - p1[0]) / 6) * s
    const c2y = p2[1] - ((p3[1] - p1[1]) / 6) * s
    d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`
  }
  return { d: d + ' Z', pts }
})

const labels = computed(() =>
  AXES.map((ax) => {
    const [x, y] = pt(ax.angle, R.value + 14)
    return {
      ...ax,
      x, y,
      anchor: ax.angle % 180 === 0 ? 'middle' : (ax.angle < 180 ? 'start' : 'end'),
      dy: ax.angle === 0 ? -2 : ax.angle === 180 ? 9 : 4,
    }
  }),
)
</script>

<template>
  <svg :width="size" :height="size" :viewBox="`0 0 ${size} ${size}`" class="affinity-radar" aria-label="好感度雷达图">
    <defs>
      <radialGradient :id="uid" cx="50%" cy="50%" r="65%">
        <stop offset="0%" stop-color="rgba(244,114,182,0.5)" />
        <stop offset="100%" stop-color="rgba(244,114,182,0.12)" />
      </radialGradient>
      <filter :id="`${uid}-glow`" x="-40%" y="-40%" width="180%" height="180%">
        <feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="#f472b6" flood-opacity="0.45" />
      </filter>
    </defs>

    <!-- 蛛网：外层最清晰，向内渐淡 -->
    <path
      v-for="ring in rings"
      :key="ring.lv"
      :d="ring.d"
      fill="none"
      :stroke="`rgba(148,163,184,${0.16 + ring.lv * 0.22})`"
      :stroke-width="ring.lv === 1 ? 1.1 : 0.8"
    />
    <line
      v-for="(s, i) in spokes"
      :key="i"
      :x1="s.x1" :y1="s.y1" :x2="s.x2" :y2="s.y2"
      stroke="rgba(148,163,184,0.3)"
      stroke-width="0.8"
    />

    <!-- 数据面：平滑曲线 + 渐变 + 柔光 -->
    <path
      :d="dataGeo.d"
      :fill="`url(#${uid})`"
      stroke="#f472b6"
      stroke-width="1.8"
      stroke-linejoin="round"
      :filter="`url(#${uid}-glow)`"
    />
    <circle
      v-for="(p, i) in dataGeo.pts"
      :key="i"
      :cx="p[0]" :cy="p[1]"
      :r="showLabels ? 2.6 : 1.8"
      fill="#f472b6"
      stroke="rgba(255,255,255,0.9)"
      stroke-width="1"
    />

    <template v-if="showLabels">
      <text
        v-for="l in labels"
        :key="l.key"
        :x="l.x" :y="l.y + l.dy"
        :text-anchor="l.anchor"
        class="radar-label"
        :class="{ neg: l.neg }"
      >{{ l.label }}</text>
    </template>
  </svg>
</template>

<style scoped>
.affinity-radar { display: block; }
.radar-label {
  font-size: 11px;
  font-weight: 600;
  fill: var(--text-1, #e5e7eb);
  paint-order: stroke;
  stroke: rgba(0, 0, 0, 0.28);
  stroke-width: 2.5px;
  stroke-linejoin: round;
}
.radar-label.neg { fill: var(--text-2, #94a3b8); font-weight: 400; }
</style>
