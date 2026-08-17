// dsh-plugin-opencode-go-quota —— OpenCode Go 额度悬浮窗（host 端）
//
// host 平面只提供一条同源 API：
//   GET /opencode-go-quota/api/usage?provider=<llm-pi-ai 路由 id>
//   -> { ok, provider, visible, reason, error, at, limits, usage }
//
// provider 对应 Settings → Models（llm-pi-ai）里的 provider 路由 id，例如：
//   - opencode-go      （Anthropic 风格，key=OPENCODE_GO_API_KEY）
//   - opencode-go-2    （自定义路由：openai-completions + baseURL，key=OPENCODE_GO_API_KEY_2）
//
// 行为：
//   - visible：仅当 provider 在可见名单内（config.visibleProviders，
//     缺省 = config.providers 的键，再缺省 = opencode-go / opencode-go-2）。
//     client 端据此决定悬浮按钮显隐（其他模型一律隐藏）。
//   - key/端点解析：config.providers[provider] 显式优先；否则从 llm-pi-ai
//     设置推导（apiKeyEnv 为 key 引用；baseURL 存在则 usage 端点 = baseURL + "/usage"，
//     否则用默认官方端点）。
//   - API key 解析：credentials seam（覆盖进程环境 / ~/.dsh/.credentials.yaml /
//     .env 回退）→ 环境变量 OPENCODE_GO_API_KEY → auth.json 兜底。

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

export const name = 'opencode-go-quota';
export const inject = ['webServer', 'credentials', 'settings'];

const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1/usage';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_LIMITS = { rolling: '$12', weekly: '$30', monthly: '$60' };
const DEFAULT_CREDIT = 60;
// 模型级月度使用额度（官方 docs「使用限制」表，2026-05 调价后）：这些模型的
// 每月使用额度只有 $15（套餐 $10/月 的 1.5 倍），其余模型为 $60（6 倍）。
// 对应各周期限额 = 套餐限额 × credit/60：$12/$30/$60 → $3/$7.5/$15。
const MODEL_CREDITS = {
  'grok-4.5': 15,
  'gpt-5.6-luna': 15,
  'glm-5.3': 15,
  'kimi-k3': 15,
  'mimo-v2.5-pro': 15,
  'qwen3.8-max': 15,
  'deepseek-v4-pro': 15,
  'deepseek-v4-flash': 15,
};
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly'];
const KNOWN_PROVIDERS = ['opencode-go', 'opencode-go-2'];

/**
 * 按 key 引用解析 API key。
 * - 显式 keyRef（config.providers / 设置 apiKeyEnv）时：只解析该引用，
 *   避免多账号串号（缺 key 就报 no-api-key，绝不静默用别的账号）；
 * - 未显式指定时：仅当 allowDefaultFallback（默认 provider opencode-go）才允许
 *   credentials seam → 环境变量 OPENCODE_GO_API_KEY → auth.json 兜底；
 *   其他 provider 缺 keyRef 一律返回 undefined（no-api-key）。
 * - auth.json 按平台探测候选路径，支持 OPENCODE_GO_AUTH_PATH 覆盖。
 */
async function resolveApiKey(ctx, keyRef, allowDefaultFallback) {
  const explicit = typeof keyRef === 'string' && keyRef.trim() !== '';
  const refs = explicit ? [keyRef.trim()] : (allowDefaultFallback ? ['OPENCODE_GO_API_KEY'] : []);
  for (const ref of refs) {
    try {
      const cred = await ctx.credentials.resolve(ref);
      if (cred && typeof cred.value === 'string' && cred.value.trim() !== '') return cred.value.trim();
    } catch {
      /* fall through */
    }
  }
  if (!explicit && allowDefaultFallback) {
    try {
      const fromEnv = process.env.OPENCODE_GO_API_KEY;
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    } catch {
      /* fall through */
    }
    for (const authPath of authJsonCandidates()) {
      try {
        const raw = JSON.parse(await readFile(authPath, 'utf8'));
        const entry = raw['opencode-go'] ?? raw['opencode'];
        if (entry && entry.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) {
          return entry.key;
        }
      } catch {
        /* 下一个候选 */
      }
    }
  }
  return undefined;
}

