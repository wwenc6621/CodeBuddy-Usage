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
exports.readValueByKeyMatch = readValueByKeyMatch;
const fs = __importStar(require("fs"));
/**
 * 内置的最小 SQLite 只读解析器。
 *
 * 用途：从 VS Code 的 `state.vscdb` 里按键取出 SecretStorage 的密文原文。
 * 为什么不用现成方案：
 *  - `node:sqlite` 需要 Node 22.5+ 且宿主可能未启用；
 *  - `sqlite3` 命令在 Windows 上通常不存在；
 *  - 引入原生模块 / wasm 会显著增大包体积与维护成本。
 * 因此这里直接解析 SQLite 文件格式，只做「按键查值」这一件事。
 *
 * 支持：table B-tree（interior / leaf）、变长整数、溢出页链、
 *       NULL / 整数 / 浮点 / TEXT / BLOB 等常见 serial type，以及 `-wal` 增量。
 */
/**
 * 把 `<db>-wal` 里已提交的页叠加到主库镜像上，返回叠加后的镜像。
 *
 * 为什么需要：VS Code / CodeBuddy 的 `state.vscdb` 长期以 WAL 模式打开，最近的写入
 * （比如 CodeBuddy 刚刷新过的 accessToken）可能还停留在 `-wal`、尚未回写主库。
 * 只读主文件会读到**旧值**，表现为「明明刚登录，扩展却一直说登录已过期」。
 *
 * 只接受结构完整、salt 与页大小都对得上的 WAL；任何异常一律整体忽略，
 * 退回只读主库，避免把原本可用的读取弄坏。
 */
