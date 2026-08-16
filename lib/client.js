// dsh-plugin-opencode-go-quota —— OpenCode Go 额度悬浮窗（client 端 bundle）
//
// 手写 browser bundle（官方格式：window.__ModuleLoader__.load + CJS factory）。
// 注入全局 shell.overlay 槽位：右下角圆形悬浮按钮（显示 opencode 官方图标，
// 可鼠标拖动），点击展开/收起弹窗，弹窗展示当前 OpenCode Go 套餐三个周期
// （5 小时滚动 / 每周 / 每月）的额度用量：百分比进度条 + 限额 + 重置时间。
//
// 显隐规则（与 host 联动）：
//   - 读取当前会话的模型选择（ctx.modelDirectories，provider 路由 id），
//     仅当选中模型属于 opencode go 系 provider（host 判定 visible=true）时
//     才显示按钮；切换到其他模型（deepseek-official 等）整体隐藏。
//   - host 按 provider 选择对应的 API key 与 usage 端点（两个 opencode go
//     账号：opencode-go / opencode-go-2 自定义路由）。
//
// 交互：
//   - 拖动：按住按钮拖动（pointer events，阈值 3px 区分点击/拖动），
//     位置记忆在当前页面生命周期内，弹窗锚定在按钮上方（贴顶时下方）。
//   - 弹窗打开期间每 5 分钟自动刷新，另有手动刷新按钮；× 或再点按钮收起。

