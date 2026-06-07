var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/[[route]].js
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization"
};
async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
async function auth(req, env) {
  const authH = req.headers.get("Authorization");
  if (!authH || !authH.startsWith("Bearer ")) return null;
  const tokens = JSON.parse(await env.PINDOU_KV.get("tokens") || "{}");
  const t = tokens[authH.slice(7)];
  if (!t || t.expireAt < Date.now()) return null;
  return t;
}
__name(auth, "auth");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
  });
}
__name(json, "json");
async function addLog(env, type, detail) {
  const raw = await env.PINDOU_KV.get("logs") || "[]";
  const logs = JSON.parse(raw);
  logs.push({ type, detail, time: Date.now() });
  if (logs.length > 5e3) logs.splice(0, logs.length - 5e3);
  await env.PINDOU_KV.put("logs", JSON.stringify(logs));
}
__name(addLog, "addLog");
async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (path === "/api/login" && request.method === "POST") {
    const { phone, password } = await request.json();
    if (!phone || !password) return json({ ok: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
    const raw = await env.PINDOU_KV.get("merchants") || "[]";
    const merchants = JSON.parse(raw);
    const m = merchants.find((x) => x.phone === phone);
    if (!m) return json({ ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728" }, 401);
    if (m.status === "disabled") return json({ ok: false, error: "\u8D26\u53F7\u5DF2\u88AB\u7981\u7528" }, 403);
    if (m.status === "expired") return json({ ok: false, error: "\u4F1A\u5458\u5DF2\u5230\u671F" }, 403);
    const hash = await sha256(password);
    if (hash !== m.password) return json({ ok: false, error: "\u5BC6\u7801\u9519\u8BEF" }, 401);
    if (m.expireTime && Date.now() > m.expireTime) {
      m.status = "disabled";
      await env.PINDOU_KV.put("merchants", JSON.stringify(merchants));
      return json({ ok: false, error: "\u4F1A\u5458\u5DF2\u5230\u671F\uFF0C\u8D26\u53F7\u5DF2\u7981\u7528" }, 403);
    }
    const token = crypto.randomUUID();
    const tokens = JSON.parse(await env.PINDOU_KV.get("tokens") || "{}");
    tokens[token] = { phone, role: m.role, expireAt: Date.now() + 864e5 };
    await env.PINDOU_KV.put("tokens", JSON.stringify(tokens));
    return json({ ok: true, token, role: m.role, phone, name: m.name, expireTime: m.expireTime, createTime: m.createTime });
  }
  if (path === "/api/change-password" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const { oldPassword, newPassword } = await request.json();
    if (!oldPassword || !newPassword) return json({ ok: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
    if (newPassword.length < 4) return json({ ok: false, error: "\u65B0\u5BC6\u7801\u81F3\u5C114\u4F4D" }, 400);
    const raw = await env.PINDOU_KV.get("merchants") || "[]";
    let merchants = JSON.parse(raw);
    const m = merchants.find((x) => x.phone === user.phone);
    if (!m) return json({ ok: false, error: "\u8D26\u53F7\u4E0D\u5B58\u5728" }, 404);
    const hash = await sha256(oldPassword);
    if (hash !== m.password) return json({ ok: false, error: "\u65E7\u5BC6\u7801\u9519\u8BEF" }, 401);
    m.password = await sha256(newPassword);
    await env.PINDOU_KV.put("merchants", JSON.stringify(merchants));
    return json({ ok: true });
  }
  if (path === "/api/merchants" && request.method === "GET") {
    const user = await auth(request, env);
    if (!user || user.role !== "admin") return json({ ok: false, error: "\u65E0\u6743\u9650" }, 403);
    const raw = await env.PINDOU_KV.get("merchants") || "[]";
    let merchants = JSON.parse(raw);
    let changed = false;
    for (const m of merchants) {
      if (m.expireTime && Date.now() > m.expireTime && m.status === "active") {
        m.status = "disabled";
        changed = true;
      }
    }
    if (changed) await env.PINDOU_KV.put("merchants", JSON.stringify(merchants));
    const safe = merchants.map(({ password, ...m }) => m);
    return json({ ok: true, merchants: safe });
  }
  if (path === "/api/merchants" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user || user.role !== "admin") return json({ ok: false, error: "\u65E0\u6743\u9650" }, 403);
    const body = await request.json();
    const { phone, password, name, days, action: act } = body;
    const raw = await env.PINDOU_KV.get("merchants") || "[]";
    let merchants = JSON.parse(raw);
    if (act === "add") {
      if (!phone || !password) return json({ ok: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
      if (merchants.find((m) => m.phone === phone)) return json({ ok: false, error: "\u624B\u673A\u53F7\u5DF2\u5B58\u5728" }, 400);
      const now = Date.now();
      merchants.push({
        phone,
        name: name || "",
        role: "merchant",
        password: await sha256(password),
        status: "active",
        createTime: now,
        expireTime: days ? now + days * 864e5 : now + 365 * 864e5
      });
    } else if (act === "renew") {
      const m = merchants.find((m2) => m2.phone === phone);
      if (!m) return json({ ok: false, error: "\u5546\u5BB6\u4E0D\u5B58\u5728" }, 404);
      const d = parseInt(days) || 30;
      const oldExpire = m.expireTime;
      m.status = "active";
      m.expireTime = Math.max(Date.now() + 864e5, (m.expireTime || Date.now()) + d * 864e5);
      const logRaw = await env.PINDOU_KV.get("renew_logs") || "[]";
      const logs = JSON.parse(logRaw);
      logs.push({
        phone,
        days: d,
        oldExpire: oldExpire || Date.now(),
        newExpire: m.expireTime,
        time: Date.now(),
        operator: user.phone
      });
      await env.PINDOU_KV.put("renew_logs", JSON.stringify(logs.slice(-500)));
    } else if (act === "disable") {
      const m = merchants.find((m2) => m2.phone === phone);
      if (!m) return json({ ok: false, error: "\u5546\u5BB6\u4E0D\u5B58\u5728" }, 404);
      m.status = m.status === "disabled" ? "active" : "disabled";
    } else if (act === "delete") {
      merchants = merchants.filter((m) => m.phone !== phone);
      const shops = JSON.parse(await env.PINDOU_KV.get("shops") || "[]");
      const deletedShops = shops.filter((s) => s.ownerPhone === phone);
      const keptShops = shops.filter((s) => s.ownerPhone !== phone);
      const orders = JSON.parse(await env.PINDOU_KV.get("orders") || "[]");
      const deletedShopIds = new Set(deletedShops.map((s) => s.id));
      const keptOrders = orders.filter((o) => !deletedShopIds.has(o.shopId));
      await env.PINDOU_KV.put("shops", JSON.stringify(keptShops));
      await env.PINDOU_KV.put("orders", JSON.stringify(keptOrders));
    } else {
      return json({ ok: false, error: "\u65E0\u6548\u64CD\u4F5C" }, 400);
    }
    const tokens = JSON.parse(await env.PINDOU_KV.get("tokens") || "{}");
    for (const k of Object.keys(tokens)) {
      if (tokens[k].phone === phone) delete tokens[k];
    }
    await env.PINDOU_KV.put("tokens", JSON.stringify(tokens));
    await env.PINDOU_KV.put("merchants", JSON.stringify(merchants));
    return json({ ok: true });
  }
  if (path === "/api/shops" && request.method === "GET") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const raw = await env.PINDOU_KV.get("shops") || "[]";
    const shops = JSON.parse(raw).filter((s) => s.ownerPhone === user.phone);
    return json({ ok: true, shops });
  }
  if (path === "/api/shops" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user || user.role !== "merchant") return json({ ok: false, error: "\u65E0\u6743\u9650" }, 403);
    const body = await request.json();
    const raw = await env.PINDOU_KV.get("shops") || "[]";
    let shops = JSON.parse(raw);
    if (body.action === "rename") {
      const idx = shops.findIndex((s) => s.ownerPhone === user.phone && s.status === "active");
      if (idx === -1) return json({ ok: false, error: "\u5E97\u94FA\u4E0D\u5B58\u5728" }, 404);
      if (!body.name || !body.name.trim()) return json({ ok: false, error: "\u540D\u79F0\u4E0D\u80FD\u4E3A\u7A7A" }, 400);
      shops[idx].name = body.name.trim();
      await env.PINDOU_KV.put("shops", JSON.stringify(shops));
      return json({ ok: true, name: shops[idx].name });
    }
    if (body.action === "toggle") {
      const idx = shops.findIndex((s) => s.ownerPhone === user.phone);
      if (idx === -1) return json({ ok: false, error: "\u5E97\u94FA\u4E0D\u5B58\u5728" }, 404);
      shops[idx].status = shops[idx].status === "active" ? "paused" : "active";
      await env.PINDOU_KV.put("shops", JSON.stringify(shops));
      return json({ ok: true, status: shops[idx].status });
    }
    if (shops.find((s) => s.ownerPhone === user.phone && s.status === "active")) {
      return json({ ok: false, error: "\u5DF2\u6709\u4E00\u4E2A\u5E97\u94FA\uFF0C\u4E0D\u80FD\u91CD\u590D\u521B\u5EFA" }, 400);
    }
    const shop = {
      id: crypto.randomUUID().slice(0, 8),
      name: body.name || "\u62FC\u8C46\u624B\u5DE5\u574A",
      ownerPhone: user.phone,
      status: "active",
      createTime: Date.now()
    };
    shops.push(shop);
    await env.PINDOU_KV.put("shops", JSON.stringify(shops));
    return json({ ok: true, shop });
  }
  if (path === "/api/packages" && request.method === "GET") {
    const shopId = url.searchParams.get("shopId");
    if (!shopId) return json({ ok: false, error: "\u7F3A\u5C11shopId" }, 400);
    const raw = await env.PINDOU_KV.get("packages") || "{}";
    const data = JSON.parse(raw);
    return json({ ok: true, packages: data[shopId] || null });
  }
  if (path === "/api/packages" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user || user.role !== "merchant") return json({ ok: false, error: "\u65E0\u6743\u9650" }, 403);
    const { shopId, packages } = await request.json();
    if (!shopId) return json({ ok: false, error: "\u7F3A\u5C11shopId" }, 400);
    const raw = await env.PINDOU_KV.get("packages") || "{}";
    const data = JSON.parse(raw);
    data[shopId] = packages;
    await env.PINDOU_KV.put("packages", JSON.stringify(data));
    return json({ ok: true });
  }
  if (path.startsWith("/api/shops/") && request.method === "GET") {
    const shopId = path.split("/")[3];
    const raw = await env.PINDOU_KV.get("shops") || "[]";
    const shop = JSON.parse(raw).find((s) => s.id === shopId);
    if (!shop) return json({ ok: false, error: "\u5E97\u94FA\u4E0D\u5B58\u5728" }, 404);
    return json({ ok: true, shop: { id: shop.id, name: shop.name } });
  }
  if (path === "/api/orders" && request.method === "GET") {
    const shopId = url.searchParams.get("shopId");
    const code = url.searchParams.get("code");
    const status = url.searchParams.get("status");
    const search = url.searchParams.get("search");
    if (!shopId) return json({ ok: false, error: "\u7F3A\u5C11shopId" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let allOrders = JSON.parse(raw);
    const now = Date.now();
    let changed = false;
    for (const o of allOrders) {
      if (o.status === "active" && o.minutes > 0 && o.startTime && now >= o.startTime + o.minutes * 6e4) {
        o.status = "completed";
        o.endTime = o.startTime + o.minutes * 6e4;
        changed = true;
      }
    }
    if (changed) await env.PINDOU_KV.put("orders", JSON.stringify(allOrders));
    let orders = allOrders.filter((o) => o.shopId === shopId);
    if (code) orders = orders.filter((o) => o.code === code && o.status === "active");
    if (status && status !== "all") orders = orders.filter((o) => o.status === status);
    if (search) orders = orders.filter((o) => o.code.includes(search));
    return json({ ok: true, orders });
  }
  if (path === "/api/orders" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, code, minutes, price, type } = body;
    if (!shopId || !code || !/^\d{4}$/.test(code)) return json({ ok: false, error: "\u53C2\u6570\u9519\u8BEF" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw);
    if (orders.find((o) => o.shopId === shopId && o.code === code && o.status === "active")) {
      return json({ ok: false, error: "\u8BE5\u624B\u673A\u53F7\u5DF2\u6709\u8FDB\u884C\u4E2D\u7684\u8BA2\u5355" }, 400);
    }
    const order = {
      id: crypto.randomUUID().slice(0, 8),
      shopId,
      code,
      type: type || "single",
      price: Number(price) || 0,
      minutes: Number(minutes) || 0,
      startTime: Date.now(),
      status: "active"
    };
    orders.push(order);
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    await addLog(env, "create", { phone: user.phone, shopId, code, type: order.type, price: order.price, minutes: order.minutes });
    return json({ ok: true, order });
  }
  if (path === "/api/orders/batch-complete" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, codes } = body;
    if (!shopId || !codes || !codes.length) return json({ ok: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw);
    let count = 0;
    const now = Date.now();
    for (const code of codes) {
      const idx = orders.findIndex((o) => o.shopId === shopId && o.code === code && o.status === "active");
      if (idx !== -1) {
        orders[idx].status = "completed";
        orders[idx].endTime = now;
        count++;
        await addLog(env, "complete", { phone: user.phone, shopId, code });
      }
    }
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    return json({ ok: true, count });
  }
  if (path === "/api/orders/complete" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, code } = body;
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw);
    const idx = orders.findIndex((o) => o.shopId === shopId && o.code === code && o.status === "active");
    if (idx === -1) return json({ ok: false, error: "\u8BA2\u5355\u4E0D\u5B58\u5728" }, 404);
    orders[idx].status = "completed";
    orders[idx].endTime = Date.now();
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    await addLog(env, "complete", { phone: user.phone, shopId, code });
    return json({ ok: true });
  }
  if (path === "/api/orders/extend" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, code, minutes, price } = body;
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw);
    const order = orders.find((o) => o.shopId === shopId && o.code === code && o.status === "active");
    if (!order) return json({ ok: false, error: "\u8BA2\u5355\u4E0D\u5B58\u5728" }, 404);
    if (minutes === 0) order.minutes = 0;
    else order.minutes += Number(minutes) || 0;
    order.price += Number(price) || 0;
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    await addLog(env, "extend", { phone: user.phone, shopId, code, minutes, price });
    return json({ ok: true, order });
  }
  if (path === "/api/orders/edit" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, orderId, code, type, price, minutes } = body;
    if (!shopId || !orderId || !code || !/^\d{4}$/.test(code)) return json({ ok: false, error: "\u53C2\u6570\u9519\u8BEF" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw);
    const idx = orders.findIndex((o) => o.id === orderId && o.shopId === shopId);
    if (idx === -1) return json({ ok: false, error: "\u8BA2\u5355\u4E0D\u5B58\u5728" }, 404);
    orders[idx].code = code;
    orders[idx].type = type || "single";
    orders[idx].price = Number(price) || 0;
    orders[idx].minutes = Number(minutes) || 0;
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    return json({ ok: true, order: orders[idx] });
  }
  if (path === "/api/orders/delete" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, orderId } = body;
    if (!shopId || !orderId) return json({ ok: false, error: "\u53C2\u6570\u9519\u8BEF" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw);
    const idx = orders.findIndex((o) => o.id === orderId && o.shopId === shopId);
    if (idx === -1) return json({ ok: false, error: "\u8BA2\u5355\u4E0D\u5B58\u5728" }, 404);
    const deleted = orders.splice(idx, 1)[0];
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    await addLog(env, "delete", { phone: user.phone, shopId, code: deleted.code });
    return json({ ok: true, code: deleted.code });
  }
  if (path === "/api/orders/remove" && request.method === "POST") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const body = await request.json();
    const { shopId, code } = body;
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    let orders = JSON.parse(raw).filter((o) => !(o.shopId === shopId && o.code === code));
    await env.PINDOU_KV.put("orders", JSON.stringify(orders));
    return json({ ok: true });
  }
  if (path === "/api/logs" && request.method === "GET") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const raw = await env.PINDOU_KV.get("logs") || "[]";
    const logs = JSON.parse(raw);
    const shopId = url.searchParams.get("shopId");
    if (shopId) return json({ ok: true, logs: logs.filter((l) => l.detail && l.detail.shopId === shopId).slice(-200) });
    return json({ ok: true, logs: logs.slice(-200) });
  }
  if (path === "/api/renew-logs" && request.method === "GET") {
    const user = await auth(request, env);
    if (!user || user.role !== "admin") return json({ ok: false, error: "\u65E0\u6743\u9650" }, 403);
    const raw = await env.PINDOU_KV.get("renew_logs") || "[]";
    return json({ ok: true, logs: JSON.parse(raw) });
  }
  if (path === "/api/stats" && request.method === "GET") {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: "\u672A\u767B\u5F55" }, 401);
    const shopId = url.searchParams.get("shopId");
    if (!shopId) return json({ ok: false, error: "\u7F3A\u5C11shopId" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    const today = /* @__PURE__ */ new Date();
    today.setHours(0, 0, 0, 0);
    const t0 = today.getTime();
    const orders = JSON.parse(raw).filter((o) => o.shopId === shopId);
    const todayOrders = orders.filter((o) => o.startTime >= t0);
    const todayCompleted = todayOrders.filter((o) => o.status === "completed");
    const todayActive = todayOrders.filter((o) => o.status === "active");
    const revenue = todayCompleted.reduce((s, o) => s + (o.price || 0), 0) + todayActive.reduce((s, o) => s + (o.price || 0), 0);
    return json({ ok: true, stats: {
      todayTotal: todayOrders.length,
      todayActive: todayActive.length,
      todayCompleted: todayCompleted.length,
      todayRevenue: Math.round(revenue * 100) / 100,
      totalOrders: orders.length
    } });
  }
  if (path === "/api/orders/lookup") {
    const shopId = url.searchParams.get("shopId");
    const code = url.searchParams.get("code");
    if (!shopId || !code) return json({ ok: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    const order = JSON.parse(raw).find((o) => o.shopId === shopId && o.code === code && o.status === "active");
    if (!order) return json({ ok: false, error: "\u8BA2\u5355\u4E0D\u5B58\u5728\u6216\u5DF2\u7ED3\u675F" }, 404);
    return json({ ok: true, order });
  }
  if (path === "/api/orders/history" && request.method === "GET") {
    const shopId = url.searchParams.get("shopId");
    const code = url.searchParams.get("code");
    if (!shopId || !code) return json({ ok: false, error: "\u7F3A\u5C11\u53C2\u6570" }, 400);
    const raw = await env.PINDOU_KV.get("orders") || "[]";
    const orders = JSON.parse(raw).filter((o) => o.shopId === shopId && o.code === code);
    return json({ ok: true, orders });
  }
  return json({ error: "Not found" }, 404);
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-Nwv61y/functionsRoutes-0.8160564007018103.mjs
var routes = [
  {
    routePath: "/api/:route*",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../../.npm-global/lib/node_modules/wrangler/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../.npm-global/lib/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../../.npm-global/lib/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../.npm-global/lib/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-Fg09ap/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../../.npm-global/lib/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-Fg09ap/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.9269302610312382.mjs.map
