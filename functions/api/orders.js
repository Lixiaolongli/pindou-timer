// 拼豆计时器 API - Cloudflare Pages Functions
// 使用 Pages KV 绑定

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // CORS 预检
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  // 检查 KV 绑定是否可用
  if (!env.PINDOU_KV) {
    return new Response(JSON.stringify({ error: 'KV binding not found: PINDOU_KV' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  const raw = await env.PINDOU_KV.get('orders');
  let orders = raw ? JSON.parse(raw) : [];

  // POST /api/orders - 创建订单
  if (path === '/api/orders' && request.method === 'POST') {
    try {
      const body = await request.json();
      const activeCodes = new Set(orders.filter(o => o.status === 'active').map(o => o.code));
      let code;
      do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (activeCodes.has(code));

      const order = {
        code,
        type: body.type || 'single',
        price: body.price || 0,
        minutes: body.minutes || 0,
        startTime: Date.now(),
        status: 'active',
      };
      orders.push(order);
      await env.PINDOU_KV.put('orders', JSON.stringify(orders));
      return new Response(JSON.stringify(order), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  // GET /api/orders - 获取所有订单（含已完成）
  if (path === '/api/orders' && request.method === 'GET') {
    return new Response(JSON.stringify(orders), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // GET /api/orders/active - 获取活跃订单
  if (path === '/api/orders/active' && request.method === 'GET') {
    const active = orders.filter(o => o.status === 'active');
    return new Response(JSON.stringify(active), { headers: { ...CORS, 'Content-Type': 'application/json' } });
  }

  // POST /api/orders/complete - 完成订单
  if (path === '/api/orders/complete' && request.method === 'POST') {
    try {
      const body = await request.json();
      const idx = orders.findIndex(o => o.code === body.code && o.status === 'active');
      if (idx !== -1) {
        orders[idx].status = 'completed';
        orders[idx].endTime = Date.now();
        await env.PINDOU_KV.put('orders', JSON.stringify(orders));
        return new Response(JSON.stringify(orders[idx]), { headers: { ...CORS, 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: '订单不存在' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  // POST /api/orders/remove - 删除订单
  if (path === '/api/orders/remove' && request.method === 'POST') {
    try {
      const body = await request.json();
      orders = orders.filter(o => o.code !== body.code);
      await env.PINDOU_KV.put('orders', JSON.stringify(orders));
      return new Response(JSON.stringify({ ok: true }), { headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  }

  // 404
  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
