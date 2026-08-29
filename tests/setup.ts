// 全局注入 IndexedDB 内存实现：db.ts 在 import 时即构造 Dexie 实例，必须最先执行
import 'fake-indexeddb/auto'
