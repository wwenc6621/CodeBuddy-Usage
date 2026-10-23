"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const auth_1 = require("./auth");
/**
 * 本地化入口：语言自动跟随 VS Code 显示语言（vscode.env.language）。
 * 代码内文案统一写英文（即默认语言），简体中文译文见 l10n/bundle.l10n.zh-cn.json；
 * 未命中译文时 l10n 会自动回落为传入的英文原文。
 */
function t(message, ...args) {
    return vscode.l10n.t(message, ...args.map((a) => a ?? ""));
}
let statusBarItem;
let timer;
let lastResult;
let lastUpdatedAt;
let lastCheckin;
let lastBuddy;
/** 最近一次刷新时生效的鉴权状态（用于悬浮框展示模式与 token 有效期） */
let lastAuth;
let lastBuddyAutoDate = ""; // 本地日期字符串，用于「一日一次」自动触发出发守卫
/** 已处理过的旅行标识（depart_at）：同一趟旅行只尝试领取一次，避免重复调用 claim */
let lastBuddyClaimKey = "";
/** 领取失败警告的「一日一次」守卫（与出发守卫、领取守卫解耦） */
let lastBuddyClaimErrorDate = "";
/**
 * 上次刷新时喵喵是否在旅行中。用于识别「旅行刚结束」这一状态迁移——
 * 它不依赖任何响应字段，即使服务端在「已到达」时清空 depart_at / arrive_at 也不会漏领。
 */
let lastBuddyWasTraveling = false;
/** 防止并发 update 互相覆盖导致状态栏反复闪动/丢失 */
let updating = false;
const DEFAULT_PACKAGE_CODES = [
    "TCACA_code_008_cfWoLwvjU4",
    "TCACA_code_009_0XmEQc2xOf",
    "TCACA_code_038_OhvqZtiPKr",
    "TCACA_code_007_nzdH5h4Nl0",
    "TCACA_code_028_NtpWi0jzXs",
    "TCACA_code_029_6wCGEWquYy",
    "TCACA_code_030_BjSt89qTvr",
];
/**
 * 请求 UA：保持浏览器 UA 形态（部分网关对非浏览器 UA 更严格）。
 *
 * 早期 Cookie 模式时服务端把会话与 UA 强绑定，UA 必须可配置；改用 accessToken
 * 后 UA 不再参与鉴权，固定一个浏览器 UA 即可，因此不再提供配置项。
 */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";
/** 扩展自己的 SecretStorage（VS Code 负责加解密，读写不会触发系统授权） */
let secretsStore;
/** 持久化 token 缓存键：把读到的 token 存下来，避免反复访问钥匙串 */
const TOKEN_CACHE_KEY = "codebuddyUsage.cachedAccessToken";
let tokenStore;
/** 组装持久化 token 缓存实现（依赖 activate 中注入的 secretsStore） */
function getTokenStore() {
    if (!secretsStore)
        return undefined;
    if (!tokenStore) {
        const secrets = secretsStore;
        tokenStore = {
            get: async () => {
                const raw = await secrets.get(TOKEN_CACHE_KEY);
                if (!raw)
                    return undefined;
                try {
                    return JSON.parse(raw);
                }
                catch {
                    return undefined;
                }
            },
            set: async (value) => {
                if (value)
                    await secrets.store(TOKEN_CACHE_KEY, JSON.stringify(value));
                else
                    await secrets.delete(TOKEN_CACHE_KEY);
            },
        };
    }
    return tokenStore;
}
/**
 * 读取当前生效的鉴权状态（见 auth.ts）：
 * 持久化缓存 → 钥匙串自动读取 CodeBuddy 登录态 → 手动输入的 accessToken。
 */
async function currentAuth() {
    return (0, auth_1.getAuth)({ manualToken: getConfig().get("accessToken", "") });
}
/**
 * 带鉴权的 fetch：
 * - 统一注入 `Authorization: Bearer`，UA 一并带上；
 * - **只有 401 才算登录失效**：清缓存（含持久化缓存）并允许重新读取系统登录态后重试一次。
 *
 * 为什么不把 403 当登录失效：这套接口会用 403 承载**业务结果**，例如
 * `POST /activity/growth/buddy/travel/claim` 在「没有可领取的旅行积分」时返回
 * `403 {"code":403,"msg":"no unclaimed travel"}`；而 token 真的无效时网关（apisix）
 * 返回的是 401。早期版本把 403 一并当成过期，于是「喵喵无可领积分」这种正常状态
 * 会表现为「登录已过期」并清掉 token 缓存，点击也修不好。
 * 403 一律原样返回，交给调用方按 body 里的 code/msg 处理。
 *
 * 另外，重试前必须 `invalidateAuth(true)`：默认的 `invalidateAuth()` 不解除
 * 「本次会话不再读取系统凭据」的封锁，会拿同一个失效 token 重试，必然再失败。
 */
async function authFetch(url, init) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const auth = await currentAuth();
        if (auth.mode === "none")
            throw new Error("NO_CREDENTIALS");
        const headers = {
            ...(init.headers ?? {}),
            ...(0, auth_1.authHeaders)(auth),
            "user-agent": USER_AGENT,
        };
        const resp = await fetch(url, { ...init, headers });
        if (resp.status === 401) {
            (0, auth_1.invalidateAuth)(true);
            continue;
        }
        return resp;
    }
    throw new Error("AUTH_EXPIRED");
}
function getConfig() {
    return vscode.workspace.getConfiguration("codebuddyUsage");
}
/**
 * 状态栏图标：统一使用 codicon（$(icon) 语法）。
 * 所有基于 VS Code 内核的宿主（VS Code / Trae / CodeBuddy IDE 等）
 * 的状态栏均按同一套逻辑渲染 `$(icon)`，因此不再按 appName 区分，
 * 保证各宿主显示一致。
 *
 * 注意：状态栏文本里 `$(icon)` 会渲染；hover Markdown 不识别该语法，
 * 需直接用 Unicode/emoji。
 */
