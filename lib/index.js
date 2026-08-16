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
const WINDOW_KEYS = ['rolling', 'weekly', 'monthly'];
const KNOWN_PROVIDERS = ['opencode-go', 'opencode-go-2'];

/**
 * 按 key 引用解析 API key。
 * - 显式 keyRef（config.providers / 设置 apiKeyEnv）时：只解析该引用，
 *   避免多账号串号（缺 key 就报 no-api-key，绝不静默用别的账号）；
 * - 未显式指定时：credentials seam（覆盖进程环境 / ~/.dsh/.credentials.yaml /
 *   .env 回退）→ 环境变量 OPENCODE_GO_API_KEY → auth.json 兜底。
 */
async function resolveApiKey(ctx, keyRef) {
  const explicit = typeof keyRef === 'string' && keyRef.trim() !== '';
  const refs = explicit ? [keyRef.trim()] : ['OPENCODE_GO_API_KEY'];
  for (const ref of refs) {
    try {
      const cred = await ctx.credentials.resolve(ref);
      if (cred && typeof cred.value === 'string' && cred.value.trim() !== '') return cred.value.trim();
    } catch {
      /* fall through */
    }
  }
  if (!explicit) {
    try {
      const fromEnv = process.env.OPENCODE_GO_API_KEY;
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    } catch {
      /* fall through */
    }
    try {
      const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
      const raw = JSON.parse(await readFile(authPath, 'utf8'));
      const entry = raw['opencode-go'] ?? raw['opencode'];
      if (entry && entry.type === 'api' && typeof entry.key === 'string' && entry.key.length > 0) {
        return entry.key;
      }
    } catch {
      /* fall through */
    }
  }
  return undefined;
}

/** 防御性提取单个周期窗口（percent/resetsAt 容错）。 */
function pickWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const percent = typeof w.percent === 'number' ? w.percent : Number(w.percent);
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

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {};
  const timeoutMs = Number.isFinite(cfg.timeoutMs) && cfg.timeoutMs > 0
    ? cfg.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const limits = pickLimits(cfg);
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
    // 1) 插件 config.providers 显式优先
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
    // 2) llm-pi-ai 设置推导（apiKeyEnv + baseURL）
    const p = providerSettings()[provider];
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
    return null;
  }

  ctx.webServer.register({
    kind: 'exact',
    path: '/opencode-go-quota/api/usage',
    handler: async (req, res) => {
      const send = (status, body) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-cache',
        });
        res.end(JSON.stringify(body));
      };
      const at = new Date().toISOString();

      let provider = null;
      try {
        const url = new URL(req.url ?? '/', 'http://x');
        provider = url.searchParams.get('provider');
      } catch {
        provider = null;
      }
      if (!provider) {
        send(200, { ok: true, provider: null, visible: false, reason: 'no-provider', error: null, at, usage: null, limits });
        return;
      }

      const visible = visibleProviders.includes(provider);
      const resolved = resolveProvider(provider);
      if (!resolved) {
        send(200, { ok: true, provider, visible: false, reason: 'unknown-provider', error: null, at, usage: null, limits });
        return;
      }

      // 不可见：不拉取，直接返回（前端负责隐藏）
      if (!visible) {
        send(200, { ok: true, provider, visible: false, reason: 'not-visible', error: null, at, usage: null, limits });
        return;
      }

      const apiKey = await resolveApiKey(ctx, resolved.keyRef);
      if (!apiKey) {
        send(200, { ok: true, provider, visible: true, reason: 'no-api-key', error: null, at, usage: null, limits });
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
        send(200, { ok: true, provider, visible: true, reason: null, error: 'network', at, usage: null, limits });
        return;
      } finally {
        clearTimeout(timer);
      }

      if (resp.status === 401) {
        send(200, { ok: true, provider, visible: true, reason: null, error: 'unauthorized', at, usage: null, limits });
        return;
      }
      if (!resp.ok) {
        send(200, { ok: true, provider, visible: true, reason: null, error: `http-${resp.status}`, at, usage: null, limits });
        return;
      }

      let body;
      try {
        body = await resp.json();
      } catch {
        send(200, { ok: true, provider, visible: true, reason: null, error: 'bad-json', at, usage: null, limits });
        return;
      }

      const usage = body && typeof body === 'object' && body.usage ? body.usage : body;
      send(200, {
        ok: true,
        provider,
        visible: true,
        reason: null,
        error: null,
        at,
        usage: {
          rolling: pickWindow(usage && usage.rolling),
          weekly: pickWindow(usage && usage.weekly),
          monthly: pickWindow(usage && usage.monthly),
        },
        limits,
      });
    },
  });

  console.log(`[opencode-go-quota] GET /opencode-go-quota/api/usage ready (visibleProviders=${visibleProviders.join(',')}, timeoutMs=${timeoutMs}ms)`);
}
