export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
  }
  const body = await request.json();
  const raw = await env.PINDOU_KV.get('orders');
  let orders = raw ? JSON.parse(raw) : [];
  orders = orders.filter(o => o.code !== body.code);
  await env.PINDOU_KV.put('orders', JSON.stringify(orders));
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' } });
}
