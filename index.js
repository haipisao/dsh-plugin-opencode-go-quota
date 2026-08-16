// 兼容转发 shim：host 运行时早期把包名解析缓存到本文件（旧主入口），
// 本 shim 把全部导出转发到 lib/index.js（真实实现，main 也已指向 lib/index.js）。
// 保留本文件仅为热更窗口兼容；新进程直接按 main 加载 lib/index.js。
export * from './lib/index.js';
