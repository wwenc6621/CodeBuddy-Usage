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
exports.jwtExpiry = jwtExpiry;
exports.invalidateAuth = invalidateAuth;
exports.resetAutoReadBlock = resetAutoReadBlock;
exports.useTokenStore = useTokenStore;
exports.getAuth = getAuth;
exports.authHeaders = authHeaders;
const child_process_1 = require("child_process");
const util_1 = require("util");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const sqlite_reader_1 = require("./sqlite-reader");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
/**
 * CodeBuddy 登录态读取（accessToken 模式）
 * ============================================================
 * 目标：从本机 CodeBuddy 登录态里拿到 `accessToken`（JWT），以 `Authorization: Bearer`
 * 调用 workbuddy.cn 接口，彻底摆脱 Cookie。
 *
 * 本地登录态是 VS Code 的 SecretStorage（state.vscdb 里的密文），由 Electron safeStorage
 * 加密，各平台机制不同：
 *  - macOS：密钥在 Keychain（`<Product> Safe Storage` / `<Product> Key`），
 *           派生 PBKDF2(password, "saltysalt", 1003)，密文 `v10` + AES-128-CBC；
 *  - Windows：密钥在 `<userData>/Local State` 的 `os_crypt.encrypted_key`（DPAPI 保护），
 *           密文 `v10` + AES-256-GCM（12B nonce + 16B tag）。
 * 解密本地登录态必须访问系统凭据存储（macOS 钥匙串 / Windows DPAPI），这是系统安全模型，
 * 无法绕过；因此这里把访问压到最低频率：
 *  1. 先看「持久化缓存」（宿主注入的 TokenStore，通常是扩展自己的 SecretStorage，
 *     读写不触发任何授权）：token 未过期且剩余有效期充足 → 直接用；
 *  2. 缓存不可用或临近过期 → 读取登录态解密一次，成功后写回持久化缓存（约 60 天一次）；
 *  3. 读取失败 → 本次会话不再重试，避免反复干扰，交由「手动输入的 accessToken」兜底。
 *
 * 注意：绝不主动调用 refreshToken —— 那会与 CodeBuddy 自身的刷新互相轮换，
 * 反而把 IDE 的登录态挤掉。token 由 CodeBuddy 负责刷新，我们只在需要时重读。
 */
/** CodeBuddy 会话在 SecretStorage 中的键名 */
const SECRET_KEY = "Tencent-Cloud.coding-copilot.new.accessToken";
/** Electron safeStorage 密文前缀 */
const ENC_PREFIX = "v10";
/** 内存缓存时长，避免同一轮刷新内重复读取 */
const CACHE_TTL_MS = 5 * 60 * 1000;
/** 持久化缓存的 token 剩余有效期低于该值时，才重新去读系统凭据（CodeBuddy 可能已刷新） */
const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;
const PRODUCT_NAMES = [
    "Code",
    "Code - Insiders",
    "CodeBuddy",
    "CodeBuddy CN",
    "Trae",
    "Trae CN",
    "Cursor",
    "Kiro",
    "Qoder",
];
function hostCandidates() {
    if (process.platform === "darwin") {
        const base = path.join(os.homedir(), "Library/Application Support");
        return PRODUCT_NAMES.map((app) => ({
            label: app,
            dbPath: path.join(base, app, "User/globalStorage/state.vscdb"),
            keychainService: `${app} Safe Storage`,
            keychainAccount: `${app} Key`,
        }));
    }
    if (process.platform === "win32") {
        // Windows 上登录态与密钥都在 %APPDATA%\<Product> 下
        const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
        return PRODUCT_NAMES.map((app) => ({
            label: app,
            dbPath: path.join(appData, app, "User", "globalStorage", "state.vscdb"),
            localStatePath: path.join(appData, app, "Local State"),
        }));
    }
    // Linux 的 safeStorage 走 keyring（libsecret / kwallet），尚未适配，先走手动 accessToken
    return [];
}
/** 用 Node 内置 node:sqlite 读取（Node 22.5+；部分宿主未启用则抛错） */
function readValueViaNodeSqlite(dbPath, sql) {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("node:sqlite");
        const db = new mod.DatabaseSync(dbPath, { readOnly: true });
        try {
            const row = db.prepare(sql).get();
            return row?.value != null ? String(row.value) : undefined;
        }
        finally {
            db.close?.();
        }
    }
    catch {
        return undefined;
    }
}
/** 用系统 sqlite3 命令读取（macOS / 多数 Linux 自带；Windows 通常没有） */
async function readValueViaCli(dbPath, sql) {
    try {
        const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30000,
        });
        const raw = String(stdout).trim();
        return raw || undefined;
    }
    catch {
        return undefined;
    }
}
const SECRET_SQL = `select value from ItemTable where key like '%${SECRET_KEY}"}%'`;
/**
 * 依次尝试三种方式读取 state.vscdb 中的密文原文：
 * 官方 node:sqlite → 系统 sqlite3 命令 → 内置最小解析器（Windows 上通常走这条）。
 */
