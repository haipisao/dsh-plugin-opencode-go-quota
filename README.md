# dsh-plugin-opencode-go-quota

OpenCode Go 额度悬浮窗 —— DeepSeek Harness (DSH) Web GUI 插件。

> 本插件由 **DeepSeek V4 Flash**（`deepseek-v4-flash`）开发，全程在 DSH 会话中完成设计、实现、调试与发布。

页面右下角**圆形悬浮按钮**（opencode 官方图标，**可鼠标拖动**），点击展开**弹窗**
展示当前所选 OpenCode Go 账号套餐各周期额度（5 小时滚动 / 每周 / 每月）的已用
百分比、限额与重置时间；再点按钮或 × 收起。弹窗打开期间每 5 分钟自动刷新。

**核心行为**：仅当当前会话选中的模型属于 opencode go 系 provider 时才显示按钮，
切换到其他模型（如 deepseek-official）自动隐藏；多 opencode go 账号（含自定义
路由）按所选 provider 自动对应各自的 API key 与额度。

## 安装

### 方式一：从 GitHub 安装（推荐）

```bash
dsh plugin --profile web add github:haipisao/dsh-plugin-opencode-go-quota
```

### 方式二：从打包 tarball 安装

```bash
# 解压或直接指向 tgz（npm pack 产物）
dsh plugin --profile web add ./dsh-plugin-opencode-go-quota-0.1.0.tgz
```

### 方式三：本地源码目录（开发）

```bash
dsh plugin --profile web add ./packages/dsh-plugin-opencode-go-quota
```

### 注册行（三种方式都需要）

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加（HMR 注册即生效，无需重启）：

```yaml
- insert:
    - id: opencode-go-quota
      name: dsh-plugin-opencode-go-quota
      config:
        timeoutMs: 15000
        visibleProviders: [opencode-go, opencode-go-2]
        providers:
          opencode-go:
            usageUrl: https://opencode.ai/zen/go/v1/usage
            keyRef: OPENCODE_GO_API_KEY
          opencode-go-2:
            usageUrl: https://opencode.ai/zen/go/v1/usage
            keyRef: OPENCODE_GO_API_KEY_2
```

> 首次安装新 bundle 后，若 HMR 未生效，重启一次 `dsh web` 即可。

## 使用

1. 刷新页面，在「设置 → 模型」里确保有 opencode-go 系 provider（Anthropic 或
   openai-completions 风格均可），并配置对应 API key：
   - `OPENCODE_GO_API_KEY`（credentials seam：`~/.dsh/.credentials.yaml` 或环境变量）
   - 第二个账号 `OPENCODE_GO_API_KEY_2`（如需）
   - 也可不配置，host 会回退读 OpenCode CLI 的 `~/.local/share/opencode/auth.json`
2. 把会话模型切到 opencode go 系（如 `opencode-go/deepseek-v4-flash`）——
   右下角出现 opencode 图标按钮（可拖动）。
3. 点击按钮展开弹窗：三个周期额度（百分比进度条 + 限额 + 重置时间）、
   当前「路由」标识、手动刷新；再点按钮或 × 收起。
4. 切到其他模型 → 按钮自动隐藏。

## 数据源

官方用量端点（未公开文档，解析为防御式）：

```http
GET https://opencode.ai/zen/go/v1/usage
Authorization: Bearer <API_KEY>
```

返回 `usage.rolling / usage.weekly / usage.monthly` 三个窗口的 `percent`（0–100）
与 `resetsAt`（ISO-8601）。限额（`$12 / $30 / $60`）为套餐静态值，仅作参考，
可在配置里覆盖。

## host API（可选，自检用）

```
GET /opencode-go-quota/api/usage?provider=<llm-pi-ai 路由 id>
```

- `visible: true/false`：provider 是否在可见名单；未知 provider / 缺 key 返回
  结构化原因（`unknown-provider` / `no-api-key`），不抛错。
- key 与端点解析：`config.providers` 显式优先，否则从
  Settings → Models（llm-pi-ai）的 `apiKeyEnv` / `baseURL` 推导。

## 配置（注册行 config）

| Key | 默认 | 含义 |
| --- | --- | --- |
| `timeoutMs` | `15000` | 拉取超时（毫秒） |
| `visibleProviders` | `providers` 的键；缺省 `[opencode-go, opencode-go-2]` | 显示悬浮窗的 provider 名单 |
| `providers.<id>.usageUrl` | 设置推导（baseURL + `/usage`）或官方默认 | 该路由的用量端点 |
| `providers.<id>.keyRef` | 设置推导（apiKeyEnv） | 该路由的凭据引用（credentials seam / env） |
| `limits` | `$12/$30/$60` | 三周期限额显示文本 |

## 验证

```bash
node --check lib/index.js && node --check lib/client.js
curl "http://127.0.0.1:3080/opencode-go-quota/api/usage?provider=opencode-go-2"     # visible:true + 该账号额度
curl "http://127.0.0.1:3080/opencode-go-quota/api/usage?provider=deepseek-official"  # visible:false
dsh --profile web --dump-config | grep opencode-go-quota                            # 注册行已挂载
```

## 结构

| 文件 | 角色 |
| --- | --- |
| `lib/index.js` | host 端：同源 API（读 key → 拉官方端点 → 按 provider 归一化返回） |
| `lib/client.js` | client 端 bundle：`shell.overlay` 槽位注入图标按钮 + 弹窗（手写 `window.__ModuleLoader__.load` 格式，免构建）；拖动、按选中模型显隐 |
| `cordis.patch.yml` | 空 patch（注册统一走 profile 层，避免重启后 duplicate loader entry id） |
| `index.js` | 兼容转发 shim（开发热更场景用，新进程直接按 main 加载 lib/index.js） |

## License

MIT