function applyWal(db, walPath, dbPageSize) {
    let wal;
    try {
        wal = fs.readFileSync(walPath);
    }
    catch {
        return db;
    }
    if (wal.length < 32)
        return db;
    // 0x377f0682 / 0x377f0683 是 WAL 魔数（仅校验和字节序不同）
    const magic = wal.readUInt32BE(0);
    if (magic !== 0x377f0682 && magic !== 0x377f0683)
        return db;
    const pageSize = wal.readUInt32BE(8);
    if (pageSize !== dbPageSize)
        return db;
    const salt1 = wal.readUInt32BE(16);
    const salt2 = wal.readUInt32BE(20);
    const frames = [];
    let committed = 0;
    for (let off = 32; off + 24 + pageSize <= wal.length; off += 24 + pageSize) {
        const pageNo = wal.readUInt32BE(off);
        const dbSize = wal.readUInt32BE(off + 4);
        // salt 不一致说明是上一轮 WAL 的残留帧，之后的内容都不可信
        if (wal.readUInt32BE(off + 8) !== salt1 || wal.readUInt32BE(off + 12) !== salt2)
            break;
        if (pageNo === 0)
            break;
        frames.push({ pageNo, offset: off + 24 });
        // dbSize 非 0 表示该帧是一个提交点
        if (dbSize !== 0)
            committed = frames.length;
    }
    if (committed === 0)
        return db;
    // 主库文件可能只落盘了前几页（新写入的页只存在于 WAL），镜像要按需扩容
    let maxPage = 0;
    for (let i = 0; i < committed; i++)
        maxPage = Math.max(maxPage, frames[i].pageNo);
    const needed = maxPage * pageSize;
    let img = db;
    if (img.length < needed) {
        img = Buffer.alloc(needed);
        db.copy(img, 0);
    }
    else {
        img = Buffer.from(db);
    }
    for (let i = 0; i < committed; i++) {
        const { pageNo, offset } = frames[i];
        wal.copy(img, (pageNo - 1) * pageSize, offset, offset + pageSize);
    }
    return img;
}
function readValueByKeyMatch(filePath, match) {
    let buf;
    try {
        buf = fs.readFileSync(filePath);
    }
    catch {
        return undefined;
    }
    if (buf.length < 100 || buf.subarray(0, 16).toString("latin1") !== "SQLite format 3\u0000") {
        return undefined;
    }
    const pageSize = buf.readUInt16BE(16) === 1 ? 65536 : buf.readUInt16BE(16);
    const reserved = buf[20];
    const usable = pageSize - reserved;
    if (pageSize <= 0 || usable <= 0)
        return undefined;
    // 先叠加未回写的 WAL 页，保证读到的是最新提交的数据
    buf = applyWal(buf, `${filePath}-wal`, pageSize);
    // 第 1 页的前 100 字节是数据库文件头，B-tree 页头从该页的 offset 100 处开始；
    // 但页内的 cell 指针 / cell 偏移全部以「页起始」为基准（第 1 页即文件 offset 0），
    // 所以读取页头要加 headerOffset，而定位 cell 用原始偏移。
    const page = (no) => buf.subarray((no - 1) * pageSize, no * pageSize);
    const headerOffset = (no) => (no === 1 ? 100 : 0);
    /** SQLite 变长整数（最多 9 字节） */
    const varint = (b, off) => {
        let value = 0;
        for (let i = 0; i < 9; i++) {
            const byte = b[off + i];
            if (i === 8)
                return { value: value * 256 + byte, length: 9 };
            value = value * 128 + (byte & 0x7f);
            if ((byte & 0x80) === 0)
                return { value, length: i + 1 };
        }
        return { value, length: 1 };
    };
    /** 读取一个 table leaf cell 的完整 payload（必要时沿溢出页链拼接） */
    const payloadAt = (pg, cellOff) => {
        const size = varint(pg, cellOff);
        const rowid = varint(pg, cellOff + size.length);
        const start = cellOff + size.length + rowid.length;
        const total = size.value;
        const maxLocal = usable - 35;
        const minLocal = Math.floor(((usable - 12) * 32) / 255) - 23;
        let localSize = total;
        if (total > maxLocal) {
            localSize = minLocal + ((total - minLocal) % (usable - 4));
            if (localSize > maxLocal)
                localSize = minLocal;
        }
        const local = pg.subarray(start, start + localSize);
        if (total <= maxLocal)
            return Buffer.from(local);
        const chunks = [Buffer.from(local)];
        let remaining = total - localSize;
        let next = pg.readUInt32BE(start + localSize);
        while (next !== 0 && remaining > 0) {
            const p = page(next);
            const take = Math.min(usable - 4, remaining);
            chunks.push(Buffer.from(p.subarray(4, 4 + take)));
            remaining -= take;
            next = p.readUInt32BE(0);
        }
        return Buffer.concat(chunks);
    };
    /** 解析 record，返回各列值（文本 / 数值；NULL 为 undefined） */
    const parseRecord = (payload) => {
        const head = varint(payload, 0);
        const serials = [];
        let off = head.length;
        while (off < head.value) {
            const v = varint(payload, off);
            serials.push(v.value);
            off += v.length;
        }
        const INT_SIZES = [0, 1, 2, 3, 4, 6, 8];
        const out = [];
        let vo = head.value;
        for (const t of serials) {
            if (t === 0) {
                out.push(undefined);
            }
            else if (t >= 1 && t <= 6) {
                const n = INT_SIZES[t];
                let v = 0;
                for (let i = 0; i < n; i++)
                    v = v * 256 + payload[vo + i];
                out.push(v);
                vo += n;
            }
            else if (t === 7) {
                out.push(payload.readDoubleBE(vo));
                vo += 8;
            }
            else if (t === 8) {
                out.push(0);
            }
            else if (t === 9) {
                out.push(1);
            }
            else if (t >= 12) {
                const n = t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
                out.push(payload.subarray(vo, vo + n).toString("utf8"));
                vo += n;
            }
            else {
                out.push(undefined);
            }
        }
        return out;
    };
    /** 遍历 table B-tree，命中即返回 */
    const walk = (pageNo, visit) => {
        const pg = page(pageNo);
        const h = headerOffset(pageNo);
        if (pg.length < h + 8)
            return undefined;
        const type = pg[h];
        const numCells = pg.readUInt16BE(h + 3);
        if (type === 13) {
            for (let i = 0; i < numCells; i++) {
                const cellOff = pg.readUInt16BE(h + 8 + i * 2);
                if (cellOff + 2 > pg.length)
                    continue;
                const r = visit(parseRecord(payloadAt(pg, cellOff)));
                if (r !== undefined)
                    return r;
            }
            return undefined;
        }
        if (type === 5) {
            for (let i = 0; i < numCells; i++) {
                const child = pg.readUInt32BE(pg.readUInt16BE(h + 12 + i * 2));
                const r = walk(child, visit);
                if (r !== undefined)
                    return r;
            }
            // 最右子页指针对存在页头 offset 8
            return walk(pg.readUInt32BE(h + 8), visit);
        }
        return undefined;
    };
    // sqlite_master 的 schema：type, name, tbl_name, rootpage, sql
    const rootPage = walk(1, (cols) => cols[1] === "ItemTable" ? Number(cols[3]) : undefined);
    if (!rootPage)
        return undefined;
    // ItemTable 的列：(key, value)
    return walk(rootPage, (cols) => {
        const key = cols[0];
        if (typeof key !== "string" || !match(key))
            return undefined;
        const value = cols[1];
        return typeof value === "string" ? value : undefined;
    });
}
