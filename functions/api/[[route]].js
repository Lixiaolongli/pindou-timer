// 拼豆计时器 API v2 - Pages Functions 格式
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2,'0')).join('');
}

async function auth(req, env) {
  const authH = req.headers.get('Authorization');
  if (!authH || !authH.startsWith('Bearer ')) return null;
  const tokens = JSON.parse(await env.PINDOU_KV.get('tokens') || '{}');
  const t = tokens[authH.slice(7)];
  if (!t || t.expireAt < Date.now()) return null;
  return t;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function addLog(env, type, detail) {
  const raw = await env.PINDOU_KV.get('logs') || '[]';
  const logs = JSON.parse(raw);
  logs.push({ type, detail, time: Date.now() });
  if (logs.length > 5000) logs.splice(0, logs.length - 5000);
  await env.PINDOU_KV.put('logs', JSON.stringify(logs));
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ============ 登录 ============
  if (path === '/api/login' && request.method === 'POST') {
    const { phone, password } = await request.json();
    if (!phone || !password) return json({ ok: false, error: '缺少参数' }, 400);
    const raw = await env.PINDOU_KV.get('merchants') || '[]';
    const merchants = JSON.parse(raw);
    const m = merchants.find(x => x.phone === phone);
    if (!m) return json({ ok: false, error: '账号不存在' }, 401);
    if (m.status === 'disabled') return json({ ok: false, error: '账号已被禁用' }, 403);
    if (m.status === 'expired') return json({ ok: false, error: '会员已到期' }, 403);
    const hash = await sha256(password);
    if (hash !== m.password) return json({ ok: false, error: '密码错误' }, 401);

    if (m.expireTime && Date.now() > m.expireTime) {
      m.status = 'disabled';
      await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
      return json({ ok: false, error: '会员已到期，账号已禁用' }, 403);
    }

    const token = crypto.randomUUID();
    const tokens = JSON.parse(await env.PINDOU_KV.get('tokens') || '{}');
    tokens[token] = { phone, role: m.role, expireAt: Date.now() + 86400000 };
    await env.PINDOU_KV.put('tokens', JSON.stringify(tokens));
    return json({ ok: true, token, role: m.role, phone, name: m.name });
  }

  // ============ 修改密码 ============
  if (path === '/api/change-password' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const { oldPassword, newPassword } = await request.json();
    if (!oldPassword || !newPassword) return json({ ok: false, error: '缺少参数' }, 400);
    if (newPassword.length < 4) return json({ ok: false, error: '新密码至少4位' }, 400);
    const raw = await env.PINDOU_KV.get('merchants') || '[]';
    let merchants = JSON.parse(raw);
    const m = merchants.find(x => x.phone === user.phone);
    if (!m) return json({ ok: false, error: '账号不存在' }, 404);
    const hash = await sha256(oldPassword);
    if (hash !== m.password) return json({ ok: false, error: '旧密码错误' }, 401);
    m.password = await sha256(newPassword);
    await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
    return json({ ok: true });
  }

  // ============ 管理员：商家列表 ============
  if (path === '/api/merchants' && request.method === 'GET') {
    const user = await auth(request, env);
    if (!user || user.role !== 'admin') return json({ ok: false, error: '无权限' }, 403);
    const raw = await env.PINDOU_KV.get('merchants') || '[]';
    let merchants = JSON.parse(raw);
    let changed = false;
    for (const m of merchants) {
      if (m.expireTime && Date.now() > m.expireTime && m.status === 'active') {
        m.status = 'disabled'; changed = true;
      }
    }
    if (changed) await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
    const safe = merchants.map(({ password, ...m }) => m);
    return json({ ok: true, merchants: safe });
  }

  // ============ 管理员：添加/续费/禁用/删除商家 ============
  if (path === '/api/merchants' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user || user.role !== 'admin') return json({ ok: false, error: '无权限' }, 403);
    const body = await request.json();
    const { phone, password, name, days, action: act } = body;
    const raw = await env.PINDOU_KV.get('merchants') || '[]';
    let merchants = JSON.parse(raw);

    if (act === 'add') {
      if (!phone || !password) return json({ ok: false, error: '缺少参数' }, 400);
      if (merchants.find(m => m.phone === phone)) return json({ ok: false, error: '手机号已存在' }, 400);
      const now = Date.now();
      merchants.push({
        phone, name: name || '', role: 'merchant',
        password: await sha256(password),
        status: 'active',
        createTime: now,
        expireTime: days ? now + days * 86400000 : now + 365 * 86400000,
      });
    } else if (act === 'renew') {
      const m = merchants.find(m => m.phone === phone);
      if (!m) return json({ ok: false, error: '商家不存在' }, 404);
      const d = parseInt(days) || 30;
      const oldExpire = m.expireTime;
      m.status = 'active';
      m.expireTime = Math.max(Date.now() + 86400000, (m.expireTime || Date.now()) + d * 86400000);
      const logRaw = await env.PINDOU_KV.get('renew_logs') || '[]';
      const logs = JSON.parse(logRaw);
      logs.push({
        phone, days: d,
        oldExpire: oldExpire || Date.now(),
        newExpire: m.expireTime,
        time: Date.now(),
        operator: user.phone
      });
      await env.PINDOU_KV.put('renew_logs', JSON.stringify(logs.slice(-500)));
    } else if (act === 'disable') {
      const m = merchants.find(m => m.phone === phone);
      if (!m) return json({ ok: false, error: '商家不存在' }, 404);
      m.status = 'disabled';
    } else if (act === 'delete') {
      merchants = merchants.filter(m => m.phone !== phone);
    } else {
      return json({ ok: false, error: '无效操作' }, 400);
    }
    await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
    return json({ ok: true });
  }

  // ============ 商家：我的店铺 ============
  if (path === '/api/shops' && request.method === 'GET') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const raw = await env.PINDOU_KV.get('shops') || '[]';
    const shops = JSON.parse(raw).filter(s => s.ownerPhone === user.phone);
    return json({ ok: true, shops });
  }

  if (path === '/api/shops' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user || user.role !== 'merchant') return json({ ok: false, error: '无权限' }, 403);
    const raw = await env.PINDOU_KV.get('shops') || '[]';
    let shops = JSON.parse(raw);
    if (shops.find(s => s.ownerPhone === user.phone && s.status === 'active')) {
      return json({ ok: false, error: '已有一个店铺，不能重复创建' }, 400);
    }
    const { name } = await request.json();
    const shop = {
      id: crypto.randomUUID().slice(0, 8),
      name: name || '拼豆手工坊',
      ownerPhone: user.phone,
      status: 'active',
      createTime: Date.now(),
    };
    shops.push(shop);
    await env.PINDOU_KV.put('shops', JSON.stringify(shops));
    return json({ ok: true, shop });
  }

  // ============ 套餐管理 ============
  if (path === '/api/packages' && request.method === 'GET') {
    const shopId = url.searchParams.get('shopId');
    if (!shopId) return json({ ok: false, error: '缺少shopId' }, 400);
    const raw = await env.PINDOU_KV.get('packages') || '{}';
    const data = JSON.parse(raw);
    return json({ ok: true, packages: data[shopId] || null });
  }
  if (path === '/api/packages' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user || user.role !== 'merchant') return json({ ok: false, error: '无权限' }, 403);
    const { shopId, packages } = await request.json();
    if (!shopId) return json({ ok: false, error: '缺少shopId' }, 400);
    const raw = await env.PINDOU_KV.get('packages') || '{}';
    const data = JSON.parse(raw);
    data[shopId] = packages;
    await env.PINDOU_KV.put('packages', JSON.stringify(data));
    return json({ ok: true });
  }

  // ============ 店铺详情（公开） ============
  if (path.startsWith('/api/shops/') && request.method === 'GET') {
    const shopId = path.split('/')[3];
    const raw = await env.PINDOU_KV.get('shops') || '[]';
    const shop = JSON.parse(raw).find(s => s.id === shopId);
    if (!shop) return json({ ok: false, error: '店铺不存在' }, 404);
    return json({ ok: true, shop: { id: shop.id, name: shop.name } });
  }

  // ============ 订单查询 ============
  if (path === '/api/orders' && request.method === 'GET') {
    const shopId = url.searchParams.get('shopId');
    const code = url.searchParams.get('code');
    const status = url.searchParams.get('status'); // active|completed|all
    const search = url.searchParams.get('search'); // 手机尾号搜索
    if (!shopId) return json({ ok: false, error: '缺少shopId' }, 400);
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    let allOrders = JSON.parse(raw);
    const now = Date.now();
    let changed = false;
    for (const o of allOrders) {
      if (o.status === 'active' && o.minutes > 0 && o.startTime && now >= o.startTime + o.minutes * 60000) {
        o.status = 'completed';
        o.endTime = o.startTime + o.minutes * 60000;
        changed = true;
      }
    }
    if (changed) await env.PINDOU_KV.put('orders', JSON.stringify(allOrders));
    let orders = allOrders.filter(o => o.shopId === shopId);
    if (code) orders = orders.filter(o => o.code === code && o.status === 'active');
    if (status && status !== 'all') orders = orders.filter(o => o.status === status);
    if (search) orders = orders.filter(o => o.code.includes(search));
    return json({ ok: true, orders });
  }
  // ============ 创建订单 ============
  if (path === '/api/orders' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const body = await request.json();
    const { shopId, code, minutes, price, type } = body;
    if (!shopId || !code || !/^\d{4}$/.test(code)) return json({ ok: false, error: '参数错误' }, 400);
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    let orders = JSON.parse(raw);
    if (orders.find(o => o.shopId === shopId && o.code === code && o.status === 'active')) {
      return json({ ok: false, error: '该手机号已有进行中的订单' }, 400);
    }
    const order = {
      id: crypto.randomUUID().slice(0, 8),
      shopId, code,
      type: type || 'single',
      price: Number(price) || 0,
      minutes: Number(minutes) || 0,
      startTime: Date.now(),
      status: 'active',
    };
    orders.push(order);
    await env.PINDOU_KV.put('orders', JSON.stringify(orders));
    await addLog(env, 'create', { phone: user.phone, shopId, code, type: order.type, price: order.price, minutes: order.minutes });
    return json({ ok: true, order });
  }

  // ============ 批量完成订单 ============
  if (path === '/api/orders/batch-complete' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const body = await request.json();
    const { shopId, codes } = body;
    if (!shopId || !codes || !codes.length) return json({ ok: false, error: '缺少参数' }, 400);
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    let orders = JSON.parse(raw);
    let count = 0;
    const now = Date.now();
    for (const code of codes) {
      const idx = orders.findIndex(o => o.shopId === shopId && o.code === code && o.status === 'active');
      if (idx !== -1) {
        orders[idx].status = 'completed';
        orders[idx].endTime = now;
        count++;
        await addLog(env, 'complete', { phone: user.phone, shopId, code });
      }
    }
    await env.PINDOU_KV.put('orders', JSON.stringify(orders));
    return json({ ok: true, count });
  }

  // ============ 完成订单 ============
  if (path === '/api/orders/complete' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const body = await request.json();
    const { shopId, code } = body;
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    let orders = JSON.parse(raw);
    const idx = orders.findIndex(o => o.shopId === shopId && o.code === code && o.status === 'active');
    if (idx === -1) return json({ ok: false, error: '订单不存在' }, 404);
    orders[idx].status = 'completed';
    orders[idx].endTime = Date.now();
    await env.PINDOU_KV.put('orders', JSON.stringify(orders));
    await addLog(env, 'complete', { phone: user.phone, shopId, code });
    return json({ ok: true });
  }

  // ============ 续时 ============
  if (path === '/api/orders/extend' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const body = await request.json();
    const { shopId, code, minutes, price } = body;
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    let orders = JSON.parse(raw);
    const order = orders.find(o => o.shopId === shopId && o.code === code && o.status === 'active');
    if (!order) return json({ ok: false, error: '订单不存在' }, 404);
    if (minutes === 0) order.minutes = 0;
    else order.minutes += (Number(minutes) || 0);
    order.price += (Number(price) || 0);
    await env.PINDOU_KV.put('orders', JSON.stringify(orders));
    await addLog(env, 'extend', { phone: user.phone, shopId, code, minutes, price });
    return json({ ok: true, order });
  }

  // ============ 删除订单 ============
  if (path === '/api/orders/remove' && request.method === 'POST') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const body = await request.json();
    const { shopId, code } = body;
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    let orders = JSON.parse(raw).filter(o => !(o.shopId === shopId && o.code === code));
    await env.PINDOU_KV.put('orders', JSON.stringify(orders));
    return json({ ok: true });
  }

  // ============ 操作日志 ============
  if (path === '/api/logs' && request.method === 'GET') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const raw = await env.PINDOU_KV.get('logs') || '[]';
    const logs = JSON.parse(raw);
    const shopId = url.searchParams.get('shopId');
    if (shopId) return json({ ok: true, logs: logs.filter(l => l.detail && l.detail.shopId === shopId).slice(-200) });
    return json({ ok: true, logs: logs.slice(-200) });
  }

  // ============ 续费记录 ============
  if (path === '/api/renew-logs' && request.method === 'GET') {
    const user = await auth(request, env);
    if (!user || user.role !== 'admin') return json({ ok: false, error: '无权限' }, 403);
    const raw = await env.PINDOU_KV.get('renew_logs') || '[]';
    return json({ ok: true, logs: JSON.parse(raw) });
  }

  // ============ 今日营收统计 ============
  if (path === '/api/stats' && request.method === 'GET') {
    const user = await auth(request, env);
    if (!user) return json({ ok: false, error: '未登录' }, 401);
    const shopId = url.searchParams.get('shopId');
    if (!shopId) return json({ ok: false, error: '缺少shopId' }, 400);
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    const today = new Date();
    today.setHours(0,0,0,0);
    const t0 = today.getTime();
    const orders = JSON.parse(raw).filter(o => o.shopId === shopId);
    const todayOrders = orders.filter(o => o.startTime >= t0);
    const todayCompleted = todayOrders.filter(o => o.status === 'completed');
    const todayActive = todayOrders.filter(o => o.status === 'active');
    const revenue = todayCompleted.reduce((s,o) => s + (o.price||0), 0)
                   + todayActive.reduce((s,o) => s + (o.price||0), 0);
    return json({ ok: true, stats: {
      todayTotal: todayOrders.length,
      todayActive: todayActive.length,
      todayCompleted: todayCompleted.length,
      todayRevenue: Math.round(revenue * 100) / 100,
      totalOrders: orders.length,
    }});
  }

  // ============ 顾客查订单（公开） ============
  if (path === '/api/orders/lookup') {
    const shopId = url.searchParams.get('shopId');
    const code = url.searchParams.get('code');
    if (!shopId || !code) return json({ ok: false, error: '缺少参数' }, 400);
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    const order = JSON.parse(raw).find(o => o.shopId === shopId && o.code === code && o.status === 'active');
    if (!order) return json({ ok: false, error: '订单不存在或已结束' }, 404);
    return json({ ok: true, order });
  }

  // ============ 顾客历史订单 ============
  if (path === '/api/orders/history' && request.method === 'GET') {
    const shopId = url.searchParams.get('shopId');
    const code = url.searchParams.get('code');
    if (!shopId || !code) return json({ ok: false, error: '缺少参数' }, 400);
    const raw = await env.PINDOU_KV.get('orders') || '[]';
    const orders = JSON.parse(raw).filter(o => o.shopId === shopId && o.code === code);
    return json({ ok: true, orders });
  }

  return json({ error: 'Not found' }, 404);
}
