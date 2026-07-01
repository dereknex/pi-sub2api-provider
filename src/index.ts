import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

interface ProviderModelConfig {
	id: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	thinkingLevelMap?: ThinkingLevelMap;
}

/**
 * pi thinking 等级 -> provider 请求中的 reasoning_effort 取值映射。
 * 值为 null 表示该等级在该模型上不可用（pi 会从选择器中隐藏）。
 */
type ThinkingLevelMap = {
	off?: string | null;
	minimal?: string | null;
	low?: string | null;
	medium?: string | null;
	high?: string | null;
	xhigh?: string | null;
};

/**
 * sub2api 默认 thinking 等级映射。
 *
 * 上游 /models 不返回 variants 信息，sub2api 文档示例里 reasoning 模型支持
 * low / medium / high / xhigh 四档（如 gpt-5.5）。
 * - off:    上游无对应档位，设为 null 会阻止发送 reasoning_effort；
 * - minimal: 上游无 minimal，就近映射到 low；
 * - low/medium/high/xhigh: 直接透传给上游。
 */
const DEFAULT_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	off: null,
	minimal: "low",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
};

/**
 * sub2api 文档示例中各模型的默认 context / output 上限。
 * 上游 /models 不返回这些字段时回退使用。
 * key 为模型 id（小写）。
 */
const DEFAULT_MODEL_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
	"gpt-5.5": { contextWindow: 272000, maxTokens: 16384 },
	"gpt-5.4": { contextWindow: 400000, maxTokens: 128000 },
	"gpt-5.4-mini": { contextWindow: 200000, maxTokens: 128000 },
};

function getDefaultLimit(id: string): { contextWindow: number; maxTokens: number } {
	return DEFAULT_MODEL_LIMITS[id.toLowerCase()] ?? { contextWindow: 128000, maxTokens: 4096 };
}

function normalizePositiveInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
	return Math.floor(parsed);
}

function pickRemoteContextWindow(model: any): number | undefined {
	return normalizePositiveInteger(
		model.context_window ??
		model.contextWindow ??
		model.context_length ??
		model.max_context_tokens ??
		model.limit?.context ??
		model.limits?.context,
	);
}

function pickRemoteMaxTokens(model: any): number | undefined {
	return normalizePositiveInteger(
		model.max_tokens ??
		model.maxTokens ??
		model.max_output_tokens ??
		model.max_completion_tokens ??
		model.limit?.output ??
		model.limits?.output,
	);
}

interface ProviderConfig {
	baseUrl: string;
	api?: string;
	models?: ProviderModelConfig[];
}

interface ModelsConfig {
	providers?: Record<string, ProviderConfig>;
}

interface AuthEntry {
	type: string;
	key?: string;
	access?: string;
	refresh?: string;
}

type AuthConfig = Record<string, AuthEntry>;

interface RateLimit {
	limit: number;
	remaining: number;
	used: number;
	window: string;
	reset_at: string;
}

interface DailyUsage {
	date: string;
	requests: number;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	total_tokens: number;
	cost: number;
	actual_cost: number;
}

interface QuotaInfo {
	baseUrl: string;
	apiKey: string;
	rateLimits: RateLimit[];
	dailyUsage: DailyUsage[];
	todayCost: number;
	totalCost: number;
	status: string;
	mode: string;
	lastUpdated: number;
}

const quotaProviders = new Map<string, QuotaInfo>();

function normalizeWindowLabel(window: string): string {
	const value = window.toLowerCase();
	if (value === "5h") return "5h";
	if (value === "1d" || value === "daily" || value === "day") return "daily";
	if (value === "7d" || value === "weekly" || value === "week") return "weekly";
	return window || "default";
}

function formatMoney(value: number, fractionDigits = 2): string {
	return `$${value.toFixed(fractionDigits)}`;
}

function formatUsageLimit(rl: RateLimit): string {
	return `${normalizeWindowLabel(rl.window)} ${formatMoney(rl.used)}/${formatMoney(rl.limit, 0)}`;
}

