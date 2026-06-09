// ================================================================
// EDITOR FLOW PRO — Kiwify Webhook (Supabase Edge Function)
// Deploy: supabase functions deploy kiwify-webhook
//
// Secrets necessários (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL     = default (automático no Supabase)
//   SERVICE_ROLE_KEY = sua service_role key
//   KIWIFY_TOKEN     = (segredo do webhook — NÃO commitar aqui)
// ================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SERVICE_ROLE_KEY')!;
const KIWIFY_TOKEN        = Deno.env.get('KIWIFY_TOKEN') ?? '';

// Mapeamento oferta Kiwify → plano
const OFERTAS: Record<string, { plano: string; valor: number }> = {
  'GtL5zML': { plano: 'pro',     valor: 19.90 },
  'ROtVrZr': { plano: 'premium', valor: 29.90 },
};

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  // FAIL-CLOSED: sem segredo configurado, rejeita tudo (não processa pagamento)
  if (!KIWIFY_TOKEN) {
    console.error('KIWIFY_TOKEN não configurado — rejeitando por segurança');
    return new Response('Webhook secret not configured', { status: 503 });
  }
  // Valida token na URL (?token=xxx)
  const url   = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';
  if (token !== KIWIFY_TOKEN) {
    console.warn('Webhook REJEITADO: token inválido');
    return new Response('Unauthorized', { status: 401 });
  }

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return new Response('JSON inválido', { status: 400 });
  }

  console.log('Kiwify webhook recebido');
  console.log('Payload completo:', JSON.stringify(payload));

  // ── Kiwify usa order_status (não event) ──────────────────────
  // Estrutura real: { order_status, Customer: { email }, product: { offer_id } }
  const orderStatus        = (payload.order_status ?? '').toLowerCase();
  const subscriptionStatus = (payload.subscription_status ?? payload.Subscription?.status ?? '').toLowerCase();

  console.log(`order_status: "${orderStatus}" | subscription_status: "${subscriptionStatus}"`);

  // Determina ação
  const ehAtivar = orderStatus === 'paid' ||
                   subscriptionStatus === 'active';

  const ehCancelar = ['refunded', 'chargedback', 'cancelled', 'canceled', 'overdue']
                       .includes(orderStatus) ||
                     ['cancelled', 'canceled', 'overdue']
                       .includes(subscriptionStatus);

  if (!ehAtivar && !ehCancelar) {
    console.log(`Evento ignorado — order_status: "${orderStatus}"`);
    return new Response('Evento ignorado', { status: 200 });
  }

  // ── Extrai email ─────────────────────────────────────────────
  // Kiwify usa "Customer" com C maiúsculo
  const customer = payload.Customer ?? payload.customer ?? {};
  const email = (
    customer.email ??
    payload.email  ??
    ''
  ).toLowerCase().trim();

  if (!email) {
    console.error('Email não encontrado. Campos disponíveis:', Object.keys(payload).join(', '));
    return new Response('Email não encontrado', { status: 400 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── CANCELAMENTO ─────────────────────────────────────────────
  if (ehCancelar) {
    const { error } = await sb
      .from('assinantes')
      .update({ status: 'cancelado', atualizado_em: new Date().toISOString() })
      .eq('email', email);

    if (error) {
      console.error('Erro ao cancelar:', error);
      return new Response('Erro Supabase', { status: 500 });
    }
    console.log(`❌ Assinatura cancelada: ${email}`);
    return new Response('OK', { status: 200 });
  }

  // ── ATIVAÇÃO ─────────────────────────────────────────────────
  // Kiwify pode usar Product (maiúsculo) ou product (minúsculo)
  const product  = payload.Product ?? payload.product ?? {};

  // Tenta encontrar o offer_id em todos os campos possíveis
  const ofertaId = (
    product.offer_id    ??   // compra real
    product.id          ??   // alternativa
    product.Offer?.id   ??
    payload.offer_id    ??
    ''
  );

  console.log(`offer_id encontrado: "${ofertaId}" | product keys: ${Object.keys(product).join(', ')}`);

  // Fallback por valor caso offer_id não venha
  const valorPago = Number(
    product.price         ??
    payload.order_value   ??
    payload.amount        ??
    payload.total_value   ??
    0
  );
  const valorReal = valorPago > 200 ? valorPago / 100 : valorPago; // centavos → reais

  let planoInfo = OFERTAS[ofertaId];
  if (!planoInfo) {
    planoInfo = valorReal >= 24
      ? { plano: 'premium', valor: 29.90 }
      : { plano: 'pro',     valor: 19.90 };
    console.warn(`offer_id "${ofertaId}" não reconhecido | valor R$${valorReal} → fallback: ${planoInfo.plano}`);
  }

  const fimPeriodo = new Date();
  fimPeriodo.setDate(fimPeriodo.getDate() + 30);

  // ── Cupom de parceiro (atribuição) ───────────────────────────
  // Kiwify pode mandar o cupom em vários campos — tenta todos.
  const cupom = (
    payload.Coupon?.code   ??
    payload.coupon?.code   ??
    payload.Coupon         ??
    payload.coupon         ??
    payload.coupon_code    ??
    payload.order?.coupon_code ??
    payload.Commissions?.coupon ??
    ''
  ).toString().toUpperCase().trim() || null;
  if (cupom) console.log(`cupom usado: ${cupom}`);

  const rec: Record<string, unknown> = {
    email:         email,
    status:        'ativo',
    plano:         planoInfo.plano,
    valor:         planoInfo.valor,
    fim_periodo:   fimPeriodo.toISOString(),
    atualizado_em: new Date().toISOString(),
  };
  // só grava o cupom quando vier um (não apaga atribuição em renovação sem cupom)
  if (cupom) rec.parceiro_cupom = cupom;

  let { error } = await sb.from('assinantes').upsert(rec, { onConflict: 'email' });
  // fail-safe: se a coluna parceiro_cupom ainda não existir, salva sem ela (cobrança não quebra)
  if (error && /parceiro_cupom|column/i.test(error.message ?? '') && rec.parceiro_cupom) {
    delete rec.parceiro_cupom;
    ({ error } = await sb.from('assinantes').upsert(rec, { onConflict: 'email' }));
  }

  if (error) {
    console.error('Erro Supabase:', error);
    return new Response('Erro ao salvar no banco', { status: 500 });
  }

  console.log(`✅ Assinante ativado: ${email} | Plano: ${planoInfo.plano} | offer_id: ${ofertaId} | cupom: ${cupom ?? '—'} | Até: ${fimPeriodo.toLocaleDateString('pt-BR')}`);
  return new Response('OK', { status: 200 });
});