async function readSecretRaw(dbPath) {
    if (!fs.existsSync(dbPath))
        return undefined;
    const viaNode = readValueViaNodeSqlite(dbPath, SECRET_SQL);
    if (viaNode)
        return viaNode;
    const viaCli = await readValueViaCli(dbPath, SECRET_SQL);
    if (viaCli)
        return viaCli;
    return (0, sqlite_reader_1.readValueByKeyMatch)(dbPath, (key) => key.includes(SECRET_KEY));
}
/** 读取加密后的 secret（Buffer） */
async function readEncryptedSecret(dbPath) {
    const raw = (await readSecretRaw(dbPath))?.trim();
    if (!raw)
        return undefined;
    try {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.data))
            return Buffer.from(parsed.data);
    }
    catch {
        /* 非常规数据，忽略 */
    }
    return undefined;
}
/** macOS：从钥匙串取 safeStorage 密钥并派生 AES key；不可用/被拒时返回 undefined */
async function readMacKey(service, account) {
    try {
        const { stdout } = await execFileAsync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], 
        // 首次会弹出系统授权框（可能要求输入开机密码），给足等待时间但不无限挂起
        { timeout: 180000 });
        const password = String(stdout).trim();
        if (!password)
            return undefined;
        // 实测：safeStorage 的 AES key = PBKDF2(钥匙串密码, "saltysalt", 1003, SHA1, 16)
        return crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
    }
    catch {
        return undefined;
    }
}
/** PowerShell 可执行文件路径（优先系统目录，避免 PATH 缺失） */
function powershellPath() {
    const root = process.env.SystemRoot ?? "C:\\Windows";
    const full = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return fs.existsSync(full) ? full : "powershell.exe";
}
/**
 * Windows：读取 `<userData>/Local State` 里的 `os_crypt.encrypted_key`，
 * 用 DPAPI（CurrentUser）解出 32 字节 AES 密钥。
 * 通过 PowerShell 调 `ProtectedData.Unprotect` 完成，无需原生模块。
 */
async function readWindowsKey(localStatePath) {
    try {
        if (!fs.existsSync(localStatePath))
            return undefined;
        const state = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
        const b64 = state?.os_crypt?.encrypted_key;
        if (typeof b64 !== "string" || !b64)
            return undefined;
        const raw = Buffer.from(b64, "base64");
        const prefix = Buffer.from("DPAPI", "ascii");
        const protectedKey = raw.subarray(0, 5).equals(prefix) ? raw.subarray(5) : raw;
        // 用 -EncodedCommand（UTF-16LE + base64）传脚本，彻底规避引号转义问题
        const script = [
            "$ErrorActionPreference='Stop'",
            // Windows PowerShell 5.1 在部分环境下不会自动加载 System.Security 程序集，
            // 直接引用会抛 "Unable to find type [System.Security.Cryptography.ProtectedData]"，
            // 导致读取登录态静默失败（表现为状态栏显示「未找到登录凭据」）。显式加载可彻底规避。
            "Add-Type -AssemblyName System.Security",
            `$b=[Convert]::FromBase64String('${protectedKey.toString("base64")}')`,
            "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
            "[Console]::Out.Write([Convert]::ToBase64String($k))",
        ].join(";");
        const encoded = Buffer.from(script, "utf16le").toString("base64");
        const { stdout } = await execFileAsync(powershellPath(), ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { timeout: 60000 });
        const key = Buffer.from(String(stdout).trim(), "base64");
        return key.length ? key : undefined;
    }
    catch {
        return undefined;
    }
}
/** macOS：v10 = AES-128-CBC，IV 取密文前 16 字节 */
function decryptV10Cbc(enc, key) {
    if (enc.length <= 3 + 16)
        return undefined;
    try {
        const decipher = crypto.createDecipheriv("aes-128-cbc", key, enc.subarray(3, 19));
        return Buffer.concat([decipher.update(enc.subarray(19)), decipher.final()]).toString("utf8");
    }
    catch {
        return undefined;
    }
}
/** Windows：v10 = AES-256-GCM（12 字节 nonce 在前，16 字节 tag 在尾部） */
function decryptV10Gcm(enc, key) {
    if (enc.length <= 3 + 12 + 16)
        return undefined;
    try {
        const nonce = enc.subarray(3, 15);
        const tag = enc.subarray(enc.length - 16);
        const data = enc.subarray(15, enc.length - 16);
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    }
    catch {
        return undefined;
    }
}
function decryptSecret(enc, key) {
    if (enc.subarray(0, 3).toString() !== ENC_PREFIX)
        return undefined;
    return process.platform === "win32" ? decryptV10Gcm(enc, key) : decryptV10Cbc(enc, key);
}
/**
 * 从解密后的会话明文里取 auth.accessToken。
 * 明文头部可能因分片存储被截断（JSON 不完整），故用正则而非 JSON.parse。
 */
