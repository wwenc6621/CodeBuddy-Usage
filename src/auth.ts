import { execFile } from "child_process";
import { promisify } from "util";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { readValueByKeyMatch } from "./sqlite-reader";

const execFileAsync = promisify(execFile);

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
/** 头像签名 URL 剩余有效期低于该值时，顺手重读一次登录态换新 URL（约 7 天窗口） */
const PROFILE_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;
/** 头像刷新失败后的冷却时间，避免反复访问系统凭据 */
const PROFILE_RETRY_MS = 12 * 60 * 60 * 1000;

export type AuthMode = "token-auto" | "token-manual" | "none";

/** 账号信息（来自 CodeBuddy 登录态明文，无需额外接口） */
export interface Profile {
  nickname?: string;
  /** 头像地址（COS 签名 URL，签名过期后不可再用于展示） */
  avatarUrl?: string;
  /** 头像 URL 的签名过期时间（毫秒时间戳） */
  avatarExpiresAt?: number;
}

export interface AuthState {
  mode: AuthMode;
  /** JWT，用于 Authorization: Bearer */
  token?: string;
  /** JWT 过期时间（毫秒时间戳） */
  expiresAt?: number;
  /** 自动读取失败时的人类可读原因（用于提示） */
  note?: string;
  /** 账号信息（头像 / 昵称），读不到时为空 */
  profile?: Profile;
}

export interface AuthConfig {
  /** 用户手动输入的 accessToken（自动读取失败时的兜底） */
  manualToken?: string;
}

/** 持久化 token 缓存（由宿主注入，通常是 VS Code 扩展自己的 SecretStorage） */
export interface TokenStore {
  get(): Promise<{ token: string; expiresAt?: number; profile?: Profile } | undefined>;
  set(
    value: { token: string; expiresAt?: number; profile?: Profile } | undefined
  ): Promise<void>;
}

/** 各宿主（VS Code 及其衍生 IDE）的登录态位置与密钥来源 */
interface HostCandidate {
  label: string;
  /** state.vscdb 路径 */
  dbPath: string;
  /** macOS：钥匙串条目 */
  keychainService?: string;
  keychainAccount?: string;
  /** Windows：Electron 的 Local State 文件（内含 DPAPI 保护的密钥） */
  localStatePath?: string;
}

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

function hostCandidates(): HostCandidate[] {
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
function readValueViaNodeSqlite(dbPath: string, sql: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod: any = require("node:sqlite");
    const db = new mod.DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare(sql).get();
      return row?.value != null ? String(row.value) : undefined;
    } finally {
      db.close?.();
    }
  } catch {
    return undefined;
  }
}

/** 用系统 sqlite3 命令读取（macOS / 多数 Linux 自带；Windows 通常没有） */
async function readValueViaCli(dbPath: string, sql: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("sqlite3", [dbPath, sql], {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 30_000,
    });
    const raw = String(stdout).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

const SECRET_SQL = `select value from ItemTable where key like '%${SECRET_KEY}"}%'`;

/**
 * 依次尝试三种方式读取 state.vscdb 中的密文原文：
 * 官方 node:sqlite → 系统 sqlite3 命令 → 内置最小解析器（Windows 上通常走这条）。
 */
async function readSecretRaw(dbPath: string): Promise<string | undefined> {
  if (!fs.existsSync(dbPath)) return undefined;
  const viaNode = readValueViaNodeSqlite(dbPath, SECRET_SQL);
  if (viaNode) return viaNode;
  const viaCli = await readValueViaCli(dbPath, SECRET_SQL);
  if (viaCli) return viaCli;
  return readValueByKeyMatch(dbPath, (key) => key.includes(SECRET_KEY));
}

/** 读取加密后的 secret（Buffer） */
async function readEncryptedSecret(dbPath: string): Promise<Buffer | undefined> {
  const raw = (await readSecretRaw(dbPath))?.trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.data)) return Buffer.from(parsed.data);
  } catch {
    /* 非常规数据，忽略 */
  }
  return undefined;
}

/**
 * macOS：从钥匙串取 safeStorage 密钥并派生 AES key。
 * 需要区分「条目根本不存在」（errSecItemNotFound，正常情况，继续试下一个宿主）
 * 与「用户拒绝了授权」（不可继续，否则会连环弹框）。
 */