window.__ModuleLoader__.load({
	id: "dsh-plugin-opencode-go-quota",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const { useState, useEffect, useCallback, useRef } = React;
		const h = React.createElement;

		const NS = "opencodeGoQuota";
		const API_URL = "/opencode-go-quota/api/usage";
		const REFRESH_MS = 5 * 60 * 1000;
		const FAB_SIZE = 52;
		const FAB_BOTTOM_OFFSET = 96;
		const POPUP_ABOVE_MIN_TOP = 340;

		const inject = ["slots", "locale"];

		// ---------------- 文案 ----------------
		const zh = {
			title: "OpenCode Go 用量",
			rolling: "5 小时滚动",
			weekly: "每周",
			monthly: "每月",
			limit: "限额",
			reset: "重置",
			updated: "更新于",
			refresh: "刷新",
			unknown: "未知",
			unauthorized: "API Key 无效或已过期（401）。",
			network: "网络请求失败或超时，请稍后重试。",
			httpError: "接口返回 HTTP {status}。",
			badJson: "接口响应解析失败。",
			noApiKey: "未找到该路由的 API Key，请在 credentials seam 配置后重试。",
			loadFailed: "额度加载失败，请重试。",
			retry: "重试",
			fabTitle: "OpenCode Go 额度",
			providerTag: "路由",
			inMin: "分钟后",
			inHour: "小时后",
			inDay: "天后",
			resetDone: "已重置",
			openParen: "（",
			closeParen: "）",
		};
		const en = {
			title: "OpenCode Go usage",
			rolling: "5h rolling",
			weekly: "Weekly",
			monthly: "Monthly",
			limit: "limit",
			reset: "resets",
			updated: "Updated",
			refresh: "Refresh",
			unknown: "unknown",
			unauthorized: "API key is invalid or expired (401).",
			network: "Network request failed or timed out, try again later.",
			httpError: "HTTP {status} from the usage endpoint.",
			badJson: "Failed to parse the usage response.",
			noApiKey: "No API key for this route; configure it in the credentials seam and retry.",
			loadFailed: "Failed to load quota, please retry.",
			retry: "Retry",
			fabTitle: "OpenCode Go quota",
			providerTag: "route",
			inMin: "min",
			inHour: "h",
			inDay: "d",
			resetDone: "reset",
			openParen: " (",
			closeParen: ")",
		};

		// ---------------- opencode 官方图标（favicon-v3.svg 内联） ----------------
		const ICON_SVG = h("svg", {
			viewBox: "0 0 512 512",
			style: { width: "66%", height: "66%", display: "block" },
			"aria-hidden": true,
		},
			h("rect", { width: 512, height: 512, fill: "#131010" }),
			h("path", { d: "M320 224V352H192V224H320Z", fill: "#5A5858" }),
			h("path", {
				fillRule: "evenodd",
				clipRule: "evenodd",
				d: "M384 416H128V96H384V416ZM320 160H192V352H320V160Z",
				fill: "#FFFFFF",
			})
		);

		// ---------------- 样式（内联，跟随 DSH 设计变量） ----------------
		const S = {
			layer: {
				position: "fixed",
				zIndex: 30,
				pointerEvents: "auto",
				display: "flex",
				flexDirection: "column",
				alignItems: "flex-end",
				fontFamily: "var(--ds-font-family, system-ui, sans-serif)",
			},
			fab: {
				width: FAB_SIZE,
				height: FAB_SIZE,
				borderRadius: "50%",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-button-floating-fill, var(--dsw-alias-bg-layer-3))",
				cursor: "grab",
				touchAction: "none",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				boxShadow: "0 4px 16px rgba(0,0,0,.28)",
				padding: 0,
				overflow: "hidden",
				transition: "transform .15s ease, background .15s ease",
			},
			panel: {
				width: 320,
				maxWidth: "calc(100vw - 40px)",
				maxHeight: "calc(100vh - 120px)",
				overflowY: "auto",
				position: "absolute",
				right: 0,
				background: "var(--dsw-alias-bg-layer-3, #1e1e24)",
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 12,
				padding: "14px 16px",
				boxShadow: "0 8px 32px rgba(0,0,0,.35)",
				display: "flex",
				flexDirection: "column",
				gap: 10,
			},
			panelHead: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
			panelTitle: { margin: 0, fontSize: 15, fontWeight: 600 },
			iconBtn: {
				border: "none",
				background: "transparent",
				color: "var(--dsw-alias-label-secondary)",
				fontSize: 16,
				cursor: "pointer",
				padding: "2px 6px",
				borderRadius: 6,
			},
			at: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
			card: {
				border: "1px solid var(--dsw-alias-border-l1)",
				background: "var(--dsw-alias-bg-layer-1)",
				borderRadius: 10,
				padding: "10px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 6,
			},
			cardHead: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 },
			cardName: { margin: 0, fontSize: 13, fontWeight: 600 },
			cardLimit: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)" },
			barTrack: { height: 7, borderRadius: 4, background: "var(--dsw-alias-bg-layer-2)", overflow: "hidden" },
			barFill: { height: "100%", borderRadius: 4, transition: "width .25s ease" },
			cardFoot: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 },
			pct: { margin: 0, fontSize: 12, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
			reset: { margin: 0, fontSize: 11, color: "var(--dsw-alias-label-tertiary)", textAlign: "right" },
			error: { margin: 0, fontSize: 13, color: "var(--dsw-alias-state-error-primary)", lineHeight: 1.5 },
			button: {
				alignSelf: "flex-start",
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary)",
				font: "inherit",
				fontSize: 12,
				cursor: "pointer",
				borderRadius: 6,
				padding: "4px 12px",
			},
		};

		// ---------------- 工具函数 ----------------
		const WINDOW_KEYS = [
			{ key: "rolling", nameKey: "rolling" },
			{ key: "weekly", nameKey: "weekly" },
			{ key: "monthly", nameKey: "monthly" },
		];

		function fmtReset(resetsAt, t) {
			if (!resetsAt) return t("unknown");
			const d = new Date(resetsAt);
			if (Number.isNaN(d.getTime())) return resetsAt;
			const diff = d.getTime() - Date.now();
			let rel = "";
			if (diff > 0) {
				const mins = Math.floor(diff / 60000);
				const op = t("openParen");
				const cl = t("closeParen");
				if (mins < 60) rel = `${op}${mins} ${t("inMin")}${cl}`;
				else if (mins < 60 * 24) rel = `${op}${Math.floor(mins / 60)} ${t("inHour")}${cl}`;
				else rel = `${op}${Math.floor(mins / (60 * 24))} ${t("inDay")}${cl}`;
			} else {
				rel = `${t("openParen")}${t("resetDone")}${t("closeParen")}`;
			}
			return d.toLocaleString() + rel;
		}

		// ---------------- 组件 ----------------
		function WindowCard(props) {
			const { title, limit, data, t } = props;
			const percent = data && typeof data.percent === "number" ? data.percent : null;
			const pct = percent === null ? 0 : Math.max(0, Math.min(100, percent));
			const color = percent === null
				? "var(--dsw-alias-label-tertiary)"
				: pct >= 80
					? "var(--dsw-alias-state-error-primary)"
					: "var(--dsw-alias-state-business-primary)";
			return h("div", { style: S.card },
				h("div", { style: S.cardHead },
					h("span", { style: S.cardName }, title),
					h("span", { style: S.cardLimit }, t("limit") + " " + limit)
				),
				h("div", { style: S.barTrack },
					h("div", { style: { ...S.barFill, width: pct + "%", background: color } })
				),
				h("div", { style: S.cardFoot },
					h("span", { style: { ...S.pct, color } }, percent === null ? t("unknown") : Math.round(percent) + "%"),
					h("span", { style: S.reset }, t("reset") + " " + fmtReset(data && data.resetsAt, t))
				)
			);
		}

		function QuotaPopover(props) {
			const { payload, phase, onRefresh, refreshing, t, above, anchorLeft } = props;
			// 垂直锚定：上方/下方；水平锚定：靠右（默认）或靠左（FAB 贴近左边缘时）
			const anchor = {
				...(above ? { bottom: "calc(100% + 10px)" } : { top: "calc(100% + 10px)" }),
				...(anchorLeft ? { left: 0, right: "auto" } : { right: 0 }),
			};
			// client 侧加载失败（无 payload）：显示通用错误面板，重试可达
			if (!payload && phase === "error") {
				return h("div", { style: { ...S.panel, ...anchor } },
					h("div", { style: S.panelHead },
						h("span", { style: S.panelTitle }, t("title")),
						h("button", { style: S.iconBtn, onClick: onRefresh, title: t("refresh") }, refreshing ? "…" : "↻")
					),
					h("p", { style: S.error }, t("loadFailed")),
					h("button", { style: S.button, onClick: onRefresh, disabled: refreshing }, t("retry"))
				);
			}
			if (!payload || payload.ok !== true || payload.visible !== true) return null;
			if (payload.error || payload.reason === "no-api-key") {
				const msg = payload.reason === "no-api-key"
					? t("noApiKey")
					: ({ unauthorized: t("unauthorized"), network: t("network"), "bad-json": t("badJson") })[payload.error]
						|| t("httpError").replace("{status}", String(payload.error).replace(/^http-/, ""));
				return h("div", { style: { ...S.panel, ...anchor } },
					h("div", { style: S.panelHead },
						h("span", { style: S.panelTitle }, t("title")),
						h("button", { style: S.iconBtn, onClick: onRefresh, title: t("refresh") }, refreshing ? "…" : "↻")
					),
					h("p", { style: S.error }, msg),
					h("button", { style: S.button, onClick: onRefresh, disabled: refreshing }, t("retry"))
				);
			}
			const usage = payload.usage || {};
			const atDate = new Date(payload.at || Date.now());
			const atLabel = Number.isNaN(atDate.getTime()) ? "" : atDate.toLocaleTimeString();
			return h("div", { style: { ...S.panel, ...anchor } },
				h("div", { style: S.panelHead },
					h("span", { style: S.panelTitle }, t("title")),
					h("button", { style: S.iconBtn, onClick: onRefresh, title: t("refresh"), disabled: refreshing }, refreshing ? "…" : "↻")
				),
				h("p", { style: S.at },
					t("updated") + " " + atLabel +
					(payload.provider ? " · " + t("providerTag") + " " + payload.provider : "")
				),
				WINDOW_KEYS.map((w) => h(WindowCard, {
					key: w.key,
					title: t(w.nameKey),
					limit: (payload.limits || {})[w.key] || "—",
					data: usage[w.key],
					t,
				}))
			);
		}

		function FloatingWidget(props) {
			const { useSessions, modelDirectories, t } = props;
			// 官方 selector hook：必须传 selector；root 槽位恒提供 useSessions
			const sessions = useSessions((s) => s);
			const sessionId = sessions && sessions.current ? sessions.current : null;
			const [open, setOpen] = useState(false);
			const [provider, setProvider] = useState(null);
			const [pos, setPos] = useState(() => ({
				left: Math.max(0, (typeof window !== "undefined" ? window.innerWidth : 1024) - FAB_SIZE - 20),
				// 默认位置：距底部上移（FAB_BOTTOM_OFFSET），避免与输入区/状态栏重叠
				top: Math.max(0, (typeof window !== "undefined" ? window.innerHeight : 768) - FAB_SIZE - FAB_BOTTOM_OFFSET),
			}));
			const [state, setState] = useState({ phase: "idle", payload: null, refreshing: false });
			const dragRef = useRef(null);
			const suppressClickRef = useRef(false);
			const seqRef = useRef(0);

			// 订阅当前会话的模型选择：provider 路由 id
			useEffect(() => {
				if (!sessionId || !modelDirectories) {
					setProvider(null);
					return undefined;
				}
				let directory;
				try {
					directory = modelDirectories.directoryFor(sessionId);
				} catch {
					setProvider(null);
					return undefined;
				}
				const read = () => {
					try {
						const snap = directory.store.getSnapshot();
						setProvider(snap && snap.current && snap.current.provider ? snap.current.provider : null);
					} catch {
						setProvider(null);
					}
				};
				read();
				directory.load().catch(() => { /* 目录刷新失败不影响订阅 */ });
				const stop = directory.store.subscribe(read);
				return () => {
					try {
						stop();
					} catch {
						/* ignore */
					}
				};
			}, [sessionId, modelDirectories]);

			// 拉取额度（host 按 provider 返回 visible + usage）
			// 序号守卫：快速切换 provider 时，丢弃过期响应（旧账号数据不能覆盖新账号）
			const load = useCallback(async () => {
				const seq = ++seqRef.current; // 空 provider 分支也递增，作废在途请求
				if (!provider) {
					setState({ phase: "idle", payload: null, refreshing: false });
					return;
				}
				setState((s) => ({ ...s, refreshing: true, phase: s.payload ? "ready" : "loading" }));
				try {
					const res = await fetch(API_URL + "?provider=" + encodeURIComponent(provider), {
						headers: { Accept: "application/json" },
						cache: "no-store",
					});
					const payload = await res.json();
					if (seq !== seqRef.current) return; // 过期响应丢弃
					setState({ phase: "ready", payload, refreshing: false });
				} catch {
					if (seq !== seqRef.current) return;
					setState((s) => ({ phase: s.payload ? "ready" : "error", payload: s.payload, refreshing: false }));
				}
			}, [provider]);

			useEffect(() => {
				load();
			}, [load]);

			// 弹窗打开期间自动刷新（provider 切走/隐藏时停止空转）
			useEffect(() => {
				if (!open || !provider) return undefined;
				const timer = setInterval(() => load(), REFRESH_MS);
				return () => clearInterval(timer);
			}, [open, provider, load]);

			// 窗口尺寸变化时把位置重新 clamp 进视口
			useEffect(() => {
				const onResize = () => {
					setPos((p) => ({
						left: Math.max(0, Math.min(window.innerWidth - FAB_SIZE, p.left)),
						top: Math.max(0, Math.min(window.innerHeight - FAB_SIZE, p.top)),
					}));
				};
				window.addEventListener("resize", onResize);
				return () => window.removeEventListener("resize", onResize);
			}, []);

			// 显隐：未选中 opencode go（provider 缺失 / host visible=false）→ 隐藏；
			// 错误态保留按钮（点开弹窗可见错误与重试，重试入口不会消失）
			if (!provider || state.phase === "idle" || state.phase === "loading") return null;
			if (state.phase === "ready" && (!state.payload || state.payload.ok !== true || state.payload.visible !== true)) return null;

			// 拖动（pointer events；3px 阈值区分点击/拖动）
			const onPointerDown = (e) => {
				dragRef.current = {
					pointerId: e.pointerId,
					startX: e.clientX,
					startY: e.clientY,
					originLeft: pos.left,
					originTop: pos.top,
					moved: false,
				};
				try {
					e.currentTarget.setPointerCapture(e.pointerId);
				} catch {
					/* ignore */
				}
			};
			const onPointerMove = (e) => {
				const d = dragRef.current;
				if (!d || d.pointerId !== e.pointerId) return;
				const dx = e.clientX - d.startX;
				const dy = e.clientY - d.startY;
				if (!d.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) d.moved = true;
				if (!d.moved) return;
				const vw = window.innerWidth;
				const vh = window.innerHeight;
				setPos({
					left: Math.max(0, Math.min(vw - FAB_SIZE, d.originLeft + dx)),
					top: Math.max(0, Math.min(vh - FAB_SIZE, d.originTop + dy)),
				});
			};
			const endDrag = (e) => {
				const d = dragRef.current;
				dragRef.current = null;
				// 拖动后浏览器仍可能补发 click：置抑制标记，交给 onClick 消费
				if (d && d.moved) suppressClickRef.current = true;
			};
			const onClick = () => {
				if (suppressClickRef.current) {
					suppressClickRef.current = false;
					return;
				}
				// 覆盖鼠标/触摸 tap 与键盘 Enter/Space（可访问性）
				setOpen(!open);
			};

			const popupAbove = pos.top >= POPUP_ABOVE_MIN_TOP;
			return h("div", { style: { ...S.layer, left: pos.left, top: pos.top } },
				open ? h(QuotaPopover, {
					payload: state.payload,
					phase: state.phase,
					onRefresh: load,
					refreshing: state.refreshing,
					t,
					above: popupAbove,
					anchorLeft: pos.left < 340,
				}) : null,
				h("button", {
					style: S.fab,
					onPointerDown,
					onPointerMove,
					onPointerUp: endDrag,
					onPointerCancel: endDrag,
					onClick,
					title: t("fabTitle"),
					"aria-label": t("fabTitle"),
					"aria-expanded": open,
					"aria-haspopup": "dialog",
				}, ICON_SVG)
			);
		}

		// ---------------- 注册 ----------------
		// 等 modelDirectories（ui-model-selection）就绪后再注册，按当前会话
		// 的模型选择驱动显隐；语言走 DSH 官方 locale 服务（跟随设置里的语言，
		// 而非浏览器 navigator.language）。
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "opencode-go-quota: dictionaries");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("shell.overlay", () => ctx.inject(["modelDirectories"], (scope) =>
				ctx.slots.register({
					name: "shell.overlay",
					id: "opencode-go-quota",
					order: 100,
					label: () => t("fabTitle"),
					inject: () => ({ t, modelDirectories: scope.modelDirectories }),
				}, FloatingWidget)
			));
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