/** OpenCode CLI auth.json 候选路径（按平台；可用 OPENCODE_GO_AUTH_PATH 覆盖）。 */
function authJsonCandidates() {
  const out = [];
  if (process.env.OPENCODE_GO_AUTH_PATH) out.push(process.env.OPENCODE_GO_AUTH_PATH);
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) out.push(join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'));
    if (process.env.APPDATA) out.push(join(process.env.APPDATA, 'opencode', 'auth.json'));
  } else if (process.platform === 'darwin') {
    out.push(join(homedir(), 'Library', 'Application Support', 'opencode', 'auth.json'));
  }
  out.push(join(homedir(), '.local', 'share', 'opencode', 'auth.json'));
  return out;
}

/** 防御性提取单个周期窗口（percent/resetsAt 容错；空串/null percent 视为未知）。 */
function pickWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const raw = w.percent;
  const percent = typeof raw === 'number' ? raw : (raw === '' || raw == null ? Number.NaN : Number(raw));
  return {
    status: typeof w.status === 'string' ? w.status : null,
    percent: Number.isFinite(percent) ? percent : null,
    resetsAt: typeof w.resetsAt === 'string' ? w.resetsAt : null,
  };
}

/** 限额显示文本：config.limits 覆盖 -> 内置默认（套餐静态值，仅作参考）。 */
function pickLimits(cfg) {
  const out = { ...DEFAULT_LIMITS };
  const lim = cfg && typeof cfg === 'object' && cfg.limits && typeof cfg.limits === 'object'
    ? cfg.limits
    : null;
  if (lim) {
    for (const key of WINDOW_KEYS) {
      const v = lim[key];
      if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim();
    }
  }
  return out;
}

/** 模型 id 归一化：剥掉 "provider/" 前缀（opencode-go/deepseek-v4-flash → deepseek-v4-flash）。 */
function normalizeModelId(model) {
  if (typeof model !== 'string') return null;
  const m = model.trim();
  if (!m) return null;
  const idx = m.indexOf('/');
  return idx >= 0 ? m.slice(idx + 1) : m;
}

/** 模型月度使用额度（美元）：config.modelCredits 覆盖 -> 内置表 -> 默认 $60。 */
function creditFor(cfg, model) {
  const id = normalizeModelId(model);
  if (!id) return DEFAULT_CREDIT;
  const overrides = cfg && typeof cfg === 'object' && cfg.modelCredits && typeof cfg.modelCredits === 'object'
    ? cfg.modelCredits
    : null;
  if (overrides) {
    for (const key of [id, typeof model === 'string' ? model.trim() : null]) {
      if (key == null) continue;
      const v = overrides[key];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
    }
  }
  const known = MODEL_CREDITS[id];
  return typeof known === 'number' ? known : DEFAULT_CREDIT;
}

