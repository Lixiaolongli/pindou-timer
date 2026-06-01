export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  const body = await request.json();
  const raw = await env.PINDOU_KV.get('orders');
  let orders = raw ? JSON.parse(raw) : [];
  const idx = orders.findIndex(o => o.code === body.code && o.status === 'active');
  if (idx === -1) {
    return new Response(JSON.stringify({ error: '订单不存在或已结束' }), { status: 404, headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });
  }
  // 续时：增加分钟数，价格累加，startTime 保持不变
  const extraMinutes = body.minutes || 30;
  const extraPrice = body.price || 0;
  orders[idx].minutes += extraMinutes;
  orders[idx].price += extraPrice;
  await env.PINDOU_KV.put('orders', JSON.stringify(orders));
  return new Response(JSON.stringify(orders[idx]), { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });
}