function icon(codicon) {
    return `$(${codicon})`;
}
// ============================================================
// 1. 用量拉取
// ============================================================
async function fetchUsage() {
    const cfg = getConfig();
    const apiBase = cfg.get("apiBase", "https://www.workbuddy.cn").replace(/\/$/, "");
    const body = {
        PageNumber: 1,
        PageSize: 200,
        ProductCode: "p_tcaca",
        Status: [0, 3],
        OnlyValidPeriod: true,
        PackageCodes: DEFAULT_PACKAGE_CODES,
        NeedInUsage: true,
    };
    const resp = await authFetch(`${apiBase}/billing/meter/get-user-resource`, {
        method: "POST",
        headers: {
            accept: "application/json, text/plain, */*",
            "content-type": "application/json",
            origin: apiBase,
            referer: `${apiBase}/profile/plans-usage`,
            "x-client-platform": "web",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        throw new Error(`HTTP_${resp.status}`);
    }
    const json = await resp.json();
    const accounts = json?.data?.Response?.Data?.Accounts ?? [];
    let remain = 0;
    let total = 0;
    for (const a of accounts) {
        // 优先用本周期 (CycleCapacity*) 字段：本周期内当下能用的积分。
        // - 一次性发放的包（裂变包）：Cycle 与 Capacity 相等，结果不变
        // - 周期制包（个人体验版每月赠送）：本周期用完即 0，下周期才补上
        //   避免把下月还没到期的"未来额度"算进"当前剩余"，导致体验版用完后仍显示余量
        const cycleRemain = a.CycleCapacityRemainPrecise;
        const cycleSize = a.CycleCapacitySizePrecise;
        let accRemain;
        let accSize;
        if (cycleRemain != null && cycleSize != null) {
            accRemain = parseFloat(cycleRemain) || 0;
            accSize = parseFloat(cycleSize) || 0;
        }
        else {
            accRemain = parseFloat(a.CapacityRemainPrecise ?? "0") || 0;
            accSize = parseFloat(a.CapacitySizePrecise ?? "0") || 0;
        }
        remain += accRemain;
        // 总量只统计"还有余量"的套餐：已耗尽的套餐不再计入分母，
        // 否则会把用光的包当成仍可用的额度，导致剩余百分比被拉低、显示偏乐观
        if (accRemain > 0) {
            total += accSize;
        }
    }
    return { remain, total, accounts };
}
// ============================================================
// 2. 签到（与用量查询共用 accessToken 鉴权）
// ============================================================
/** 拼装签到接口的公共请求头（鉴权头由 authFetch 统一注入） */
function checkinHeaders() {
    const apiBase = getConfig().get("apiBase", "https://www.workbuddy.cn").replace(/\/$/, "");
    return {
        "content-type": "application/json",
        accept: "application/json",
        origin: apiBase,
        referer: `${apiBase}/profile/plans-usage`,
        "x-client-platform": "web",
    };
}
/** 读取错误响应体，便于定位 400 等原因（截断避免过长） */
async function readErrorBody(resp) {
    try {
        const t = await resp.text();
        return t.length > 300 ? t.slice(0, 300) + "…" : t;
    }
    catch {
        return "";
    }
}
/** 查询签到状态 */
async function fetchCheckinStatus() {
    const cfg = getConfig();
    const apiBase = cfg.get("apiBase", "https://www.workbuddy.cn").replace(/\/$/, "");
    try {
        const resp = await authFetch(`${apiBase}/billing/meter/checkin-status`, {
            method: "POST",
            headers: checkinHeaders(),
            body: "{}",
        });
        let json = null;
        try {
            json = await resp.json();
        }
        catch {
            // 响应体非 JSON（极少数情况），交给下方状态码分支处理
        }
        // 网关对「今日已签到」返回 HTTP 400 + code=10001（幂等），视为已签到
        if (json?.code === 10001) {
            return { state: "claimed" };
        }
        if (!resp.ok) {
            const body = json ? JSON.stringify(json) : await readErrorBody(resp);
            return { state: "unknown", error: `HTTP_${resp.status}${body ? " " + body : ""}` };
        }
        const checked = json?.data?.today_checked_in;
        if (checked === true) {
            return { state: "claimed" };
        }
        return { state: "unclaimed" };
    }
    catch (e) {
        if (e?.message === "AUTH_EXPIRED" || e?.message === "NO_CREDENTIALS")
            throw e;
        return { state: "unknown", error: e?.message ?? String(e) };
    }
}
/** 执行签到领取 */
async function doCheckin() {
    const cfg = getConfig();
    const apiBase = cfg.get("apiBase", "https://www.workbuddy.cn").replace(/\/$/, "");
    try {
        const resp = await authFetch(`${apiBase}/billing/meter/daily-checkin`, {
            method: "POST",
            headers: checkinHeaders(),
            body: "{}",
        });
        let json = null;
        try {
            json = await resp.json();
        }
        catch {
            // 响应体非 JSON，交给下方状态码分支处理
        }
        // 网关对「今日已签到」返回 HTTP 400 + code=10001（幂等），视为已签到
        if (json?.code === 10001) {
            return { state: "claimed" };
        }
        if (!resp.ok) {
            const body = json ? JSON.stringify(json) : await readErrorBody(resp);
            return { state: "unknown", error: `HTTP_${resp.status}${body ? " " + body : ""}` };
        }
        const code = json?.code;
        if (code === 0) {
            // 本次新签到成功：弹提示
            return { state: "claimed", credit: json?.data?.credit, freshlyClaimed: true };
        }
        if (code === 10001) {
            // 当日已签到：接口幂等拒绝，视为已签到（早已签到，不弹提示）
            return { state: "claimed" };
        }
        // 未知 code：再查一次状态兜底
        const st = await fetchCheckinStatus();
        if (st.state === "claimed")
            return st;
        return { state: "unknown", error: `code=${code} msg=${json?.msg ?? ""}` };
    }
    catch (e) {
        if (e?.message === "AUTH_EXPIRED" || e?.message === "NO_CREDENTIALS")
            throw e;
        return { state: "unknown", error: e?.message ?? String(e) };
    }
}
/**
 * 获取今日签到状态；若尚未签到则自动领取。
 * 与用量查询共用同一鉴权；未配置任何凭据时返回 unknown（不影响主流程）。
 */
async function ensureCheckin() {
    const auth = await currentAuth();
    if (auth.mode === "none") {
        return { state: "unknown", error: t("No credentials found") };
    }
    const status = await fetchCheckinStatus();
    if (status.state === "claimed") {
        return status;
    }
    if (status.state === "unclaimed") {
        return await doCheckin();
    }
    return status;
}
// ============================================================
// 3. 喵喵旅行（派喵喵出任务赚积分）
// ============================================================
const BUDDY_PATH = "/activity/growth/buddy/travel";
/** 拼装喵喵接口的公共请求头（鉴权头由 authFetch 统一注入） */
function buddyHeaders() {
    const apiBase = getConfig().get("apiBase", "https://www.workbuddy.cn").replace(/\/$/, "");
    return {
        "content-type": "application/json",
        accept: "application/json, text/plain, */*",
        origin: apiBase,
        referer: `${apiBase}/profile/growth-center`,
        "x-client-platform": "web",
    };
}
/**
 * 调用喵喵接口（鉴权失败由 authFetch 抛出 AUTH_EXPIRED / NO_CREDENTIALS）。
 *
 * 注意：这套接口的「业务失败」用 HTTP 403 承载（如 `claim` 返回
 * `403 {"code":403,"msg":"no unclaimed travel"}`），因此这里不看 HTTP 状态码，
 * 只把 body 解析出来交给调用方判断；body 不是 JSON 时才用状态码兜底。
 */
async function callBuddyApi(sub, method, body) {
    const apiBase = getConfig().get("apiBase", "https://www.workbuddy.cn").replace(/\/$/, "");
    const init = { method, headers: buddyHeaders() };
    if (body !== undefined)
        init.body = body;
    const resp = await authFetch(`${apiBase}${BUDDY_PATH}/${sub}`, init);
    const json = await resp.json().catch(() => undefined);
    if (!json || typeof json !== "object")
        return { code: resp.status, msg: `HTTP_${resp.status}` };
    if (json.code == null)
        json.code = resp.status;
    return json;
}
/** 查询喵喵状态 */
async function fetchBuddyStatus() {
    try {
        const json = await callBuddyApi("status", "GET");
        if (json?.code !== 0)
            return null;
        const d = json?.data ?? {};
        return {
            state: d.state,
            departAt: d.depart_at,
            arriveAt: d.arrive_at,
            serverNow: d.server_now,
            // duration_hours 实际位于 location 子对象里（顶层通常没有），两处都兜底
            durationHours: d.duration_hours ?? d.location?.duration_hours,
            rewardCredit: d.reward_credit,
            dailyLimitReached: d.daily_limit_reached,
            locationName: d.location?.name,
        };
    }
    catch {
        return null;
    }
}
/**
 * 查询旅行记录里的到账积分（reward_credit）。
 *
 * status 接口虽然也有 reward_credit 字段，但实测恒为 0，不能代表本次到账积分；
 * 旅行记录接口（records）每条记录里的 reward_credit 才是真实值（如 8）。
 * 给定 departAt 时优先按出发时间匹配本趟旅行，匹配不到则退回最新一条。
 */
async function fetchTravelRewardCredit(departAt) {
    try {
        const json = await callBuddyApi("records?page=1&page_size=20", "GET");
        if (json?.code !== 0)
            return undefined;
        const records = json?.data?.records ?? [];
        if (records.length === 0)
            return undefined;
        const hit = departAt != null ? records.find((r) => r.depart_at === departAt) : undefined;
        const credit = (hit ?? records[0])?.reward_credit;
        return typeof credit === "number" ? credit : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * 领取喵喵挣的积分。
 * claimed=true 表示服务端已确认本次领取（code=0）；此时 credit 可能因响应字段缺失
 * 而拿不到数值（与 depart 的 duration_hours 是同一类坑），调用方需另行兜底，
 * 不能把它当成「无可领取」而静默，否则会出现「积分到账了却没有任何提示」。
 */
async function claimBuddy() {
    try {
        const json = await callBuddyApi("claim", "POST", "{}");
        if (json?.code === 0)
            return { claimed: true, credit: json?.data?.credit };
        const msg = json?.msg ?? `HTTP_${json?.code ?? ""}`;
        // 服务端返回 no unclaimed travel 表示「当前没有可领取的旅行积分」，
        // 属于正常状态（如积分已被之前的流程领取过），不算失败
        if (/no unclaimed/i.test(msg))
            return { credit: 0 };
        return { error: msg };
    }
    catch (e) {
        if (e?.message === "AUTH_EXPIRED" || e?.message === "NO_CREDENTIALS")
            throw e;
        return { error: e?.message ?? String(e) };
    }
}
/** 从 status 数据解析旅行时长（小时）：优先 duration_hours，其次由到达/出发时间差推算 */
function resolveTravelHours(st) {
    if (!st)
        return undefined;
    if (st.durationHours != null && st.durationHours > 0)
        return st.durationHours;
    if (st.arriveAt != null && st.departAt != null && st.arriveAt > st.departAt) {
        const h = (st.arriveAt - st.departAt) / 3600;
        return h > 0 ? Math.round(h * 10) / 10 : undefined;
    }
    return undefined;
}
/** 派出喵喵出任务；location_id 默认 1 */
async function departBuddy(locationId = 1) {
    try {
        const json = await callBuddyApi("depart", "POST", JSON.stringify({ location_id: locationId }));
        if (json?.code === 0) {
            // 实测 depart 响应里的时长字段不可靠（可能缺失，也可能带占位值 0；
            // `??` 不会跳过 0，导致此前 0.8.1 即使回查逻辑存在也拿不到真实时长）。
            // 服务端真正登记的旅行时长在 status 接口的 duration_hours 里（与网页展示一致），
            // 因此 depart 成功后一律回查 status：有效则采用；status 拿不到时才退回
            // depart 响应里的正数字段，最后才兜底 0。
            const departHours = json?.data?.duration_hours ?? json?.data?.duration;
            let hours = resolveTravelHours(await fetchBuddyStatus());
            if (hours == null && typeof departHours === "number" && departHours > 0) {
                hours = departHours;
            }
            return { hours: hours != null && hours > 0 ? hours : 0 };
        }
        return { error: json?.msg ?? `HTTP_${json?.code ?? ""}` };
    }
    catch (e) {
        if (e?.message === "AUTH_EXPIRED" || e?.message === "NO_CREDENTIALS")
            throw e;
        return { error: e?.message ?? String(e) };
    }
}
/** 本地日期字符串（用于一日一次守卫） */
function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * 自动喵喵：当喵喵处于「可出发」状态且今日尚未自动触发过时，
 * 先领取积分再派出喵喵；一日仅自动触发一次（state 变为 traveling 后自然不再触发，
 * 并辅以本地日期守卫防止同日往返后重复出发）。
 */
async function ensureBuddy() {
    const buddyTravel = getConfig().get("buddyTravel", false);
    if (!buddyTravel)
        return undefined;
    const status = await fetchBuddyStatus();
    if (!status)
        return undefined;
    const buddy = { status };
    const backFromTravel = status.state != null && status.state !== "traveling";
    // 修复：领积分与「出发」解耦。旅行结束后喵喵处于「已到达」状态，
    // 此时即使当日已达上限（dailyLimitReached=true，无法再出发），
    // 也必须尝试领取本次旅行挣到的积分，否则积分会一直滞留在服务端。
    //
    // 守卫改为「一趟旅行一次」而非「一日一次」：一日一次会让当天第二趟及之后的旅行
    // 积分滞留在服务端，且因为根本没调用 claim 而完全没有提示。
    // 同一趟旅行（depart_at 相同）只尝试一次即可——claim 对「无可领取」是幂等的。
    const isTraveling = status.state === "traveling";
    // 「旅行刚结束」的状态迁移是最可靠的触发信号，不依赖任何响应字段；
    // 与旅行标识守卫取「或」，双重保险，确保一天内多趟旅行（如跨天旅行 +
    // 当天新旅行）的积分都能被领取，不会因为日期守卫而整趟漏掉
    const travelJustEnded = lastBuddyWasTraveling && !isTraveling;
    const travelKey = String(status.departAt ?? status.arriveAt ?? status.state ?? "");
    if (backFromTravel && (travelJustEnded || travelKey !== lastBuddyClaimKey)) {
        const c = await claimBuddy().catch((e) => ({ error: e?.message ?? String(e) }));
        if (c.error) {
            buddy.claim = { error: c.error };
            // 失败不记录 travelKey，下轮刷新继续重试；但警告一天最多弹一次
            if (lastBuddyClaimErrorDate !== todayStr()) {
                buddy.freshlyClaimFailed = true;
                lastBuddyClaimErrorDate = todayStr();
            }
        }
        else {
            // 服务端已确认领取（claimed）：响应里的 credit 可能缺失或为占位 0，
            // 此时用 status 登记的本次旅行奖励积分 reward_credit 兜底，
            // 避免「积分到账了却当成无可领取而静默」
            let credit = c.credit;
            if (c.claimed && !(credit > 0)) {
                // status 的 reward_credit 实测为 0 不可用，改从旅行记录接口取真实到账积分
                credit = await fetchTravelRewardCredit(status.departAt);
            }
            buddy.claim = { credit: credit ?? 0 };
            // 只要服务端确认领取成功就提示（数量未知时提示不带数量）
            if (c.claimed)
                buddy.freshlyClaimed = true;
            lastBuddyClaimKey = travelKey;
        }
    }
    const canDepart = backFromTravel && !status.dailyLimitReached;
    if (canDepart && lastBuddyAutoDate !== todayStr()) {
        const d = await departBuddy().catch((e) => ({ error: e?.message ?? String(e) }));
        if (d.hours != null) {
            buddy.depart = { hours: d.hours };
            buddy.freshlyDeparted = true;
        }
        else if (d.error) {
            buddy.depart = { error: d.error };
        }
        const st2 = await fetchBuddyStatus();
        if (st2)
            buddy.status = st2;
        lastBuddyAutoDate = todayStr();
    }
    // 用本次刷新结束时的最新状态记录，供下次刷新判断「旅行刚结束」
    lastBuddyWasTraveling = (buddy.status?.state ?? status.state) === "traveling";
    return buddy;
}
/**
 * 把状态栏切到「凭据异常」样式，并把点击行为指向 fixAuth。
 *
 * 早期版本这里直接指向 `setAccessToken`，用户点了只会弹一个 JWT 输入框——
 * 但登录过期的真正解法是「在 CodeBuddy 里重新登录 + 重读登录态」，
 * 绝大多数人既拿不到 JWT 也无从下手，于是表现为「点了也修不好」。
 */
function showAuthProblem(problem) {
    const note = lastAuth?.note;
    if (problem === "none") {
        statusBarItem.text = `${icon("key")} ${t("No credentials found")}`;
        statusBarItem.tooltip =
            t("Sign in to the CodeBuddy extension (VS Code), or set an Access Token manually") +
                "\n\n" +
                t("Click to retry reading the sign-in state") +
                (note ? `\n\n${note}` : "");
        statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    }
    else {
        statusBarItem.text = `${icon("error")} ${t("Login expired")}`;
        statusBarItem.tooltip =
            t("The CodeBuddy extension sign-in expired — sign in again, or set an Access Token manually") +
                "\n\n" +
                t("Click to retry reading the sign-in state") +
                (note ? `\n\n${note}` : "");
        statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    }
    statusBarItem.command = "codebuddyUsage.fixAuth";
    statusBarItem.show();
}
/**
 * 凭据异常的修复菜单：重新读取登录态 / 手动输入 Token / 清除手动 Token / 打开官网。
 * 「重新读取」会解除「本次会话不再读系统凭据」的封锁，因此无需重启 IDE 就能恢复。
 */
async function fixAuth() {
    const manual = getConfig().get("accessToken", "").trim();
    const items = [
        {
            label: `$(refresh) ${t("Re-read the CodeBuddy sign-in state and refresh")}`,
            detail: t("Use this right after signing in again in the CodeBuddy extension"),
            action: "retry",
        },
        { label: `$(key) ${t("Paste Access Token")}`, action: "token" },
    ];
    if (manual) {
        items.push({
            label: `$(trash) ${t("Clear the manually entered Access Token")}`,
            detail: t("Use this when the pasted token itself has expired"),
            action: "clear",
        });
    }
    items.push({
        label: `$(link-external) ${t("Open the usage page (to confirm sign-in)")}`,
        action: "page",
    });
    const pick = await vscode.window.showQuickPick(items, {
        title: t("CodeBuddy Usage: Sign-in problem"),
        placeHolder: t("Sign in to CodeBuddy in VS Code first, then pick a recovery action"),
        ignoreFocusOut: true,
    });
    if (!pick)
        return;
    if (pick.action === "retry") {
        // allowCredentialRetry：清掉「本次会话不再读取系统凭据」的封锁，真正重读一次
        (0, auth_1.invalidateAuth)(true);
        (0, auth_1.resetAutoReadBlock)();
        await update();
        // 重读后仍然是凭据异常 → 说明 CodeBuddy 自己也没登录，给一句明确结论，别让用户继续盲点
        if (statusBarItem.command === "codebuddyUsage.fixAuth") {
            vscode.window.showWarningMessage(t("CodeBuddy Usage: Still no valid sign-in — sign in to CodeBuddy in VS Code first, then retry"));
        }
        return;
    }
    if (pick.action === "token") {
        await setAccessToken();
        return;
    }
    if (pick.action === "clear") {
        await getConfig().update("accessToken", "", vscode.ConfigurationTarget.Global);
        (0, auth_1.resetAutoReadBlock)();
        (0, auth_1.invalidateAuth)(true);
        vscode.window.showInformationMessage(t("CodeBuddy Usage: Access Token cleared, retrying auto-read"));
        await update();
        return;
    }
    const apiBase = getConfig().get("apiBase", "https://www.workbuddy.cn");
    await vscode.env.openExternal(vscode.Uri.parse(`${apiBase}/profile/plans-usage`));
}
// ============================================================
// 工具函数
// ============================================================
function formatNumber(n) {
    return parseFloat(n.toFixed(2)).toString();
}
function formatDateTime(d) {
    const p = (n) => String(n).padStart(2, "0");
    return (`${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ` +
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`);
}
/** 解析到期时间字符串为时间戳；缺失或无法解析返回 Infinity（排序时置于最后） */
function parseExpiry(s) {
    if (!s)
        return Number.POSITIVE_INFINITY;
    const normalized = s.includes("T") ? s : s.replace(" ", "T");
    const t = Date.parse(normalized);
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}
// ============================================================
// 状态栏渲染（纯数字样式）
// ============================================================
function renderResult(res, updatedAt) {
    statusBarItem.text = `${icon("zap")} ${formatNumber(res.remain)}`;
    statusBarItem.tooltip = buildTooltip(res, updatedAt);
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
}
/**
 * 喵喵旅行结果提示，与签到保持同一策略：
 * 本次真正操作成功（领到积分 / 派出成功）才弹信息提示；
 * 无可领取、今日已完成、已在旅行中均静默，避免每 30 分钟自动刷新反复打扰。
 * 仅操作失败时弹警告（受「一日一次」守卫限制，一天最多一次）。
 */
function notifyBuddyResult(buddy) {
    if (!buddy)
        return;
    const claim = buddy.claim;
    const depart = buddy.depart;
    const parts = [];
    if (buddy.freshlyClaimed) {
        // 服务端确认领取成功即提示：有数量就带数量，数量未知时只提示已领取，
        // 绝不因为响应里没给 credit 就静默
        parts.push(claim?.credit > 0
            ? t("Claimed {0} credits", claim.credit)
            : t("Buddy travel credits claimed"));
    }
    else if (buddy.freshlyClaimFailed && claim?.error) {
        // 失败警告受「一日一次」守卫限制，避免每 30 分钟刷新反复弹窗
        vscode.window.showWarningMessage(t("CodeBuddy Usage: Failed to claim buddy credits ({0})", claim.error));
    }
    if (buddy.freshlyDeparted && depart?.hours != null) {
        parts.push(t("Buddy departed, travel time {0} hours", depart.hours));
    }
    else if (depart?.error) {
        vscode.window.showWarningMessage(t("CodeBuddy Usage: Buddy failed to depart ({0})", depart.error));
    }
    if (parts.length > 0) {
        vscode.window.showInformationMessage(t("CodeBuddy Usage: Buddy travel — {0}", parts.join(", ")));
    }
}
async function update() {
    if (!statusBarItem)
        return;
    // 已有刷新在途时直接复用结果，避免并发请求互相覆盖状态栏
    if (updating)
        return;
    updating = true;
    // 立即给出刷新反馈，避免点击后“无变化”的错觉
    statusBarItem.text = `${icon("sync~spin")} ${t("Refreshing…")}`;
    statusBarItem.tooltip = t("Fetching CodeBuddy usage…");
    statusBarItem.backgroundColor = undefined;
    statusBarItem.show();
    try {
        lastAuth = await currentAuth();
        const autoCheckin = getConfig().get("autoCheckin", true);
        // 先签到 + 派喵喵领取积分，再拉取用量。
        // 否则用量接口会在积分到账前就返回，导致余量/总量不含本次领取的积分。
        // 签到与喵喵相互独立，可并行；用量查询必须等两者完成后再执行。
        const [checkin, buddy] = await Promise.all([
            autoCheckin ? ensureCheckin() : Promise.resolve(undefined),
            ensureBuddy(),
        ]);
        lastCheckin = checkin;
        // 喵喵旅行：仅当开启时拉取/触发，关闭时返回 undefined（悬浮框不展示喵喵状态）
        lastBuddy = buddy;
        // 用量查询放在签到 + 喵喵领取之后，确保总量/余量已包含本次到账积分
        const res = await fetchUsage();
        lastResult = res;
        lastUpdatedAt = new Date();
        renderResult(res, lastUpdatedAt);
        // 恢复正常后点击行为重置为刷新
        statusBarItem.command = "codebuddyUsage.refresh";
        // 仅首次领取成功 / 领取失败才提示；早已签到则静默（避免每次点击都弹）
        if (autoCheckin && checkin?.freshlyClaimed) {
            vscode.window.showInformationMessage(checkin.credit
                ? t("CodeBuddy Usage: Daily check-in done (+{0})", checkin.credit)
                : t("CodeBuddy Usage: Daily check-in done"));
        }
        else if (autoCheckin && checkin?.state === "unclaimed") {
            vscode.window.showWarningMessage(t("CodeBuddy Usage: Daily check-in failed, will retry later"));
        }
        // 喵喵旅行：与签到一致，仅在本次真正领到积分/派出成功时提示
        notifyBuddyResult(buddy);
    }
    catch (e) {
        const msg = e?.message ?? String(e);
        if (msg === "NO_CREDENTIALS") {
            showAuthProblem("none");
        }
        else if (msg === "AUTH_EXPIRED") {
            showAuthProblem("expired");
        }
        else {
            statusBarItem.text = `${icon("warning")} ${t("Fetch failed")}`;
            statusBarItem.tooltip = t("Error: {0}\nClick to retry", msg);
            statusBarItem.command = "codebuddyUsage.refresh";
            statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
            statusBarItem.show();
        }
    }
    finally {
        updating = false;
    }
}
/**
 * 悬浮框中「鉴权」标签：
 * - 有凭据时只显示有效期截止日（能拉到积分本身就说明已登录，无需再写「已登录」）；
 * - 读不到凭据时才提示「未登录」。
 */
function authTag() {
    const a = lastAuth;
    if (!a)
        return "";
    if (a.token) {
        if (!a.expiresAt)
            return "";
        const d = new Date(a.expiresAt);
        const p = (n) => String(n).padStart(2, "0");
        // 与「仅显示前 5 条」提示保持一致：整句斜体，只给日期加行内代码样式
        return t("_Until `{0}`_", `${p(d.getMonth() + 1)}-${p(d.getDate())}`);
    }
    return t("`⚠ Not signed in`");
}
function checkinTag() {
    // 配置关闭时不展示签到标签
    if (!getConfig().get("autoCheckin", true))
        return "";
    // Hover Markdown 不支持 $(icon) 语法，直接用 Unicode 符号表达签到状态
    if (!lastCheckin)
        return t("`❔ Unknown`");
    if (lastCheckin.state === "claimed")
        return t("`✓ Checked in`");
    if (lastCheckin.state === "unclaimed")
        return t("`○ Not checked in`");
    return lastCheckin.error
        ? t("`⚠ Error ({0})`", lastCheckin.error)
        : t("`⚠ Error`");
}
/** 悬浮框中「喵喵」状态标签：旅行倒计时 / 领积分 / 去旅行（可点击） */
function buddyTag() {
    if (!getConfig().get("buddyTravel", false))
        return "";
    const b = lastBuddy;
    if (!b || !b.status)
        return t("✿ `Unknown`");
    if (b.status.state === "traveling") {
        // 静态倒计时：基于接口返回的 serverNow 与 arriveAt 计算，悬浮框展示时显示一次即可，不自动刷新
        const nowSec = b.status.serverNow ?? Math.floor(Date.now() / 1000);
        const remain = Math.max(0, (b.status.arriveAt ?? 0) - nowSec);
        const hh = Math.floor(remain / 3600);
        const mm = Math.floor((remain % 3600) / 60);
        const ss = remain % 60;
        const pad = (n) => String(n).padStart(2, "0");
        return t("✿ Countdown {0}:{1}:{2}", pad(hh), pad(mm), pad(ss));
    }
    // 今日喵喵任务已完成（达到每日领取/出发上限）：
    // 若本次刷新有领取结果则一并展示，避免「已到达但积分未领取」被误导为已完成
    if (b.status.dailyLimitReached) {
        const c = b.claim;
        if (c && c.credit != null) {
            return c.credit > 0 ? t("✿ Done today · +{0}", c.credit) : t("✿ Done today");
        }
        if (c && c.error) {
            return t("✿ Claim failed ({0})", c.error);
        }
        return t("✿ Done today");
    }
    // 空闲/已到达：展示可点击的「领积分」「去旅行」，或操作结果
    const parts = [];
    if (b.claim && b.claim.credit != null) {
        parts.push(b.claim.credit > 0
            ? t("{0} claimed", b.claim.credit)
            : t("Nothing to claim"));
    }
    else {
        parts.push(t('[Claim](command:codebuddyUsage.buddyClaim "Claim credits earned by your buddy")'));
    }
    if (b.depart && b.depart.hours != null) {
        parts.push(t("Travel {0}h", b.depart.hours));
    }
    else {
        parts.push(t('[Depart](command:codebuddyUsage.buddyDepart "Send your buddy on a task to earn credits")'));
    }
    return `✿ ${parts.join(" · ")}`;
}
/** 仅用既有数据重建悬浮框（用于手动操作后的即时刷新，不重新拉取用量） */
function refreshTooltip() {
    if (lastResult) {
        statusBarItem.tooltip = buildTooltip(lastResult, lastUpdatedAt);
    }
}
/** markdown 文本转义：昵称里可能出现空格外的特殊字符，避免破坏标题/图片语法 */
function mdText(s) {
    return s.replace(/([\\`*_[\]()<>!|])/g, "\\$1");
}
/**
 * 头像展示尺寸（CSS 像素）。
 * markdown 图片语法无法指定尺寸，只能让服务端按需求裁剪：
 * 用 COS 的 `imageMogr2/thumbnail/NxN/iradius/N/2/format/png` 直接返回 N 像素的圆形图。
 * 20px 与标题文字的行高接近，再大就会显得头像压过文字。
 *
 * 注意不能用 `imageMogr2/circle`：它输出 RGB，四角被填成白色，深色主题下会是个白方块；
 * `iradius` + `format/png` 输出带 alpha 的 PNG（小尺寸时为调色板 + tRNS，同样透明），
 * 圆外才是真透明。
 */
const AVATAR_PX = 20;
/**
 * 悬浮框标题：能读到账号信息时显示「头像 + 昵称 · CodeBuddy 积分余量」，
 * 否则回落到原文案。
 *
 * 头像是 COS 签名 URL，签名过期后不可访问（markdown 会渲染成破图），
 * 因此只在签名有效时附带。
 */
function titleLine() {
    const profile = lastAuth?.profile;
    const nickname = (profile?.nickname ?? "").trim();
    if (!nickname)
        return t("### CodeBuddy Credits");
    const name = mdText(nickname);
    let avatar = "";
    if ((0, auth_1.avatarUsable)(profile)) {
        const url = profile.avatarUrl;
        const sep = url.includes("?") ? "&" : "?";
        const radius = AVATAR_PX / 2;
        // alt 留空：万一图片加载失败，不会把昵称重复渲染成文字
        avatar =
            `![](${url}${sep}imageMogr2/thumbnail/${AVATAR_PX}x${AVATAR_PX}` +
                `/iradius/${radius}/format/png) `;
    }
    return `### ${avatar}${name} · ${t("CodeBuddy Credits")}`;
}
function buildTooltip(res, updatedAt) {
    const totalRemain = formatNumber(res.remain);
    const totalSize = formatNumber(res.total);
    const pct = res.total > 0 ? (res.remain / res.total) * 100 : 0;
    // 过滤掉本周期余量为 0 的套餐（周期制体验版用完即隐藏），再按到期时间升序
    const visible = res.accounts
        .filter((a) => {
        const r = a.CycleCapacityRemainPrecise ?? a.CapacityRemainPrecise ?? "0";
        return (parseFloat(r) || 0) > 0;
    })
        .sort((a, b) => parseExpiry(a.CycleEndTime) - parseExpiry(b.CycleEndTime));
    const plansUrl = `${getConfig()
        .get("apiBase", "https://www.workbuddy.cn")
        .replace(/\/$/, "")}/profile/plans-usage`;
    const lines = [];
    lines.push(titleLine());
    lines.push(``);
    const remainLine = t("Remaining: `{0}` / [{1}]({2}) ({3}%)", totalRemain, totalSize, plansUrl, pct.toFixed(1));
    const hint = visible.length > 5 ? t("_{0} packages, showing the first 5_", visible.length) : "";
    const auth = authTag();
    // 第一张表：Remaining 作表头，「提示 + 凭据有效期」作数据行；
    // 同样是 4 列，结构与下方套餐表一致，末列右对齐
    lines.push(`| ${remainLine} |  |  |  |`);
    lines.push(`| --- | ---: | ---: | ---: |`);
    if (hint || auth) {
        lines.push(`| ${hint} |  |  | ${auth} |`);
    }
    lines.push(``);
    lines.push(t("| Package | Left | Total | Expires |"));
    // 末列右对齐，使底部“最近更新”贴住表格右缘
    lines.push(`| --- | ---: | ---: | ---: |`);
    if (visible.length === 0) {
        lines.push(t("| _No packages left_ |  |  |  |"));
    }
    else {
        for (const a of visible.slice(0, 5)) {
            const remain = formatNumber(parseFloat(a.CycleCapacityRemainPrecise ?? a.CapacityRemainPrecise ?? "0"));
            const size = formatNumber(parseFloat(a.CycleCapacitySizePrecise ?? a.CapacitySizePrecise ?? "0"));
            const name = (a.PackageName ?? "-").replace(/\|/g, "\\|");
            const exp = a.CycleEndTime ?? "-";
            lines.push(`| ${name} | ${remain} | ${size} | ${exp} |`);
        }
    }
    // 底部行并入同一张表：左列=签到标签 + 喵喵状态，末列=最近更新（右对齐贴右缘）
    const tag = checkinTag();
    const buddy = buddyTag();
    const left = [tag, buddy].filter(Boolean).join("  ");
    if (updatedAt) {
        lines.push(t("| {0} |  | Updated | {1} |", left, formatDateTime(updatedAt)));
    }
    else if (left) {
        lines.push(`| ${left} |  |  |  |`);
    }
    const md = new vscode.MarkdownString(lines.join("\n"));
    md.isTrusted = true;
    md.supportHtml = false;
    return md;
}
function scheduleTimer() {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
    const cfg = getConfig();
    const mins = cfg.get("refreshIntervalMinutes", 30);
    if (mins > 0) {
        timer = setInterval(() => update(), mins * 60 * 1000);
    }
}
/**
 * 手动输入 Access Token —— 自动读取失败时的唯一兜底路径。
 *
 * 正常情况下无需手动输入：扩展会自动读取 CodeBuddy 登录态，并且 CodeBuddy
 * 自己会刷新 token 写回本地。只有当自动读取失败（未安装 / 非 macOS / 钥匙串被拒）
 * 时，才需要在这里粘贴一次。
 *
 * 留空表示清除手动值，并重新尝试自动读取。
 */
async function setAccessToken() {
    const cfg = getConfig();
    const value = await vscode.window.showInputBox({
        title: t("Access Token"),
        prompt: t("Paste the Access Token of the CodeBuddy extension (JWT). It is read automatically when possible — fill this only when auto-read failed."),
        placeHolder: "eyJhbGciOi…",
        value: cfg.get("accessToken", ""),
        password: true,
        ignoreFocusOut: true,
    });
    if (value === undefined)
        return;
    const trimmed = value.trim();
    await cfg.update("accessToken", trimmed, vscode.ConfigurationTarget.Global);
    (0, auth_1.invalidateAuth)();
    // 清空手动值：解除钥匙串封锁，下次刷新重新尝试自动读取
    if (!trimmed)
        (0, auth_1.resetAutoReadBlock)();
    vscode.window.showInformationMessage(trimmed
        ? t("CodeBuddy Usage: Access Token saved")
        : t("CodeBuddy Usage: Access Token cleared, retrying auto-read"));
    update();
}
/** 手动「领积分」：领取喵喵挣的积分（独立于自动流程，由悬浮框链接触发） */
async function buddyClaimCmd() {
    if (!getConfig().get("buddyTravel", false))
        return;
    if (!lastBuddy)
        lastBuddy = {};
    try {
        const c = await claimBuddy();
        if (c.error) {
            lastBuddy.claim = { error: c.error };
            vscode.window.showWarningMessage(t("CodeBuddy Usage: Failed to claim buddy credits ({0})", c.error));
        }
        else {
            let credit = c.credit;
            if (c.claimed && !((credit ?? 0) > 0)) {
                // 服务端确认领取成功但响应没给数量：从旅行记录接口取真实到账积分
                credit = await fetchTravelRewardCredit(lastBuddy?.status?.departAt);
            }
            lastBuddy.claim = { credit: credit ?? 0 };
            if ((credit ?? 0) > 0) {
                vscode.window.showInformationMessage(t("CodeBuddy Usage: Buddy claimed {0} credits", credit));
            }
            else if (c.claimed) {
                // 已确认领取成功但拿不到数量：不能误报成「没有可领取」
                vscode.window.showInformationMessage(t("CodeBuddy Usage: Buddy travel credits claimed"));
            }
            else {
                // 手动点击也要有反馈，否则点了「领积分」没有任何回应
                vscode.window.showInformationMessage(t("CodeBuddy Usage: Your buddy has no travel credits to claim right now"));
            }
        }
    }
    catch (e) {
        if (e?.message === "AUTH_EXPIRED" || e?.message === "NO_CREDENTIALS") {
            showAuthProblem(e?.message === "AUTH_EXPIRED" ? "expired" : "none");
            return;
        }
        lastBuddy.claim = { error: e?.message ?? String(e) };
        vscode.window.showWarningMessage(t("CodeBuddy Usage: Failed to claim buddy credits ({0})", e?.message ?? String(e)));
    }
    const st = await fetchBuddyStatus();
    if (st)
        lastBuddy.status = st;
    refreshTooltip();
}
/** 手动「去旅行」：派出喵喵出任务（独立于自动流程，由悬浮框链接触发） */
async function buddyDepartCmd() {
    if (!getConfig().get("buddyTravel", false))
        return;
    if (!lastBuddy)
        lastBuddy = {};
    try {
        const d = await departBuddy();
        if (d.error) {
            lastBuddy.depart = { error: d.error };
            vscode.window.showWarningMessage(t("CodeBuddy Usage: Buddy failed to depart ({0})", d.error));
        }
        else {
            lastBuddy.depart = { hours: d.hours ?? 0 };
            vscode.window.showInformationMessage(t("CodeBuddy Usage: Buddy departed, travel time {0} hours", d.hours ?? 0));
        }
    }
    catch (e) {
        if (e?.message === "AUTH_EXPIRED" || e?.message === "NO_CREDENTIALS") {
            showAuthProblem(e?.message === "AUTH_EXPIRED" ? "expired" : "none");
            return;
        }
        lastBuddy.depart = { error: e?.message ?? String(e) };
        vscode.window.showWarningMessage(t("CodeBuddy Usage: Buddy failed to depart ({0})", e?.message ?? String(e)));
    }
    const st = await fetchBuddyStatus();
    if (st)
        lastBuddy.status = st;
    refreshTooltip();
}
function activate(context) {
    // 高优先级（>=100）保证在状态栏空间紧张时不被挤掉，从而稳定常驻显示
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "codebuddyUsage.refresh";
    statusBarItem.text = `${icon("zap")} …`;
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);
    // 注入扩展自己的 SecretStorage 作为 token 持久化缓存：
    // 它由 VS Code 负责加解密，读写不会触发系统授权，
    // 从而把「读钥匙串」的频率压缩到 token 有效期内仅一次。
    secretsStore = context.secrets;
    (0, auth_1.useTokenStore)(getTokenStore());
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.showDetail", () => update()));
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.refresh", () => update()));
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.setAccessToken", () => setAccessToken()));
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.fixAuth", () => fixAuth()));
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.openUsagePage", () => {
        const apiBase = getConfig().get("apiBase", "https://www.workbuddy.cn");
        vscode.env.openExternal(vscode.Uri.parse(`${apiBase}/profile/plans-usage`));
    }));
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.buddyClaim", () => buddyClaimCmd()));
    context.subscriptions.push(vscode.commands.registerCommand("codebuddyUsage.buddyDepart", () => buddyDepartCmd()));
    update();
    scheduleTimer();
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration("codebuddyUsage.refreshIntervalMinutes")) {
            scheduleTimer();
        }
        if (e.affectsConfiguration("codebuddyUsage.accessToken")) {
            update();
        }
        if (e.affectsConfiguration("codebuddyUsage.buddyTravel")) {
            // 开关变化：重新拉取以清空/展示喵喵状态并重置倒计时
            update();
        }
    }));
}
function deactivate() {
    if (timer) {
        clearInterval(timer);
        timer = undefined;
    }
}