function pickQuotaWindows(rateLimits: RateLimit[]): RateLimit[] {
	const wanted = ["5h", "daily", "weekly"];
	const byLabel = new Map(rateLimits.map((rl) => [normalizeWindowLabel(rl.window), rl]));
	const picked = wanted
		.map((label) => byLabel.get(label))
		.filter((rl): rl is RateLimit => Boolean(rl));
	return picked.length ? picked : rateLimits;
}

async function probeUsageEndpoint(baseUrl: string, apiKey: string): Promise<string | null> {
	const cleanBase = baseUrl.replace(/\/+$/, "");
	const root = cleanBase.replace(/\/v1\/?$/, "");

	const candidates = [
		`${cleanBase}/usage`,
		`${root}/v1/usage`,
	];

	for (const url of candidates) {
		try {
			const res = await fetch(url, {
				headers: {
					"Authorization": `Bearer ${apiKey}`,
					"Accept": "application/json",
				},
				signal: AbortSignal.timeout(5000),
			});
			if (!res.ok) continue;
			const text = await res.text();
			if (text.includes("<!doctype") || text.includes("<html")) continue;
			const data = JSON.parse(text);
			if (
				data &&
				typeof data === "object" &&
				("rate_limits" in data || "usage" in data || "daily_usage" in data)
			) {
				return url;
			}
		} catch {
			// silent
		}
	}
	return null;
}

