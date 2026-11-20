// 1号设备预期波阻抗调节 · 实测记录云同步后端：Cloudflare Worker + KV
// 部署：见同目录 deploy_yuqibo.py（API 部署，绑定 YUQIBO_KV）。
// 数据：KV 键 records，值 { records: [...], deleted: [id...], updatedAt }。
// 口令：复用页面进门密码，只比 SHA-256 哈希。哈希在公开页面源码里也有，
// 所以这道口令只挡随手看的人，和进门密码一个级别，不算真加密；
// 记录本身只是阻抗实测数据，没有个人信息和凭证。
// 同步语义：服务器只做 dumb 存储，不做合并（KV 读有几秒延迟，
// 服务端先读后写会在并发时丢删除标记）。合并由客户端做：
// 先拉云端，再按 id 合并（手机和电脑轮着记也不会互相覆盖），
// 再把合并后的全量写回云端。删除过的 id 记进 deleted，
// 之后任何设备再传同一条也不会复活。

const PW_HASH = "a21d84d80fcab9ec08db16e87339c08bc4db7aec15b08a37650ced4ac2cd866a";
const MAX_BODY = 1000000;
const MAX_DELETED = 2000;

function corsHeaders(request) {
  var origin = request.headers.get("Origin") || "";
  var allowed =
    origin === "https://wzhuaboy.github.io" ||
    origin.endsWith(".github.io") ||
    origin.indexOf("http://localhost") === 0 ||
    origin.indexOf("http://127.0.0.1") === 0;
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://wzhuaboy.github.io",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(obj, status, request) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders(request)),
  });
}

function validHash(hash) {
  return typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash);
}

function validRecord(r) {
  return r && typeof r === "object" &&
    typeof r.id === "string" && r.id.length > 0 && r.id.length <= 64 &&
    typeof r.rcode === "string" && typeof r.lcode === "string" &&
    typeof r.Rm === "number" && typeof r.Xm === "number";
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    // 上传：客户端已合并好的全量记录 + 已删除 id，服务端原样存入。
    if (url.pathname === "/api/sync" && request.method === "POST") {
      var body = await request.json().catch(function () { return null; });
      if (!body || !validHash(body.passHash) || !Array.isArray(body.records)) {
        return jsonResponse({ ok: false, error: "bad request" }, 400, request);
      }
      if (body.passHash !== PW_HASH) {
        return jsonResponse({ ok: false, error: "wrong password" }, 401, request);
      }
      if (JSON.stringify(body.records).length > MAX_BODY) {
        return jsonResponse({ ok: false, error: "data too large" }, 400, request);
      }
      for (var i = 0; i < body.records.length; i++) {
        if (!validRecord(body.records[i])) {
          return jsonResponse({ ok: false, error: "bad record" }, 400, request);
        }
      }
      var deleted = Array.isArray(body.deletedIds)
        ? body.deletedIds.filter(function (x) { return typeof x === "string"; })
        : [];
      if (deleted.length > MAX_DELETED) deleted = deleted.slice(deleted.length - MAX_DELETED);
      var now = Date.now();
      await env.YUQIBO_KV.put("records", JSON.stringify({
        records: body.records, deleted: deleted, updatedAt: now,
      }));
      return jsonResponse({ ok: true, count: body.records.length, updatedAt: now }, 200, request);
    }

    // 拉取云端记录 + 已删除 id。
    if (url.pathname === "/api/sync" && request.method === "GET") {
      var passHash = url.searchParams.get("passHash") || "";
      if (!validHash(passHash)) {
        return jsonResponse({ ok: false, error: "bad request" }, 400, request);
      }
      if (passHash !== PW_HASH) {
        return jsonResponse({ ok: false, error: "wrong password" }, 401, request);
      }
      var raw = await env.YUQIBO_KV.get("records");
      if (!raw) {
        return jsonResponse({ ok: true, records: [], deleted: [], count: 0, updatedAt: 0 }, 200, request);
      }
      var stored;
      try { stored = JSON.parse(raw); } catch (e) { stored = {}; }
      var recs = Array.isArray(stored.records) ? stored.records : [];
      var del = Array.isArray(stored.deleted) ? stored.deleted : [];
      return jsonResponse({
        ok: true, records: recs, deleted: del, count: recs.length,
        updatedAt: stored.updatedAt || 0,
      }, 200, request);
    }

    // 清空云端记录（页面点“清空记录”时一起清掉，防止下次同步又复活）。
    if (url.pathname === "/api/clear" && request.method === "POST") {
      var clearBody = await request.json().catch(function () { return null; });
      if (!clearBody || !validHash(clearBody.passHash)) {
        return jsonResponse({ ok: false, error: "bad request" }, 400, request);
      }
      if (clearBody.passHash !== PW_HASH) {
        return jsonResponse({ ok: false, error: "wrong password" }, 401, request);
      }
      await env.YUQIBO_KV.put("records", JSON.stringify({
        records: [], deleted: [], updatedAt: Date.now(),
      }));
      return jsonResponse({ ok: true }, 200, request);
    }

    return jsonResponse({ ok: false, error: "not found" }, 404, request);
  },
};