function extractAccessToken(plain) {
    const m = plain.match(/"accessToken":"([^"]+)"/);
    return m?.[1];
}
/** 解析 JWT 的 exp（毫秒时间戳）；非 JWT 或解析失败返回 undefined */
function jwtExpiry(token) {
    const segment = token.split(".")[1];
    if (!segment)
        return undefined;
    try {
        const json = JSON.parse(Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        return typeof json?.exp === "number" ? json.exp * 1000 : undefined;
    }
    catch {
        return undefined;
    }
}
/** 自动读取 CodeBuddy 登录态里的 accessToken */
async function readAutoToken() {
    const hosts = hostCandidates();
    if (hosts.length === 0) {
        return { note: "auto-read unsupported on this platform" };
    }
    let sawDb = false;
    let sawEncrypted = false;
    for (const host of hosts) {
        try {
            const enc = await readEncryptedSecret(host.dbPath);
            if (!enc)
                continue;
            sawDb = true;
            const key = process.platform === "win32"
                ? await readWindowsKey(host.localStatePath ?? "")
                : await readMacKey(host.keychainService ?? "", host.keychainAccount ?? "");
            // 凭据存储不可用（钥匙串被拒 / DPAPI 失败）：不再尝试其它宿主，避免连环干扰
            if (!key)
                return { note: "credential store unavailable" };
            const plain = decryptSecret(enc, key);
            if (!plain)
                continue;
            sawEncrypted = true;
            const token = extractAccessToken(plain);
            if (token)
                return { token };
        }
        catch {
            // 单个宿主失败不影响其它候选
        }
    }
    if (!sawDb)
        return { note: "no CodeBuddy session found" };
    if (!sawEncrypted)
        return { note: "failed to decrypt CodeBuddy session" };
    return { note: "failed to read CodeBuddy session" };
}
let cache;
let cacheAt = 0;
let storeRef;
/** 自动读取失败后置位：本次会话不再尝试系统凭据，避免反复弹授权窗 */
let autoReadBlocked = false;
let lastAutoNote;
/**
 * 清空鉴权缓存。
 * @param allowCredentialRetry 是否允许下次再尝试读取系统凭据（默认否：失败过就不再打扰用户）
 */
function invalidateAuth(allowCredentialRetry = false) {
    cache = undefined;
    cacheAt = 0;
    if (allowCredentialRetry)
        autoReadBlocked = false;
    // 丢弃持久化缓存，强制重新判断（401 时旧 token 已不可信）
    if (storeRef)
        void storeRef.set(undefined).catch(() => undefined);
}
/** 用户手动输入 token 后调用：解除封锁，允许下次重新尝试自动读取 */
function resetAutoReadBlock() {
    autoReadBlocked = false;
    lastAutoNote = undefined;
}
/** 注册持久化缓存实现（在 activate 时注入扩展的 SecretStorage） */
function useTokenStore(store) {
    storeRef = store;
}
/**
 * 获取当前生效的鉴权状态（带内存缓存）。
 * 优先级：持久化缓存（未临近过期）→ 自动读取系统登录态 → 手动输入 token。
 */
async function getAuth(cfg) {
    const now = Date.now();
    if (cache && now - cacheAt < CACHE_TTL_MS)
        return cache;
    const manualToken = (cfg.manualToken ?? "").trim();
    // 1. 持久化缓存：未临近过期就直接用，完全不需要访问系统凭据
    if (storeRef) {
        const cached = await storeRef.get().catch(() => undefined);
        if (cached?.token) {
            const expiresAt = cached.expiresAt ?? jwtExpiry(cached.token);
            if (expiresAt == null || expiresAt > now + REFRESH_MARGIN_MS) {
                cache = { mode: "token-auto", token: cached.token, expiresAt };
                cacheAt = now;
                return cache;
            }
        }
    }
    // 2. 自动读取（失败过一次后本会话跳过）
    if (!autoReadBlocked) {
        const auto = await readAutoToken();
        if (auto.token) {
            const expiresAt = jwtExpiry(auto.token);
            if (expiresAt == null || expiresAt > now) {
                if (storeRef) {
                    await storeRef.set({ token: auto.token, expiresAt }).catch(() => undefined);
                }
                cache = { mode: "token-auto", token: auto.token, expiresAt };
                cacheAt = now;
                return cache;
            }
            lastAutoNote = "auto token expired";
        }
        else {
            lastAutoNote = auto.note;
        }
        if (!auto.token)
            autoReadBlocked = true;
    }
    // 3. 手动输入的 token
    if (manualToken) {
        const expiresAt = jwtExpiry(manualToken);
        if (expiresAt == null || expiresAt > now) {
            cache = { mode: "token-manual", token: manualToken, expiresAt, note: lastAutoNote };
            cacheAt = now;
            return cache;
        }
        lastAutoNote = "manual token expired";
    }
    cache = { mode: "none", note: lastAutoNote };
    cacheAt = now;
    return cache;
}
/** 由鉴权状态生成请求头 */
function authHeaders(auth) {
    return auth.token ? { authorization: `Bearer ${auth.token}` } : {};
}