async function readMacKey(
  service: string,
  account: string
): Promise<{ key?: Buffer; notFound?: boolean }> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      // 首次会弹出系统授权框（可能要求输入开机密码），给足等待时间但不无限挂起
      { timeout: 180_000 }
    );
    const password = String(stdout).trim();
    if (!password) return {};
    // 实测：safeStorage 的 AES key = PBKDF2(钥匙串密码, "saltysalt", 1003, SHA1, 16)
    return { key: crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1") };
  } catch (e: any) {
    // `security` 在条目不存在时以 44 退出（errSecItemNotFound），此时并未弹过授权框
    return { notFound: e?.code === 44 || e?.code === "44" };
  }
}

/** PowerShell 可执行文件路径（优先系统目录，避免 PATH 缺失） */
function powershellPath(): string {
  const root = process.env.SystemRoot ?? "C:\\Windows";
  const full = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return fs.existsSync(full) ? full : "powershell.exe";
}

/**
 * Windows：读取 `<userData>/Local State` 里的 `os_crypt.encrypted_key`，
 * 用 DPAPI（CurrentUser）解出 32 字节 AES 密钥。
 * 通过 PowerShell 调 `ProtectedData.Unprotect` 完成，无需原生模块。
 *
 * 注意：`ProtectedData` 位于 System.Security 程序集，Windows PowerShell 5.1 默认**未加载**，
 * 必须先 `Add-Type -AssemblyName System.Security`，否则会报「找不到类型」。
 */
