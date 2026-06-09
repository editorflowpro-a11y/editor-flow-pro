const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET      = process.env.WEBHOOK_SECRET; // defina no Netlify + no AbacatePay

// IDs dos planos AbacatePay
const PLANOS = {
  'bill_Hp5xeTW6FKzHT5PUxEmhDedx': { nome: 'pro',     dias: 30, valor: 19.90 },
  'bill_jLyPYFUQrWBYZCcDFgdwzqSG': { nome: 'premium', dias: 30, valor: 29.90 }, // Premium R$29,90
  'bill_eJbLAmhaCqUHqFwUDpFQmtUx': { nome: 'premium', dias: 30, valor: 39.90 }, // legado (preço antigo)
};

exports.handler = async (event) => {
  // Só aceita POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // ── VERIFICAÇÃO DE ASSINATURA (FAIL-CLOSED) ────────────────────
  // Sem segredo configurado, rejeita tudo — nunca processa pagamento.
  if (!WEBHOOK_SECRET) {
    console.error('WEBHOOK_SECRET não configurado — rejeitando por segurança');
    return { statusCode: 503, body: 'Webhook secret not configured' };
  }
  const h = event.headers;
  const received =
    h['x-webhook-secret'] ||
    h['x-abacate-secret']  ||
    h['x-abacatepay-secret'];
  if (!received || received !== WEBHOOK_SECRET) {
    console.warn('Webhook REJEITADO: secret inválido ou ausente');
    return { statusCode: 401, body: 'Unauthorized' };
  }

  // Parseia o payload
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'JSON inválido' };
  }

  // Log sem dados sensíveis
  console.log('AbacatePay webhook recebido — event:', payload?.event || payload?.type);

  // Só processa pagamentos confirmados
  const evento = payload.event || payload.type || '';
  const eventosValidos = ['paid', 'PAID', 'subscription.completed', 'checkout.completed', 'transparent.completed'];
  if (!eventosValidos.some(e => evento.includes(e))) {
    return { statusCode: 200, body: 'Evento ignorado: ' + evento };
  }

  // Extrai dados do pagamento (AbacatePay pode enviar em diferentes estruturas)
  const billing = payload.data?.billing || payload.billing || payload.data || payload;
  const customer = billing?.customer || billing?.metadata?.customer || {};
  const email = customer?.email || billing?.email || payload?.email;
  const billingId = billing?.id || billing?.productId || '';

  if (!email) {
    console.error('Email não encontrado no payload:', JSON.stringify(payload));
    return { statusCode: 400, body: 'Email não encontrado no payload' };
  }

  // Determina o plano pelo ID da cobrança
  const planoInfo = Object.entries(PLANOS).find(([id]) =>
    billingId.includes(id) || billing?.metadata?.planId === id
  );
  const plano = planoInfo ? planoInfo[1].nome  : 'pro';
  const dias  = planoInfo ? planoInfo[1].dias  : 30;
  const valor = planoInfo ? planoInfo[1].valor : 19.90;

  // Calcula fim do período
  const fimPeriodo = new Date();
  fimPeriodo.setDate(fimPeriodo.getDate() + dias);

  // Atualiza (ou cria) assinante no Supabase
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { error } = await sb
    .from('assinantes')
    .upsert(
      {
        email:       email.toLowerCase().trim(),
        status:      'ativo',
        plano:       plano,
        valor:       valor,
        fim_periodo: fimPeriodo.toISOString(),
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: 'email' }
    );

  if (error) {
    console.error('Erro Supabase:', error);
    return { statusCode: 500, body: 'Erro ao salvar no banco' };
  }

  console.log(`✅ Assinante ativado: ${email} | Plano: ${plano} | Até: ${fimPeriodo.toLocaleDateString('pt-BR')}`);
  return { statusCode: 200, body: 'OK' };
};
