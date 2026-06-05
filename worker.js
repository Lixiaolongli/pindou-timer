// 拼豆计时器 API v2 - 多商家 + 手机号密码登录
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' };

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const json = (d, s=200) => new Response(JSON.stringify(d), { status: s, headers: {...CORS,'Content-Type':'application/json'} });

    // ==== 登录 ====
    if (p==='/api/login' && req.method==='POST') {
      const { phone, password } = await req.json();
      if (!phone || !password) return json({ok:false,error:'缺少参数'}, 400);
      const raw = await env.PINDOU_KV.get('merchants') || '[]';
      const merchants = JSON.parse(raw);
      const m = merchants.find(x => x.phone === phone);
      if (!m) return json({ok:false,error:'账号不存在'}, 401);
      if (m.status === 'expired') return json({ok:false,error:'会员已到期'}, 403);
      const hash = await sha256(password);
      if (hash !== m.password) return json({ok:false,error:'密码错误'}, 401);

      // 检查到期
      if (m.expireTime && Date.now() > m.expireTime) {
        m.status = 'expired';
        await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
        return json({ok:false,error:'会员已到期'}, 403);
      }

      const token = crypto.randomUUID();
      // 存 token -> phone
      const tokens = JSON.parse(await env.PINDOU_KV.get('tokens') || '{}');
      tokens[token] = { phone, role: m.role, expireAt: Date.now() + 86400000 };
      await env.PINDOU_KV.put('tokens', JSON.stringify(tokens));

      return json({ ok:true, token, role: m.role, phone, name: m.name });
    }

    // Token 验证 helper
    async function auth() {
      const authH = req.headers.get('Authorization');
      if (!authH || !authH.startsWith('Bearer ')) return null;
      const tokens = JSON.parse(await env.PINDOU_KV.get('tokens') || '{}');
      const t = tokens[authH.slice(7)];
      if (!t || t.expireAt < Date.now()) return null;
      return t;
    }

    // ==== 管理员：商家列表 ====
    if (p==='/api/merchants' && req.method==='GET') {
      const user = await auth();
      if (!user || user.role !== 'admin') return json({ok:false,error:'无权限'}, 403);
      const raw = await env.PINDOU_KV.get('merchants') || '[]';
      let merchants = JSON.parse(raw);
      // 检查到期
      let changed = false;
      for (const m of merchants) {
        if (m.expireTime && Date.now() > m.expireTime && m.status === 'active') { m.status = 'expired'; changed = true; }
      }
      if (changed) await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
      // 不返回密码
      const safe = merchants.map(({password,...m})=>m);
      return json({ ok:true, merchants: safe });
    }

    // ==== 管理员：添加/续费商家 ====
    if (p==='/api/merchants' && req.method==='POST') {
      const user = await auth();
      if (!user || user.role !== 'admin') return json({ok:false,error:'无权限'}, 403);
      const { phone, password, name, days, action: act } = await req.json();
      const raw = await env.PINDOU_KV.get('merchants') || '[]';
      let merchants = JSON.parse(raw);

      if (act === 'add') {
        if (!phone || !password) return json({ok:false,error:'缺少参数'}, 400);
        if (merchants.find(m => m.phone === phone)) return json({ok:false,error:'手机号已存在'}, 400);
        const now = Date.now();
        merchants.push({
          phone, name: name || '', role: 'merchant',
          password: await sha256(password),
          status: 'active',
          createTime: now,
          expireTime: days ? now + days*86400000 : now + 365*86400000,
        });
      } else if (act === 'renew') {
        const m = merchants.find(m => m.phone === phone);
        if (!m) return json({ok:false,error:'商家不存在'}, 404);
        const d = parseInt(days) || 30;
        m.status = 'active';
        m.expireTime = Math.max(m.expireTime || Date.now(), Date.now()) + d * 86400000;
      } else if (act === 'disable') {
        const m = merchants.find(m => m.phone === phone);
        if (!m) return json({ok:false,error:'商家不存在'}, 404);
        m.status = 'disabled';
      } else if (act === 'delete') {
        merchants = merchants.filter(m => m.phone !== phone);
      }
      await env.PINDOU_KV.put('merchants', JSON.stringify(merchants));
      return json({ ok:true });
    }

    // ==== 商家：我的店铺 ====
    if (p==='/api/shops' && req.method==='GET') {
      const user = await auth();
      if (!user) return json({ok:false,error:'未登录'}, 401);
      const raw = await env.PINDOU_KV.get('shops') || '[]';
      const shops = JSON.parse(raw).filter(s => s.ownerPhone === user.phone);
      return json({ ok:true, shops });
    }

    if (p==='/api/shops' && req.method==='POST') {
      const user = await auth();
      if (!user || user.role !== 'merchant') return json({ok:false,error:'无权限'}, 403);
      const raw = await env.PINDOU_KV.get('shops') || '[]';
      let shops = JSON.parse(raw);
      // 检查是否已有active店铺
      if (shops.find(s => s.ownerPhone === user.phone && s.status === 'active')) {
        return json({ok:false,error:'已有一个店铺，不能重复创建'}, 400);
      }
      const { name } = await req.json();
      const shop = {
        id: crypto.randomUUID().slice(0, 8),
        name: name || '拼豆手工坊',
        ownerPhone: user.phone,
        status: 'active',
        createTime: Date.now(),
      };
      shops.push(shop);
      await env.PINDOU_KV.put('shops', JSON.stringify(shops));
      return json({ ok:true, shop });
    }

    // ==== 店铺详情（公开） ====
    if (p.startsWith('/api/shops/') && req.method==='GET') {
      const shopId = p.split('/')[3];
      const raw = await env.PINDOU_KV.get('shops') || '[]';
      const shop = JSON.parse(raw).find(s => s.id === shopId);
      if (!shop) return json({ok:false,error:'店铺不存在'}, 404);
      return json({ ok:true, shop: { id: shop.id, name: shop.name } });
    }

    // ==== 订单 CRUD（需要 shopId + auth） ====
    if (p==='/api/orders' && req.method==='GET') {
      const shopId = url.searchParams.get('shopId');
      const code = url.searchParams.get('code');
      if (!shopId) return json({ok:false,error:'缺少shopId'}, 400);
      const raw = await env.PINDOU_KV.get('orders') || '[]';
      let orders = JSON.parse(raw).filter(o => o.shopId === shopId);
      if (code) orders = orders.filter(o => o.code === code && o.status === 'active');
      return json({ ok:true, orders });
    }

    if (p==='/api/orders' && req.method==='POST') {
      const user = await auth();
      if (!user) return json({ok:false,error:'未登录'}, 401);
      const { shopId, code, minutes, price, type } = await req.json();
      if (!shopId || !code || !/^\d{4}$/.test(code)) return json({ok:false,error:'参数错误'}, 400);
      const raw = await env.PINDOU_KV.get('orders') || '[]';
      let orders = JSON.parse(raw);
      if (orders.find(o => o.shopId===shopId && o.code===code && o.status==='active')) {
        return json({ok:false,error:'该手机号已有进行中的订单'}, 400);
      }
      const order = {
        id: crypto.randomUUID().slice(0,8),
        shopId, code,
        type: type || 'single',
        price: Number(price) || 0,
        minutes: Number(minutes) || 0,
        startTime: Date.now(),
        status: 'active',
      };
      orders.push(order);
      await env.PINDOU_KV.put('orders', JSON.stringify(orders));
      return json({ ok:true, order });
    }

    if (p==='/api/orders/complete' && req.method==='POST') {
      const user = await auth();
      if (!user) return json({ok:false,error:'未登录'}, 401);
      const { shopId, code } = await req.json();
      const raw = await env.PINDOU_KV.get('orders') || '[]';
      let orders = JSON.parse(raw);
      const idx = orders.findIndex(o => o.shopId===shopId && o.code===code && o.status==='active');
      if (idx === -1) return json({ok:false,error:'订单不存在'}, 404);
      orders[idx].status = 'completed';
      orders[idx].endTime = Date.now();
      await env.PINDOU_KV.put('orders', JSON.stringify(orders));
      return json({ ok:true });
    }

    if (p==='/api/orders/extend' && req.method==='POST') {
      const user = await auth();
      if (!user) return json({ok:false,error:'未登录'}, 401);
      const { shopId, code, minutes, price } = await req.json();
      const raw = await env.PINDOU_KV.get('orders') || '[]';
      let orders = JSON.parse(raw);
      const order = orders.find(o => o.shopId===shopId && o.code===code && o.status==='active');
      if (!order) return json({ok:false,error:'订单不存在'}, 404);
      if (minutes === 0) order.minutes = 0;
      else order.minutes += (Number(minutes) || 0);
      order.price += (Number(price) || 0);
      await env.PINDOU_KV.put('orders', JSON.stringify(orders));
      return json({ ok:true, order });
    }

    if (p==='/api/orders/remove' && req.method==='POST') {
      const user = await auth();
      if (!user) return json({ok:false,error:'未登录'}, 401);
      const { shopId, code } = await req.json();
      const raw = await env.PINDOU_KV.get('orders') || '[]';
      let orders = JSON.parse(raw).filter(o => !(o.shopId===shopId && o.code===code));
      await env.PINDOU_KV.put('orders', JSON.stringify(orders));
      return json({ ok:true });
    }

    if (p==='/api/orders/lookup') {
      const shopId = url.searchParams.get('shopId');
      const code = url.searchParams.get('code');
      if (!shopId || !code) return json({ok:false,error:'缺少参数'}, 400);
      const raw = await env.PINDOU_KV.get('orders') || '[]';
      const order = JSON.parse(raw).find(o => o.shopId===shopId && o.code===code && o.status==='active');
      if (!order) return json({ok:false,error:'订单不存在或已结束'}, 404);
      return json({ ok:true, order });
    }

    return json({ error: 'Not found' }, 404);
  }
};