async function readWindowsKey(localStatePath: string): Promise<{ key?: Buffer; error?: string }> {
  if (!localStatePath || !fs.existsSync(localStatePath)) {
    return { error: `Local State not found: ${localStatePath || "-"}` };
  }
  let protectedKey: Buffer;
  try {
    const state = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
    const b64 = state?.os_crypt?.encrypted_key;
    if (typeof b64 !== "string" || !b64) return { error: "os_crypt.encrypted_key missing" };
    const raw = Buffer.from(b64, "base64");
    const prefix = Buffer.from("DPAPI", "ascii");
    protectedKey = raw.subarray(0, 5).equals(prefix) ? raw.subarray(5) : raw;
  } catch (e: any) {
    return { error: `Local State parse failed: ${String(e?.message ?? e).slice(0, 100)}` };
  }

  // 用 -EncodedCommand（UTF-16LE + base64）传脚本，彻底规避引号转义问题
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$b=[Convert]::FromBase64String('${protectedKey.toString("base64")}')`,
    "$k=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Console]::Out.Write([Convert]::ToBase64String($k))",
  ].join(";");
  try {
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      powershellPath(),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { timeout: 60_000 }
    );
    const key = Buffer.from(String(stdout).trim(), "base64");
    if (!key.length) return { error: "DPAPI returned empty key" };
    return { key };
  } catch (e: any) {
    const detail = String(e?.stderr ?? e?.message ?? e)
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-1)[0];
    return { error: `DPAPI failed: ${(detail ?? "").slice(0, 120)}` };
  }
}

/** macOS：v10 = AES-128-CBC，IV 取密文前 16 字节 */
function decryptV10Cbc(enc: Buffer, key: Buffer): string | undefined {
  if (enc.length <= 3 + 16) return undefined;
  try {
    const decipher = crypto.createDecipheriv("aes-128-cbc", key, enc.subarray(3, 19));
    return Buffer.concat([decipher.update(enc.subarray(19)), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Windows：v10 = AES-256-GCM（12 字节 nonce 在前，16 字节 tag 在尾部） */
function decryptV10Gcm(enc: Buffer, key: Buffer): string | undefined {
  if (enc.length <= 3 + 12 + 16) return undefined;
  try {
    const nonce = enc.subarray(3, 15);
    const tag = enc.subarray(enc.length - 16);
    const data = enc.subarray(15, enc.length - 16);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

function decryptSecret(enc: Buffer, key: Buffer): string | undefined {
  if (enc.subarray(0, 3).toString() !== ENC_PREFIX) return undefined;
  return process.platform === "win32" ? decryptV10Gcm(enc, key) : decryptV10Cbc(enc, key);
}

/**
 * 从解密后的会话明文里取 auth.accessToken。
 * 明文头部可能因分片存储被截断（JSON 不完整），故用正则而非 JSON.parse。
 */
function extractAccessToken(plain: string): string | undefined {
  const m = plain.match(/"accessToken":"([^"]+)"/);
  return m?.[1];
}

/**
 * 从 COS 签名 URL 里取签名截止时间（`q-sign-time=<start>;<end>`，秒级）。
 * 到期后该 URL 不可再用，需要重读登录态换一个新签名。
 */
function avatarExpiry(url?: string): number | undefined {
  if (!url) return undefined;
  const raw = url.split("?")[1];
  if (!raw) return undefined;
  // 实际 URL 里分号是编码过的（`q-sign-time=1792736988%3B1793341788`），先解码
  let query = raw;
  try {
    query = decodeURIComponent(raw);
  } catch {
    /* 保留原串继续用正则匹配 */
  }
  const m = query.match(/(?:^|&)q-sign-time=(\d+)[;%3B]*(\d+)/i);
  if (!m) return undefined;
  const end = Number(m[2]);
  return Number.isFinite(end) && end > 0 ? end * 1000 : undefined;
}

/**
 * 从会话明文里取账号信息（昵称 / 头像）。
 * 登录态里本来就有 `nickname`、`avatarUrl`、`uid`、`uin` 等字段，
 * 因此展示账号信息不需要额外请求任何接口。
 */
function extractProfile(plain: string): Profile | undefined {
  const nickname = plain.match(/"nickname":"([^"]*)"/)?.[1];
  const avatarUrl = plain.match(/"avatarUrl":"([^"]*)"/)?.[1];
  if (!nickname && !avatarUrl) return undefined;
  return { nickname, avatarUrl, avatarExpiresAt: avatarExpiry(avatarUrl) };
}

/** 解析 JWT payload；非 JWT 或解析失败返回 undefined */
function jwtPayload(token: string): any | undefined {
  const segment = token.split(".")[1];
  if (!segment) return undefined;
  try {
    return JSON.parse(
      Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    );
  } catch {
    return undefined;
  }
}

/** 解析 JWT 的 exp（毫秒时间戳）；非 JWT 或解析失败返回 undefined */
export function jwtExpiry(token: string): number | undefined {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : undefined;
}

/**
 * 从 JWT 里取昵称（用于「只拿到手动 token」的场景，此时读不到会话明文）。
 * id_token / accessToken 的 payload 里都带 nickname。
 */
export function jwtNickname(token: string): string | undefined {
  const nickname = jwtPayload(token)?.nickname;
  return typeof nickname === "string" && nickname ? nickname : undefined;
}

/** 自动读取 CodeBuddy 登录态里的 accessToken（顺带取账号信息） */
async function readAutoToken(): Promise<{ token?: string; note?: string; profile?: Profile }> {
  const hosts = hostCandidates();
  if (hosts.length === 0) {
    return { note: "auto-read unsupported on this platform" };
  }
  let sawDb = false;
  /** 记录最后一个失败原因，便于用户/排查时看到具体卡在哪一步 */
  let lastError: string | undefined;
  for (const host of hosts) {
    try {
      const enc = await readEncryptedSecret(host.dbPath);
      if (!enc) continue;
      sawDb = true;

      let key: Buffer | undefined;
      if (process.platform === "win32") {
        // DPAPI 不会弹窗，失败时可以安全地继续尝试其它宿主
        const r = await readWindowsKey(host.localStatePath ?? "");
        if (r.error) {
          lastError = r.error;
          continue;
        }
        key = r.key;
      } else {
        const r = await readMacKey(host.keychainService ?? "", host.keychainAccount ?? "");
        // 条目不存在（该宿主没登录过 / 未启用 safeStorage）：静默换下一个宿主，
        // 这一步不会弹授权框，因此不会造成连环弹窗
        if (r.notFound) {
          lastError = "keychain item not found";
          continue;
        }
        key = r.key;
        // 条目存在但被拒（用户点了「拒绝」/ 超时）：立即停止，避免连环弹授权框
        if (!key) return { note: "keychain access denied" };
      }
      if (!key) {
        lastError = "credential store unavailable";
        continue;
      }

      const plain = decryptSecret(enc, key);
      if (!plain) {
        lastError = "failed to decrypt CodeBuddy session";
        continue;
      }
      const token = extractAccessToken(plain);
      if (token) return { token, profile: extractProfile(plain) };
      lastError = "accessToken not found in session";
    } catch (e: any) {
      lastError = String(e?.message ?? e).slice(0, 120);
    }
  }
  if (!sawDb) return { note: "no CodeBuddy session found" };
  return { note: lastError ?? "failed to read CodeBuddy session" };
}

let cache: AuthState | undefined;
let cacheAt = 0;
let storeRef: TokenStore | undefined;
/** 自动读取失败后置位：本次会话不再尝试系统凭据，避免反复弹授权窗 */
let autoReadBlocked = false;
let lastAutoNote: string | undefined;

/**
 * 清空鉴权缓存。
 * @param allowCredentialRetry 是否允许下次再尝试读取系统凭据（默认否：失败过就不再打扰用户）
 */
export function invalidateAuth(allowCredentialRetry = false): void {
  cache = undefined;
  cacheAt = 0;
  if (allowCredentialRetry) autoReadBlocked = false;
  // 丢弃持久化缓存，强制重新判断（401 时旧 token 已不可信）
  if (storeRef) void storeRef.set(undefined).catch(() => undefined);
}

/** 用户手动输入 token 后调用：解除封锁，允许下次重新尝试自动读取 */
export function resetAutoReadBlock(): void {
  autoReadBlocked = false;
  lastAutoNote = undefined;
}

/** 注册持久化缓存实现（在 activate 时注入扩展的 SecretStorage） */
export function useTokenStore(store: TokenStore | undefined): void {
  storeRef = store;
}

/** 头像签名是否即将/已经过期（过期后 markdown 会渲染成破图，干脆不展示） */
export function avatarUsable(profile?: Profile, now = Date.now()): boolean {
  if (!profile?.avatarUrl) return false;
  if (profile.avatarExpiresAt == null) return true;
  return profile.avatarExpiresAt > now;
}

/** 头像签名临近过期：需要重读登录态换新 URL */
function profileStale(profile?: Profile, now = Date.now()): boolean {
  if (!profile?.avatarUrl || profile.avatarExpiresAt == null) return false;
  return profile.avatarExpiresAt - now < PROFILE_MARGIN_MS;
}

/** 上次尝试刷新头像的时间，用于冷却（每 12 小时最多一次） */
let profileRefreshAt = 0;

/**
 * 补一次账号信息（头像 / 昵称）。
 *
 * 触发时机：持久化缓存里没有头像（从旧版本升级上来的缓存）、或头像签名临近过期
 * （签名只有约 7 天，比 token 短得多）。失败完全静默——旧数据还能用，最坏也只是不显示头像；
 * 12 小时冷却，避免反复访问系统凭据。
 */
async function refreshProfile(state: AuthState): Promise<void> {
  if (autoReadBlocked) return;
  if (Date.now() - profileRefreshAt < PROFILE_RETRY_MS) return;
  profileRefreshAt = Date.now();
  const auto = await readAutoToken().catch(() => undefined);
  if (!auto?.profile) return;
  state.profile = auto.profile;
  if (storeRef && state.token) {
    await storeRef
      .set({ token: state.token, expiresAt: state.expiresAt, profile: auto.profile })
      .catch(() => undefined);
  }
}

/**
 * 获取当前生效的鉴权状态（带内存缓存）。
 * 优先级：持久化缓存（未临近过期）→ 自动读取系统登录态 → 手动输入 token。
 */
export async function getAuth(cfg: AuthConfig): Promise<AuthState> {
  const now = Date.now();
  if (cache && now - cacheAt < CACHE_TTL_MS) {
    if (!cache.profile?.avatarUrl || profileStale(cache.profile, now)) {
      await refreshProfile(cache);
    }
    return cache;
  }

  const manualToken = (cfg.manualToken ?? "").trim();

  // 1. 持久化缓存：未临近过期就直接用，完全不需要访问系统凭据
  if (storeRef) {
    const cached = await storeRef.get().catch(() => undefined);
    if (cached?.token) {
      const expiresAt = cached.expiresAt ?? jwtExpiry(cached.token);
      if (expiresAt == null || expiresAt > now + REFRESH_MARGIN_MS) {
        cache = {
          mode: "token-auto",
          token: cached.token,
          expiresAt,
          profile: cached.profile ?? { nickname: jwtNickname(cached.token) },
        };
        // 旧版本缓存里没有头像：补一次（12 小时冷却）
        if (!cache.profile?.avatarUrl) await refreshProfile(cache);
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
        const profile = auto.profile ?? { nickname: jwtNickname(auto.token) };
        if (storeRef) {
          await storeRef.set({ token: auto.token, expiresAt, profile }).catch(() => undefined);
        }
        cache = { mode: "token-auto", token: auto.token, expiresAt, profile };
        cacheAt = now;
        return cache;
      }
      lastAutoNote = "auto token expired";
    } else {
      lastAutoNote = auto.note;
    }
    if (!auto.token) autoReadBlocked = true;
  }

  // 3. 手动输入的 token
  if (manualToken) {
    const expiresAt = jwtExpiry(manualToken);
    if (expiresAt == null || expiresAt > now) {
      cache = {
        mode: "token-manual",
        token: manualToken,
        expiresAt,
        note: lastAutoNote,
        // 手动 token 读不到会话明文，只能从 JWT 里取昵称（没有头像）
        profile: { nickname: jwtNickname(manualToken) },
      };
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
export function authHeaders(auth: AuthState): Record<string, string> {
  return auth.token ? { authorization: `Bearer ${auth.token}` } : {};
}