/** 按模型额度缩放限额文本：限额 × credit/60（$12/$30/$60 → $3/$7.5/$15）。 */
function scaleLimits(base, credit) {
  const factor = credit / DEFAULT_CREDIT;
  const out = { ...base };
  for (const key of WINDOW_KEYS) {
    const v = base[key];
    const m = typeof v === 'string' ? v.match(/\$?\s*([0-9]+(?:\.[0-9]+)?)/) : null;
    if (m) {
      const n = Number(m[1]) * factor;
      out[key] = '$' + (Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10));
    }
  }
  return out;
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const baseLimits = pickLimits(cfg);
  const providersCfg = cfg.providers && typeof cfg.providers === 'object' && !Array.isArray(cfg.providers)
    ? cfg.providers
    : {};
  const visibleProviders = Array.isArray(cfg.visibleProviders) && cfg.visibleProviders.length > 0
    ? cfg.visibleProviders.map((v) => String(v))
    : (Object.keys(providersCfg).length > 0 ? Object.keys(providersCfg) : [...KNOWN_PROVIDERS]);

  /** 读取 Settings → Models（llm-pi-ai）的 provider 表，读不到返回 {}。 */
  function providerSettings() {
    try {
      const pi = ctx.settings.get('llm-pi-ai');
      return pi && typeof pi === 'object' && pi.providers && typeof pi.providers === 'object'
        ? pi.providers
        : {};
    } catch {
      return {};
    }
  }

  /** 解析一个 provider 的 { usageUrl, keyRef }；不认识返回 null。 */
  function resolveProvider(provider) {
    // 1) 插件 config.providers 显式优先（hasOwn 防原型链键）
    if (Object.hasOwn(providersCfg, provider)) {
      const explicit = providersCfg[provider];
      if (explicit && typeof explicit === 'object') {
        return {
          usageUrl: typeof explicit.usageUrl === 'string' && explicit.usageUrl.trim() !== ''
            ? explicit.usageUrl.trim()
            : DEFAULT_BASE_URL,
          keyRef: typeof explicit.keyRef === 'string' && explicit.keyRef.trim() !== ''
            ? explicit.keyRef.trim()
            : undefined,
        };
      }
    }
    // 2) llm-pi-ai 设置推导（apiKeyEnv + baseURL）
    const settings = providerSettings();
    if (Object.hasOwn(settings, provider)) {
      const p = settings[provider];
      if (p && typeof p === 'object') {
        const baseURL = typeof p.baseURL === 'string' && p.baseURL.trim() !== ''
          ? p.baseURL.trim()
          : undefined;
        return {
          usageUrl: baseURL ? baseURL.replace(/\/+$/, '') + '/usage' : DEFAULT_BASE_URL,
          keyRef: typeof p.apiKeyEnv === 'string' && p.apiKeyEnv.trim() !== ''
            ? p.apiKeyEnv.trim()
            : undefined,
        };
      }
    }
    return null;
  }

  // ctx.effect 包裹：register 返回 disposer，fiber 卸载/HMR 重启时自动移除路由，
  // 避免僵尸路由（重复路径再注册会 throw，之前踩过）。
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/opencode-go-quota/api/usage',
    handler: async (req, res) => {
      // 仅接受 GET/HEAD；其他方法 405（避免任意方法触发带 key 的对外请求）
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
        return;
      }
      const send = (status, body) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(JSON.stringify(body));
      };
      const at = new Date().toISOString();

      let provider = null;
      let model = null;
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        provider = (url.searchParams.get('provider') ?? '').trim() || null;
        model = (url.searchParams.get('model') ?? '').trim() || null;
      } catch {
        provider = null;
        model = null;
      }
      // 限额按所选模型缩放（modelCredits 表：$15 额度模型 → $3/$7.5/$15）
      const credit = creditFor(cfg, model);
      const limits = scaleLimits(baseLimits, credit);
      if (!provider) {
        send(200, { ok: true, provider: null, model, visible: false, reason: 'no-provider', error: null, at, credit, limits, usage: null });
        return;
      }

      const visible = visibleProviders.includes(provider);
      const resolved = resolveProvider(provider);
      if (!resolved) {
        send(200, { ok: true, provider, model, visible: false, reason: 'unknown-provider', error: null, at, credit, limits, usage: null });
        return;
      }

      // 不可见：不拉取，直接返回（前端负责隐藏）
      if (!visible) {
        send(200, { ok: true, provider, model, visible: false, reason: 'not-visible', error: null, at, credit, limits, usage: null });
        return;
      }

      const apiKey = await resolveApiKey(ctx, resolved.keyRef, provider === 'opencode-go');
      if (!apiKey) {
        send(200, { ok: true, provider, model, visible: true, reason: 'no-api-key', error: null, at, credit, limits, usage: null });
        return;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let resp;
      try {
        resp = await fetch(resolved.usageUrl, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: controller.signal,
        });
      } catch {
        send(200, { ok: true, provider, model, visible: true, reason: null, error: 'network', at, credit, limits, usage: null });
        return;
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 401) {
        send(200, { ok: true, provider, model, visible: true, reason: null, error: 'unauthorized', at, credit, limits, usage: null });
        return;
      }
      if (!resp.ok) {
        send(200, { ok: true, provider, model, visible: true, reason: null, error: `http-${resp.status}`, at, credit, limits, usage: null });
        return;
      }

      let body;
      try {
        body = await resp.json();
      } catch {
        send(200, { ok: true, provider, model, visible: true, reason: null, error: 'bad-json', at, credit, limits, usage: null });
        return;
      }

      const usage = body && typeof body === 'object' && body.usage ? body.usage : body;
      send(200, {
        ok: true,
        provider,
        model,
        visible: true,
        reason: null,
        error: null,
        at,
        credit,
        limits,
        usage: {
          rolling: pickWindow(usage && usage.rolling),
          weekly: pickWindow(usage && usage.weekly),
          monthly: pickWindow(usage && usage.monthly),
        },
      });
    },
  }), 'opencode-go-quota: usage route');

  console.log(`[opencode-go-quota] GET /opencode-go-quota/api/usage ready (visibleProviders=${visibleProviders.join(',')}, timeoutMs=${timeoutMs}ms)`);
}