async function updateQuota(providerId: string, usageUrl: string, apiKey: string): Promise<boolean> {
	try {
		const res = await fetch(usageUrl, {
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Accept": "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return false;
		const text = await res.text();
		if (text.includes("<!doctype") || text.includes("<html")) return false;
		const data: any = JSON.parse(text);

		const rateLimits: RateLimit[] = Array.isArray(data.rate_limits)
			? data.rate_limits.map((rl: any) => ({
				limit: Number(rl.limit ?? 0),
				remaining: Number(rl.remaining ?? 0),
				used: Number(rl.used ?? 0),
				window: rl.window ?? "",
				reset_at: rl.reset_at ?? "",
			}))
			: [];

		const dailyUsage: DailyUsage[] = Array.isArray(data.daily_usage)
			? data.daily_usage.map((day: any) => ({
				date: String(day.date ?? ""),
				requests: Number(day.requests ?? 0),
				input_tokens: Number(day.input_tokens ?? 0),
				output_tokens: Number(day.output_tokens ?? 0),
				cache_read_tokens: Number(day.cache_read_tokens ?? 0),
				cache_write_tokens: Number(day.cache_write_tokens ?? 0),
				total_tokens: Number(day.total_tokens ?? 0),
				cost: Number(day.cost ?? 0),
				actual_cost: Number(day.actual_cost ?? day.cost ?? 0),
			}))
			: [];
		const latestDay = dailyUsage[dailyUsage.length - 1];
		const todayCost = Number(data.usage?.today?.cost ?? latestDay?.cost ?? 0);
		const totalCost = Number(
			data.usage?.total?.cost ??
			dailyUsage.reduce((sum, day) => sum + day.cost, 0),
		);

		quotaProviders.set(providerId, {
			baseUrl: usageUrl,
			apiKey,
			rateLimits,
			dailyUsage,
			todayCost,
			totalCost,
			status: data.status ?? (data.isValid === true ? "valid" : "unknown"),
			mode: data.mode ?? "unknown",
			lastUpdated: Date.now(),
		});
		return true;
	} catch (e) {
		console.error(`[sub2api-quota] Error updating quota for ${providerId}:`, e);
		return false;
	}
}

function formatStatusText(providerId: string, info: QuotaInfo): string {
	const windows = pickQuotaWindows(info.rateLimits).filter((rl) => rl.limit > 0);
	if (windows.length) {
		return `● ${providerId}: ${windows.map(formatUsageLimit).join(" • ")}`;
	}
	return `● ${providerId}: daily ${formatMoney(info.todayCost)}`;
}

async function fetchModels(baseUrl: string, apiKey: string): Promise<any[] | null> {
	const url = `${baseUrl.replace(/\/+$/, "")}/models`;
	try {
		const res = await fetch(url, {
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Accept": "application/json",
			},
			signal: AbortSignal.timeout(5000),
		});
		if (res.ok) {
			const payload = await res.json();
			if (payload && Array.isArray(payload.data)) {
				return payload.data;
			}
		}
	} catch (e) {
		console.error(`[sub2api-quota] Failed to fetch models from ${url}:`, e);
	}
	return null;
}

export default async function (pi: ExtensionAPI) {
	const homedir = os.homedir();
	const authPath = path.join(homedir, ".pi", "agent", "auth.json");
	const modelsPath = path.join(homedir, ".pi", "agent", "models.json");

	let auth: AuthConfig = {};
	if (fs.existsSync(authPath)) {
		try {
			auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
		} catch (e) {
			console.error("[sub2api-quota] Error parsing auth.json:", e);
		}
	}

	let modelsConfig: ModelsConfig = {};
	if (fs.existsSync(modelsPath)) {
		try {
			modelsConfig = JSON.parse(fs.readFileSync(modelsPath, "utf-8"));
		} catch (e) {
			console.error("[sub2api-quota] Error parsing models.json:", e);
		}
	}

	if (modelsConfig.providers) {
		for (const [providerId, providerVal] of Object.entries(modelsConfig.providers)) {
			const baseUrl = providerVal.baseUrl;
			if (!baseUrl) continue;

			const authEntry = auth[providerId];
			const apiKey = authEntry?.key || authEntry?.access;
			if (!apiKey) continue;

			const usageUrl = await probeUsageEndpoint(baseUrl, apiKey);

			if (usageUrl) {
				console.log(`[sub2api-quota] Detected usage endpoint for provider: ${providerId} at ${usageUrl}`);
				await updateQuota(providerId, usageUrl, apiKey);
			} else {
				console.log(`[sub2api-quota] No usage endpoint found for provider: ${providerId} — quota display disabled`);
			}

			const modelsBase = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl.replace(/\/+$/, "")}/v1`;
			const fetchedModels = await fetchModels(modelsBase, apiKey);
			const configuredModels = new Map(
				(providerVal.models || []).map((model) => [model.id, model]),
			);
			const registeredModels = (fetchedModels || providerVal.models || []).map((m: any) => {
				const id = m.id;
				const configured = configuredModels.get(id);
				const normalizedId = id.toLowerCase().replace(/[^a-z0-9]/g, "");
				const isReasoning = configured?.reasoning ?? (
					normalizedId.includes("o1") ||
					normalizedId.includes("o3") ||
					normalizedId.includes("reasoning") ||
					normalizedId.includes("gpt5") ||
					normalizedId.includes("gpt55")
				);
				const defaultLimit = getDefaultLimit(id);
				const remoteContextWindow = pickRemoteContextWindow(m);
				const remoteMaxTokens = pickRemoteMaxTokens(m);
				return {
					...configured,
					id,
					name: m.display_name || m.name || configured?.name || id,
					reasoning: isReasoning,
					input: ["text" as const],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: remoteContextWindow ?? configured?.contextWindow ?? defaultLimit.contextWindow,
					maxTokens: remoteMaxTokens ?? configured?.maxTokens ?? defaultLimit.maxTokens,
					// 仅 reasoning 模型挂 thinkingLevelMap；非 reasoning 模型留空避免显示思考等级选择器。
					thinkingLevelMap: isReasoning
						? (configured?.thinkingLevelMap ?? DEFAULT_THINKING_LEVEL_MAP)
						: undefined,
				};
			});

			pi.registerProvider(providerId, {
				name: providerId,
				baseUrl: modelsBase,
				apiKey,
				authHeader: true,
				api: "openai-completions",
				models: registeredModels,
			});
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		const model = ctx.model;
		if (model && quotaProviders.has(model.provider)) {
			const info = quotaProviders.get(model.provider)!;
			ctx.ui.setStatus("sub2api-quota", ctx.ui.theme.fg("accent", formatStatusText(model.provider, info)));
		}
	});

	pi.on("model_select", async (event, ctx) => {
		const { model } = event;
		const providerId = model.provider;

		if (quotaProviders.has(providerId)) {
			const info = quotaProviders.get(providerId)!;
			if (Date.now() - info.lastUpdated > 60000) {
				updateQuota(providerId, info.baseUrl, info.apiKey).then(() => {
					const fresh = quotaProviders.get(providerId)!;
					ctx.ui.setStatus("sub2api-quota", ctx.ui.theme.fg("accent", formatStatusText(providerId, fresh)));
				});
			}
			ctx.ui.setStatus("sub2api-quota", ctx.ui.theme.fg("accent", formatStatusText(providerId, info)));
		} else {
			ctx.ui.setStatus("sub2api-quota", undefined);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		const model = ctx.model;
		if (model && quotaProviders.has(model.provider)) {
			const info = quotaProviders.get(model.provider)!;
			updateQuota(model.provider, info.baseUrl, info.apiKey).then(() => {
				const fresh = quotaProviders.get(model.provider)!;
				ctx.ui.setStatus("sub2api-quota", ctx.ui.theme.fg("accent", formatStatusText(model.provider, fresh)));
			});
		}
	});

	pi.registerCommand("quota", {
		description: "Display detailed billing quota info for the active provider",
		handler: async (_args, ctx) => {
			const model = ctx.model;
			if (!model) {
				ctx.ui.notify("No active model selected", "error");
				return;
			}
			const providerId = model.provider;
			if (!quotaProviders.has(providerId)) {
				ctx.ui.notify(`Provider '${providerId}' has no usage endpoint available.`, "warning");
				return;
			}

			ctx.ui.notify("Fetching latest billing info...", "info");
			const info = quotaProviders.get(providerId)!;
			const success = await updateQuota(providerId, info.baseUrl, info.apiKey);
			if (!success) {
				ctx.ui.notify("Failed to fetch billing info.", "error");
				return;
			}

			const fresh = quotaProviders.get(providerId)!;
			const latestDay = fresh.dailyUsage[fresh.dailyUsage.length - 1];
			const lines = [
				`Provider:     ${providerId}`,
				`Status:       ${fresh.status}`,
				`Mode:         ${fresh.mode}`,
				`Today Cost:   $${fresh.todayCost.toFixed(4)}`,
				`Total Cost:   $${fresh.totalCost.toFixed(4)}`,
				latestDay ? `Today Tokens: ${latestDay.total_tokens.toLocaleString()}` : undefined,
				latestDay ? `Requests:     ${latestDay.requests.toLocaleString()}` : undefined,
				"",
				"Rate Limits:",
			].filter((line): line is string => typeof line === "string");

			if (fresh.rateLimits.length === 0) {
				lines.push("  none reported by provider");
			}

			for (const rl of fresh.rateLimits) {
				const resetDate = rl.reset_at ? new Date(rl.reset_at).toLocaleString() : "unknown";
				lines.push(`  [${normalizeWindowLabel(rl.window)}]  ${formatMoney(rl.used)}/${formatMoney(rl.limit, 0)}  (remaining: ${formatMoney(rl.remaining)}, resets: ${resetDate})`);
			}

			const windows = pickQuotaWindows(fresh.rateLimits).filter((rl) => rl.limit > 0);
			if (windows.length) {
				ctx.ui.notify(windows.map(formatUsageLimit).join(" • "), "info");
			} else {
				ctx.ui.notify(`Today: ${formatMoney(fresh.todayCost)}`, "info");
			}
			console.log(lines.join("\n"));
		},
	});
}
