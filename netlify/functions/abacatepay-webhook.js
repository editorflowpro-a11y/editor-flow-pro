const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// IDs dos planos AbacatePay
const PLANOS = {
  'bill_Hp5xeTW6FKzHT5PUxEmhDedx': { nome: 'pro',     dias: 30 },
  'bill_eJbLAmhaCqUHqFwUDpFQmtUx': { nome: 'premium', dias: 30 },
};

exports.handler = async (event) => {
  // Só aceita POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Parseia o payload
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'JSON inválido' };
  }

  console.log('AbacatePay webhook recebido:', JSON.stringify(payload, null, 2));

  // Só processa pagamentos confirmados
  const evento = payload.event || payload.type || '';
  if (!evento.includes('paid') && !evento.includes('PAID')) {
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
  const plano = planoInfo ? planoInfo[1].nome : 'pro';
  const dias  = planoInfo ? planoInfo[1].dias  : 30;

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
